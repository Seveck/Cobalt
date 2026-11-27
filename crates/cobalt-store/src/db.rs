use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use cobalt_core::SCHEMA_VERSION;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{MAIN_BRANCH_ID, MAIN_BRANCH_NAME, now, timestamp_to_sql};
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use tokio::sync::Semaphore;

const READERS: usize = 4;

#[derive(Clone)]
pub(crate) struct Database(Arc<Connections>);

struct Connections {
    writer: Mutex<Connection>,
    maintenance: Arc<tokio::sync::RwLock<()>>,
    queued: AtomicUsize,
    write_slot: Arc<Semaphore>,
    readers: Mutex<Vec<Connection>>,
    read_slots: Arc<Semaphore>,
    index_io: RwLock<()>,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| CobaltError::Internal("store lock poisoned".into()))
}

pub(crate) fn sql_error(error: rusqlite::Error) -> CobaltError {
    if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
        return match error {
            rusqlite::Error::SqliteFailure(failure, _)
                if matches!(
                    failure.extended_code,
                    rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                        | rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
                ) =>
            {
                CobaltError::Conflict(error.to_string())
            }
            _ => CobaltError::InvalidInput(error.to_string()),
        };
    }
    CobaltError::Storage(error.to_string())
}

pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| CobaltError::Internal(err.to_string()))?
}

impl Database {
    pub(crate) async fn open(path: PathBuf) -> Result<Self> {
        blocking(move || {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent)?;
            }
            crate::vector::register_sqlite_vec()?;
            let mut writer = Connection::open(&path).map_err(sql_error)?;
            configure(&writer).map_err(sql_error)?;
            migrate(&mut writer)?;
            let readers = (0..READERS)
                .map(|_| {
                    let conn =
                        Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                    configure(&conn)?;
                    Ok(conn)
                })
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_error)?;
            Ok(Self(Arc::new(Connections {
                writer: Mutex::new(writer),
                maintenance: Arc::default(),
                queued: AtomicUsize::new(0),
                write_slot: Arc::new(Semaphore::new(1)),
                readers: Mutex::new(readers),
                read_slots: Arc::new(Semaphore::new(READERS)),
                index_io: RwLock::new(()),
            })))
        })
        .await
    }

    pub(crate) fn index_io(&self) -> &RwLock<()> {
        &self.0.index_io
    }

    pub(crate) async fn read<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let db = self.0.clone();
        let permit = db
            .read_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(closed)?;
        blocking(move || {
            let conn = lock(&db.readers)?
                .pop()
                .ok_or_else(|| CobaltError::Internal("read pool exhausted".into()))?;
            let reader = Reader {
                conn: Some(conn),
                pool: &db.readers,
            };
            let conn = reader
                .conn
                .as_ref()
                .ok_or_else(|| CobaltError::Internal("missing read connection".into()))?;
            let result = work(conn);
            drop(reader);
            drop(permit);
            result
        })
        .await
    }

    pub(crate) async fn maintenance(&self) -> tokio::sync::OwnedRwLockWriteGuard<()> {
        self.0.maintenance.clone().write_owned().await
    }

    pub(crate) fn queued_writes(&self) -> u64 {
        self.0.queued.load(Ordering::Relaxed) as u64
    }

    pub(crate) async fn write<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let pending = PendingWrite::new(&self.0.queued);
        let gate = self.0.maintenance.clone().read_owned().await;
        drop(pending);
        self.write_exclusive(move |conn| {
            let _gate = gate;
            work(conn)
        })
        .await
    }

    pub(crate) async fn write_exclusive<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let db = self.0.clone();
        let permit = db
            .write_slot
            .clone()
            .acquire_owned()
            .await
            .map_err(closed)?;
        blocking(move || {
            let _permit = permit;
            let mut writer = lock(&db.writer)?;
            work(&mut writer)
        })
        .await
    }
}

pub(crate) struct PendingWrite<'a>(&'a AtomicUsize);

impl<'a> PendingWrite<'a> {
    pub(crate) fn new(count: &'a AtomicUsize) -> Self {
        count.fetch_add(1, Ordering::Relaxed);
        Self(count)
    }
}

impl Drop for PendingWrite<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

struct Reader<'a> {
    conn: Option<Connection>,
    pool: &'a Mutex<Vec<Connection>>,
}

impl Drop for Reader<'_> {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            self.pool
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(conn);
        }
    }
}

fn closed(err: tokio::sync::AcquireError) -> CobaltError {
    CobaltError::Internal(err.to_string())
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA busy_timeout = 5000;
         PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;",
    )?;
    let mode: String = conn.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    let version: u32 = tx
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(sql_error)?;
    match version {
        0 => {
            tx.execute_batch(include_str!("schema.sql"))
                .map_err(sql_error)?;
            tx.execute(
                "INSERT INTO branches (id, name, created_at, is_active) VALUES (?1, ?2, ?3, 1)",
                params![
                    MAIN_BRANCH_ID.to_string(),
                    MAIN_BRANCH_NAME,
                    timestamp_to_sql(&now())
                ],
            )
            .map_err(sql_error)?;
        }
        1 | SCHEMA_VERSION => {}
        _ => {
            return Err(CobaltError::Integrity(format!(
                "SQLite schema version {version} is incompatible with version {SCHEMA_VERSION}"
            )));
        }
    }
    if version < 2 {
        tx.execute_batch(include_str!("usage_hourly.sql"))
            .map_err(sql_error)?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(sql_error)?;
    }
    tx.commit().map_err(sql_error)
}

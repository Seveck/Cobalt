use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use cobalt_core::enums::EngineKind;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, new_id, now, timestamp_from_sql, timestamp_to_sql};
use cobalt_core::model::Snapshot;
use cobalt_core::traits::SnapshotRepository;
use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, params};

use crate::db::{blocking, migrate, sql_error};
use crate::migration::{StagedIndex, indexed_texts, prepare_vectors, save_engine_settings};
use crate::repositories::{id, load_settings, timestamp};
use crate::vector::Index;
use crate::{Retrieval, SCHEMA_VERSION, SqliteStore, SqliteVec};

fn snapshot(row: &Row<'_>) -> rusqlite::Result<Snapshot> {
    Ok(Snapshot {
        id: id(row, "id")?,
        label: row.get("label")?,
        created_at: timestamp(row, "created_at")?,
        memory_count: row.get("memory_count")?,
        file_path: row.get("file_path")?,
    })
}

fn list(conn: &Connection) -> Result<Vec<Snapshot>> {
    let mut stmt = conn
        .prepare("SELECT * FROM snapshots ORDER BY created_at DESC, id DESC")
        .map_err(sql_error)?;
    stmt.query_map([], snapshot)
        .map_err(sql_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(sql_error)
}

fn by_id(conn: &Connection, id: Id) -> Result<Snapshot> {
    conn.query_row(
        "SELECT * FROM snapshots WHERE id = ?1",
        [id.to_string()],
        snapshot,
    )
    .optional()
    .map_err(sql_error)?
    .ok_or_else(|| CobaltError::NotFound(format!("snapshot {id}")))
}

fn backup(from: &Connection, to: &mut Connection) -> Result<()> {
    let backup = Backup::new(from, to).map_err(sql_error)?;
    let mut retries = 0;
    loop {
        match backup.step(256).map_err(sql_error)? {
            StepResult::Done => return Ok(()),
            StepResult::More => retries = 0,
            StepResult::Busy | StepResult::Locked if retries < 100 => {
                retries += 1;
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                return Err(CobaltError::Storage(
                    "SQLite backup could not acquire the database".into(),
                ));
            }
        }
    }
}

fn insert(conn: &Connection, snapshot: &Snapshot) -> Result<()> {
    conn.execute(
        "INSERT INTO snapshots (id, label, created_at, memory_count, file_path)
                  VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            snapshot.id.to_string(),
            snapshot.label,
            timestamp_to_sql(&snapshot.created_at),
            snapshot.memory_count,
            snapshot.file_path,
        ],
    )
    .map_err(sql_error)?;
    Ok(())
}

fn create(
    conn: &Connection,
    directory: &Path,
    label: String,
    retrieval: Option<&Retrieval>,
) -> Result<Snapshot> {
    std::fs::create_dir_all(directory)?;
    let id = new_id();
    let file = directory.join(format!("{id}.db"));
    let snapshot = Snapshot {
        id,
        label,
        created_at: timestamp_from_sql(&timestamp_to_sql(&now()))?,
        memory_count: conn
            .query_row("SELECT count(*) FROM memories", [], |row| row.get(0))
            .map_err(sql_error)?,
        file_path: file
            .to_str()
            .ok_or_else(|| CobaltError::InvalidInput("snapshot path is not UTF-8".into()))?
            .into(),
    };
    let temporary = tempfile::NamedTempFile::new_in(directory)?;
    {
        let mut destination = Connection::open(temporary.path()).map_err(sql_error)?;
        backup(conn, &mut destination)?;
        if let Some(retrieval) = retrieval {
            save_engine_settings(&destination, retrieval)?;
            if retrieval.index.kind() == EngineKind::Usearch {
                destination
                    .execute("DROP TABLE IF EXISTS vec_memories", [])
                    .map_err(sql_error)?;
            }
        }
        destination
            .pragma_update(None, "journal_mode", "DELETE")
            .map_err(sql_error)?;
    }
    temporary.as_file().sync_all()?;
    // Keep ownership of the temporary path until the catalog insert succeeds.
    let installed = temporary.into_temp_path();
    installed
        .persist_noclobber(&file)
        .map_err(|err| err.error)?;
    if let Err(error) = insert(conn, &snapshot) {
        std::fs::remove_file(file)?;
        return Err(error);
    }
    Ok(snapshot)
}

struct Restore {
    target: Snapshot,
    staged_db: Connection,
    rows: Vec<(Id, String)>,
    use_saved_vectors: bool,
}

fn stage_restore(
    conn: &Connection,
    directory: PathBuf,
    requested: Id,
    retrieval: Option<&Retrieval>,
) -> Result<Restore> {
    let target = by_id(conn, requested)?;
    let source = Connection::open_with_flags(&target.file_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(sql_error)?;
    let version: u32 = source
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(sql_error)?;
    let check: String = source
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .map_err(sql_error)?;
    if !matches!(version, 1 | SCHEMA_VERSION) || check != "ok" {
        return Err(CobaltError::Integrity(
            "snapshot database failed schema or integrity check".into(),
        ));
    }
    let mut staged_db = Connection::open_in_memory().map_err(sql_error)?;
    backup(&source, &mut staged_db)?;
    migrate(&mut staged_db)?;
    let settings = load_settings(&staged_db)?;
    let current = load_settings(conn)?;
    if retrieval.is_none()
        && (settings.vector_engine != current.vector_engine
            || settings.embedding_model_id != current.embedding_model_id
            || settings.vector_engine == EngineKind::Usearch)
    {
        return Err(CobaltError::Engine(
            "configure retrieval before restoring this snapshot".into(),
        ));
    }
    create(
        conn,
        &directory,
        format!("Safety snapshot before restoring {}", target.label),
        retrieval,
    )?;
    staged_db
        .execute("DELETE FROM snapshots", [])
        .map_err(sql_error)?;
    for snapshot in list(conn)? {
        insert(&staged_db, &snapshot)?;
    }
    let rows = if retrieval.is_some() {
        indexed_texts(&staged_db)?
    } else {
        Vec::new()
    };
    let sqlite_index_exists: bool = staged_db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'vec_memories')",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    let use_saved_vectors = sqlite_index_exists
        && settings.vector_engine == EngineKind::SqliteVec
        && retrieval
            .is_some_and(|retrieval| retrieval.embedder.spec().id == settings.embedding_model_id);
    Ok(Restore {
        target,
        staged_db,
        rows,
        use_saved_vectors,
    })
}

#[async_trait]
impl SnapshotRepository for SqliteStore {
    async fn list_snapshots(&self) -> Result<Vec<Snapshot>> {
        self.db.read(list).await
    }

    async fn create_snapshot(&self, label: &str) -> Result<Snapshot> {
        if label.trim().is_empty() {
            return Err(CobaltError::InvalidInput("snapshot label is empty".into()));
        }
        let label = label.to_owned();
        let directory = self.data_path(cobalt_core::paths::SNAPSHOTS_DIR);
        let gate = self.engine_gate.clone().read_owned().await;
        let retrieval = self.configured_retrieval()?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                create(conn, &directory, label, retrieval.as_deref())
            })
            .await
    }

    async fn restore_snapshot(&self, id: Id) -> Result<Snapshot> {
        let store = self.clone();
        tokio::spawn(async move {
            let _gate = store.engine_gate.clone().write_owned().await;
            let _maintenance = store.db.maintenance().await;
            let directory = store.data_path(cobalt_core::paths::SNAPSHOTS_DIR);
            let retrieval = store.configured_retrieval()?;
            let snapshot_retrieval = retrieval.clone();
            let Restore {
                target,
                staged_db,
                rows,
                use_saved_vectors,
            } = store
                .db
                .write_exclusive(move |conn| {
                    stage_restore(conn, directory, id, snapshot_retrieval.as_deref())
                })
                .await?;
            if let Some(retrieval) = retrieval {
                let dims = retrieval.index.dimensions();
                let (staged_db, rows, saved) = if use_saved_vectors {
                    let index = Index::from(SqliteVec::handle(&store, dims));
                    blocking(move || {
                        let ids = rows.iter().map(|(id, _)| *id).collect::<Vec<_>>();
                        let mut saved = index.vectors(&staged_db, &ids)?;
                        for vector in &mut saved {
                            if vector.as_ref().is_some_and(|vector| vector.len() != dims) {
                                *vector = None;
                            }
                        }
                        Ok((staged_db, rows, saved))
                    })
                    .await?
                } else {
                    let saved = vec![None; rows.len()];
                    (staged_db, rows, saved)
                };
                let (vectors, _) =
                    prepare_vectors(retrieval.embedder.as_ref(), rows, saved, |_| {}).await?;
                let probe = vectors.first().map_or_else(
                    || {
                        let mut probe = vec![0.0; dims];
                        if let Some(first) = probe.first_mut() {
                            *first = 1.0;
                        }
                        probe
                    },
                    |(_, vector)| vector.clone(),
                );
                let (stage, staged_db, retrieval) = blocking(move || {
                    let stage =
                        StagedIndex::new(retrieval.index.clone(), &vectors, &probe, &staged_db)?;
                    stage.populate(&staged_db, &retrieval, &vectors, &probe)?;
                    let retrieval = stage.installed_retrieval((*retrieval).clone());
                    save_engine_settings(&staged_db, &retrieval)?;
                    Ok((stage, staged_db, retrieval))
                })
                .await?;
                let restored_store = store.clone();
                store
                    .db
                    .write_exclusive(move |conn| {
                        let mut state = restored_store
                            .retrieval
                            .write()
                            .map_err(|_| CobaltError::Internal("retrieval lock poisoned".into()))?;
                        stage.commit(|| backup(&staged_db, conn))?;
                        *state = Some(std::sync::Arc::new(retrieval));
                        Ok(())
                    })
                    .await?;
            } else {
                store
                    .db
                    .write_exclusive(move |conn| backup(&staged_db, conn))
                    .await?;
            }
            Ok(target)
        })
        .await
        .map_err(|err| CobaltError::Internal(err.to_string()))?
    }

    async fn delete_snapshot(&self, id: Id) -> Result<()> {
        self.db
            .write(move |conn| {
                let target = by_id(conn, id)?;
                let path = Path::new(&target.file_path);
                let parent = path
                    .parent()
                    .ok_or_else(|| CobaltError::Integrity("snapshot path has no parent".into()))?;
                let trash = tempfile::tempdir_in(parent)?;
                let moved = trash.path().join("snapshot.db");
                let exists = match std::fs::rename(path, &moved) {
                    Ok(()) => true,
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
                    Err(err) => return Err(err.into()),
                };
                if let Err(error) = conn
                    .execute("DELETE FROM snapshots WHERE id = ?1", [id.to_string()])
                    .map_err(sql_error)
                {
                    if exists {
                        std::fs::rename(moved, path)?;
                    }
                    return Err(error);
                }
                Ok(())
            })
            .await
    }
}

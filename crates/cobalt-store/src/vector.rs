use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use cobalt_core::enums::EngineKind;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::Id;
use cobalt_core::paths::VECTOR_INDEX_DIR;
use cobalt_core::search::{ProjectScope, SearchFilter, VectorFilter, VectorHit, VectorRecord};
use cobalt_core::traits::VectorStore;
use rusqlite::{Connection, OptionalExtension, ffi, params, params_from_iter, types::Value};
use usearch::{IndexOptions, MetricKind, ScalarKind};

use crate::SqliteStore;
use crate::db::{Database, sql_error};
use crate::repositories::{branch, id};

pub(crate) fn register_sqlite_vec() -> Result<()> {
    static REGISTRATION: OnceLock<i32> = OnceLock::new();
    let code = REGISTRATION.get_or_init(|| {
        // SQLite accepts the typed extension callback cast to its erased C callback signature.
        // sqlite-vec is statically linked and SQLite invokes it with the matching three arguments.
        unsafe {
            ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
                unsafe extern "C" fn(),
                unsafe extern "C" fn(
                    *mut ffi::sqlite3,
                    *mut *mut std::ffi::c_char,
                    *const ffi::sqlite3_api_routines,
                ) -> std::ffi::c_int,
            >(sqlite_vec::sqlite3_vec_init)))
        }
    });
    if *code == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(CobaltError::Engine(format!(
            "sqlite-vec registration failed ({code})"
        )))
    }
}

/// Restricts both retrieval channels using the current canonical memory metadata.
pub(crate) struct Scope {
    pub(crate) clause: String,
    pub(crate) params: Vec<Value>,
}

impl Scope {
    pub(crate) fn new(branch_id: Id, vector: &VectorFilter, extra: &SearchFilter) -> Self {
        let mut this = Self {
            clause: "m.branch_id = ? AND m.is_encrypted = 0".into(),
            params: vec![branch_id.to_string().into()],
        };
        if !vector.include_archived {
            this.clause.push_str(" AND m.status = 'active'");
        } else {
            this.clause
                .push_str(" AND m.status IN ('active', 'archived')");
        }
        match vector.scope {
            ProjectScope::All => {}
            ProjectScope::Global => this.clause.push_str(" AND m.project_id IS NULL"),
            ProjectScope::Project(id) => this.and("m.project_id = ?", id.to_string()),
            ProjectScope::ProjectAndGlobal(id) => {
                this.and("(m.project_id = ? OR m.project_id IS NULL)", id.to_string())
            }
            ProjectScope::AllExcept(id) => this.and(
                "(m.project_id IS NULL OR m.project_id <> ?)",
                id.to_string(),
            ),
        }
        if vector.only_reusable || extra.only_reusable {
            this.clause.push_str(" AND m.is_reusable = 1");
        }
        if let Some(minimum) = extra.min_confidence {
            this.and("m.confidence >= ?", minimum);
        }
        this.enum_filter(
            "m.source_type",
            extra.source_types.iter().map(|v| v.as_str()),
        );
        this.enum_filter("m.category", extra.categories.iter().map(|v| v.as_str()));
        this
    }

    fn and(&mut self, clause: &str, value: impl Into<Value>) {
        self.clause.push_str(" AND ");
        self.clause.push_str(clause);
        self.params.push(value.into());
    }

    fn enum_filter(&mut self, column: &str, values: impl Iterator<Item = &'static str>) {
        let values: Vec<_> = values.collect();
        if !values.is_empty() {
            self.and(
                &format!("{column} IN (SELECT value FROM json_each(?))"),
                serde_json::json!(values).to_string(),
            );
        }
    }
}

pub(crate) fn checked_vector(vector: &[f32], dimensions: usize) -> Result<()> {
    if vector.len() != dimensions
        || !vector.iter().all(|v| v.is_finite())
        || vector.iter().all(|v| *v == 0.0)
    {
        return Err(CobaltError::InvalidInput(format!(
            "expected a finite non-zero vector with {dimensions} dimensions"
        )));
    }
    Ok(())
}

pub(crate) fn vector_bytes(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_ne_bytes()).collect()
}

fn check_dimensions(dimensions: usize) -> Result<()> {
    if dimensions == 0 {
        return Err(CobaltError::InvalidInput(
            "vector dimension must be positive".into(),
        ));
    }
    Ok(())
}

fn validate_target(conn: &Connection, id: Id) -> Result<()> {
    let allowed: Option<bool> = conn
        .query_row(
            "SELECT is_encrypted = 0 FROM memories WHERE id = ?1",
            [id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    match allowed {
        Some(true) => Ok(()),
        Some(false) => Err(CobaltError::InvalidInput(format!(
            "memory {id} is encrypted"
        ))),
        None => Err(CobaltError::NotFound(format!("memory {id}"))),
    }
}

/// SQLite vector storage. Filter metadata comes from the existing canonical memory rows.
#[derive(Clone)]
pub struct SqliteVec {
    db: Database,
    dimensions: usize,
}

impl SqliteVec {
    pub async fn open(store: &SqliteStore, dimensions: usize) -> Result<Self> {
        check_dimensions(dimensions)?;
        store.db.write(move |conn| {
            conn.execute_batch(&format!(
                "CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
                     memory_id TEXT PRIMARY KEY, embedding float[{dimensions}] distance_metric=cosine
                 );"
            )).map_err(sql_error)?;
            let sql: String = conn.query_row(
                "SELECT sql FROM sqlite_schema WHERE name = 'vec_memories'", [], |row| row.get(0),
            ).map_err(sql_error)?;
            let canonical = sql.split_whitespace().collect::<String>().to_ascii_lowercase();
            if !canonical.contains(&format!("embeddingfloat[{dimensions}]distance_metric=cosine")) {
                return Err(CobaltError::Engine("vec_memories has a different schema or dimension".into()));
            }
            Ok(())
        }).await?;
        Ok(Self {
            db: store.db.clone(),
            dimensions,
        })
    }

    pub(crate) fn handle(store: &SqliteStore, dimensions: usize) -> Self {
        Self {
            db: store.db.clone(),
            dimensions,
        }
    }

    pub(crate) fn recreate(conn: &Connection, dimensions: usize) -> Result<()> {
        check_dimensions(dimensions)?;
        conn.execute_batch(&format!(
            "DROP TABLE IF EXISTS vec_memories;
             CREATE VIRTUAL TABLE vec_memories USING vec0(
                memory_id TEXT PRIMARY KEY, embedding float[{dimensions}] distance_metric=cosine
             );"
        ))
        .map_err(sql_error)
    }

    pub(crate) fn replace(conn: &Connection, id: Id, embedding: &[f32]) -> Result<()> {
        Self::remove(conn, id)?;
        conn.execute(
            "INSERT INTO vec_memories (memory_id, embedding) VALUES (?1, ?2)",
            params![id.to_string(), vector_bytes(embedding)],
        )
        .map_err(sql_error)?;
        Ok(())
    }

    pub(crate) fn remove(conn: &Connection, id: Id) -> Result<()> {
        conn.execute(
            "DELETE FROM vec_memories WHERE memory_id = ?1",
            [id.to_string()],
        )
        .map_err(sql_error)?;
        Ok(())
    }

    fn scoped(
        conn: &Connection,
        query: &[f32],
        top_k: usize,
        scope: Scope,
    ) -> Result<Vec<VectorHit>> {
        let sql = format!(
            "SELECT m.id, vec_distance_cosine(v.embedding, ?) AS distance
             FROM memories m JOIN vec_memories v ON v.memory_id = m.id
             WHERE {} ORDER BY distance, m.id LIMIT ?",
            scope.clause
        );
        let mut statement = conn.prepare(&sql).map_err(sql_error)?;
        let args = [Value::Blob(vector_bytes(query))]
            .into_iter()
            .chain(scope.params)
            .chain([Value::Integer(i64::try_from(top_k).unwrap_or(i64::MAX))]);
        statement
            .query_map(params_from_iter(args), |row| {
                Ok(VectorHit {
                    memory_id: id(row, "id")?,
                    similarity: (1.0_f32 - row.get::<_, f32>("distance")?).clamp(0.0, 1.0),
                })
            })
            .map_err(sql_error)?
            .collect::<rusqlite::Result<_>>()
            .map_err(sql_error)
    }

    fn probe(conn: &Connection) -> Result<()> {
        conn.query_row("SELECT count(*) FROM vec_memories", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(sql_error)?;
        Ok(())
    }
}

/// USearch index backed by atomic on-disk snapshots, memory mapped for queries.
/// Canonical memory rows supply UUIDs and filter metadata.
#[derive(Clone)]
pub struct Usearch {
    db: Database,
    file: PathBuf,
    dimensions: usize,
    working: Option<Arc<usearch::Index>>,
}

impl Usearch {
    pub async fn open(store: &SqliteStore, model: &str, dimensions: usize) -> Result<Self> {
        Self::open_in(store, store.data_path(VECTOR_INDEX_DIR), model, dimensions).await
    }

    pub async fn open_in(
        store: &SqliteStore,
        directory: PathBuf,
        model: &str,
        dimensions: usize,
    ) -> Result<Self> {
        let this = Self::handle(store, directory, model, dimensions)?;
        let index = this.clone();
        store
            .db
            .write(move |_| {
                let _lock = index.db.index_io().write().map_err(engine_error)?;
                if index.file.try_exists()? {
                    index.open_index(true)?;
                } else {
                    if let Some(parent) = index.file.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    index.publish(&index.new_index()?)?;
                }
                Ok(())
            })
            .await?;
        Ok(this)
    }

    pub(crate) fn handle(
        store: &SqliteStore,
        directory: PathBuf,
        model: &str,
        dimensions: usize,
    ) -> Result<Self> {
        check_dimensions(dimensions)?;
        if model.is_empty() {
            return Err(CobaltError::InvalidInput("index model id is empty".into()));
        }
        let key = model
            .bytes()
            .map(|byte| {
                if byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
                {
                    char::from(byte).to_string()
                } else {
                    format!("%{byte:02x}")
                }
            })
            .collect::<String>();
        Ok(Self {
            db: store.db.clone(),
            file: directory
                .join(format!("usearch-{key}"))
                .join("index.usearch"),
            dimensions,
            working: None,
        })
    }

    pub(crate) fn index_io(&self) -> &std::sync::RwLock<()> {
        self.db.index_io()
    }

    pub(crate) fn file(&self) -> &Path {
        &self.file
    }

    pub(crate) fn with_file(&self, file: PathBuf) -> Self {
        Self {
            file,
            ..self.clone()
        }
    }

    pub(crate) fn stage_edit(&self, file: PathBuf) -> Result<Self> {
        let index = self.open_index(false)?;
        Ok(Self {
            working: Some(index),
            ..self.with_file(file)
        })
    }

    pub(crate) fn publish_edit(&self) -> Result<()> {
        self.publish(
            self.working
                .as_deref()
                .ok_or_else(|| engine_error("missing staged USearch index"))?,
        )
    }

    pub(crate) fn new_index(&self) -> Result<usearch::Index> {
        usearch::Index::new(&IndexOptions {
            dimensions: self.dimensions,
            metric: MetricKind::Cos,
            quantization: ScalarKind::F32,
            ..IndexOptions::default()
        })
        .map_err(engine_error)
    }

    fn open_index(&self, mmap: bool) -> Result<Arc<usearch::Index>> {
        if let Some(index) = &self.working {
            return Ok(index.clone());
        }
        let index = self.new_index()?;
        let path = index_path(&self.file)?;
        if mmap {
            index.view(path).map_err(engine_error)?;
        } else {
            index.load(path).map_err(engine_error)?;
        }
        if index.dimensions() != self.dimensions
            || index.metric_kind() != MetricKind::Cos
            || index.scalar_kind() != ScalarKind::F32
            || index.multi()
        {
            return Err(CobaltError::Engine(
                "USearch index options do not match".into(),
            ));
        }
        Ok(Arc::new(index))
    }

    pub(crate) fn publish(&self, index: &usearch::Index) -> Result<()> {
        let parent = self
            .file
            .parent()
            .ok_or_else(|| CobaltError::Internal("USearch index path has no parent".into()))?;
        let temp = tempfile::NamedTempFile::new_in(parent)?;
        index.save(index_path(temp.path())?).map_err(engine_error)?;
        temp.as_file().sync_all()?;
        temp.persist(&self.file).map_err(|err| err.error)?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    }

    fn edit(&self, conn: &Connection, put: &[(Id, &[f32])], remove: &[Id]) -> Result<()> {
        if put.is_empty() && remove.is_empty() {
            return Ok(());
        }
        let _lock = self.db.index_io().write().map_err(engine_error)?;
        let index = self.open_index(false)?;
        let touched: HashMap<_, _> = put
            .iter()
            .map(|(id, _)| (index_key(*id), *id))
            .chain(remove.iter().map(|id| (index_key(*id), *id)))
            .collect();
        let mut stmt = conn.prepare("SELECT id FROM memories").map_err(sql_error)?;
        for row in stmt.query_map([], |row| id(row, "id")).map_err(sql_error)? {
            let existing = row.map_err(sql_error)?;
            if touched
                .get(&index_key(existing))
                .is_some_and(|id| *id != existing)
            {
                return Err(CobaltError::Conflict("USearch UUID key collision".into()));
            }
        }
        let required = index.size().saturating_add(put.len());
        if required > index.capacity() {
            index
                .reserve(required.max(16).saturating_mul(2))
                .map_err(engine_error)?;
        }
        for id in remove {
            index.remove(index_key(*id)).map_err(engine_error)?;
        }
        for &(id, embedding) in put {
            let key = index_key(id);
            index.remove(key).map_err(engine_error)?;
            index.add(key, embedding).map_err(engine_error)?;
        }
        if self.working.is_some() {
            Ok(())
        } else {
            self.publish(&index)
        }
    }

    fn scoped(
        &self,
        conn: &Connection,
        query: &[f32],
        top_k: usize,
        scope: Scope,
    ) -> Result<Vec<VectorHit>> {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT m.id FROM memories m WHERE {}",
                scope.clause
            ))
            .map_err(sql_error)?;
        let mut ids = HashMap::new();
        for row in stmt
            .query_map(params_from_iter(scope.params), |row| id(row, "id"))
            .map_err(sql_error)?
        {
            let id = row.map_err(sql_error)?;
            if ids.insert(index_key(id), id).is_some() {
                return Err(CobaltError::Conflict("USearch UUID key collision".into()));
            }
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let _lock = self.db.index_io().read().map_err(engine_error)?;
        let index = self.open_index(true)?;
        let k = top_k.min(index.size()).min(ids.len());
        if k == 0 {
            return Ok(Vec::new());
        }
        let matches = index
            .filtered_search(query, k, |key| ids.contains_key(&key))
            .map_err(engine_error)?;
        let mut hits: Vec<_> = matches
            .keys
            .into_iter()
            .zip(matches.distances)
            .filter_map(|(key, distance)| {
                ids.get(&key).map(|id| VectorHit {
                    memory_id: *id,
                    similarity: (1.0 - distance).clamp(0.0, 1.0),
                })
            })
            .collect();
        hits.sort_by(|a, b| {
            b.similarity
                .total_cmp(&a.similarity)
                .then(a.memory_id.cmp(&b.memory_id))
        });
        Ok(hits)
    }

    fn count_live(&self, conn: &Connection) -> Result<u64> {
        let _lock = self.db.index_io().read().map_err(engine_error)?;
        let index = self.open_index(true)?;
        let mut stmt = conn
            .prepare("SELECT id FROM memories WHERE is_encrypted = 0")
            .map_err(sql_error)?;
        let mut entries = HashSet::new();
        for row in stmt.query_map([], |row| id(row, "id")).map_err(sql_error)? {
            let key = index_key(row.map_err(sql_error)?);
            if index.contains(key) && !entries.insert(key) {
                return Err(CobaltError::Conflict("USearch UUID key collision".into()));
            }
        }
        Ok(entries.len() as u64)
    }
}

pub(crate) fn index_key(id: Id) -> u64 {
    let uuid = id.as_u128();
    (uuid as u64) ^ ((uuid >> 64) as u64).rotate_left(23)
}

fn index_path(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| CobaltError::InvalidInput("USearch requires a UTF-8 path".into()))
}

fn engine_error(err: impl std::fmt::Display) -> CobaltError {
    CobaltError::Engine(err.to_string())
}

#[derive(Clone)]
pub(crate) enum Index {
    SqliteVec(SqliteVec),
    Usearch(Usearch),
    #[cfg(any(feature = "qdrant", feature = "chroma", feature = "lancedb"))]
    External(crate::ExternalVectorStore),
}

impl From<SqliteVec> for Index {
    fn from(index: SqliteVec) -> Self {
        Self::SqliteVec(index)
    }
}

impl From<Usearch> for Index {
    fn from(index: Usearch) -> Self {
        Self::Usearch(index)
    }
}

impl Index {
    pub(crate) fn kind(&self) -> EngineKind {
        match self {
            Self::SqliteVec(_) => EngineKind::SqliteVec,
            Self::Usearch(_) => EngineKind::Usearch,
            #[cfg(any(feature = "qdrant", feature = "chroma", feature = "lancedb"))]
            Self::External(index) => index.kind(),
        }
    }

    pub(crate) fn delete(&self, conn: &Connection, ids: &[Id]) -> Result<()> {
        match self {
            Self::SqliteVec(_) => {
                for &id in ids {
                    SqliteVec::remove(conn, id)?;
                }
                Ok(())
            }
            Self::Usearch(index) => index.edit(conn, &[], ids),
            #[cfg(any(feature = "qdrant", feature = "chroma", feature = "lancedb"))]
            Self::External(index) => index.remove(ids),
        }
    }

    pub(crate) fn vectors(&self, conn: &Connection, ids: &[Id]) -> Result<Vec<Option<Vec<f32>>>> {
        match self {
            Self::SqliteVec(_) => {
                let mut stmt = conn
                    .prepare("SELECT embedding FROM vec_memories WHERE memory_id = ?1")
                    .map_err(sql_error)?;
                ids.iter()
                    .map(|id| {
                        let bytes = stmt
                            .query_row([id.to_string()], |row| row.get::<_, Vec<u8>>(0))
                            .optional()
                            .map_err(sql_error)?;
                        Ok(bytes.map(|bytes| {
                            bytes
                                .as_chunks::<4>()
                                .0
                                .iter()
                                .copied()
                                .map(f32::from_ne_bytes)
                                .collect()
                        }))
                    })
                    .collect()
            }
            #[cfg(any(feature = "qdrant", feature = "chroma", feature = "lancedb"))]
            Self::External(index) => index.vectors(ids),
            Self::Usearch(index) => {
                let _lock = index.db.index_io().read().map_err(engine_error)?;
                let view = index.open_index(true)?;
                ids.iter()
                    .map(|id| {
                        let mut vector = vec![0.0; index.dimensions];
                        let found = view
                            .get(index_key(*id), &mut vector)
                            .map_err(engine_error)?;
                        Ok((found == 1).then_some(vector))
                    })
                    .collect()
            }
        }
    }

    pub(crate) fn dimensions(&self) -> usize {
        match self {
            Self::SqliteVec(index) => index.dimensions,
            Self::Usearch(index) => index.dimensions,
            #[cfg(any(feature = "qdrant", feature = "chroma", feature = "lancedb"))]
            Self::External(index) => index.dimensions(),
        }
    }

    pub(crate) fn insert(&self, conn: &Connection, id: Id, embedding: &[f32]) -> Result<()> {
        checked_vector(embedding, self.dimensions())?;
        match self {
            Self::SqliteVec(_) => SqliteVec::replace(conn, id, embedding),
            Self::Usearch(index) => index.edit(conn, &[(id, embedding)], &[]),
            #[cfg(any(feature = "qdrant", feature = "chroma", feature = "lancedb"))]
            Self::External(index) => index.insert(conn, id, embedding),
        }
    }

    pub(crate) fn scoped(
        &self,
        conn: &Connection,
        query: &[f32],
        top_k: usize,
        scope: Scope,
    ) -> Result<Vec<VectorHit>> {
        checked_vector(query, self.dimensions())?;
        if top_k == 0 {
            return Ok(Vec::new());
        }
        match self {
            Self::SqliteVec(_) => SqliteVec::scoped(conn, query, top_k, scope),
            Self::Usearch(index) => index.scoped(conn, query, top_k, scope),
            #[cfg(any(feature = "qdrant", feature = "chroma", feature = "lancedb"))]
            Self::External(index) => index.scoped(conn, query, top_k, scope),
        }
    }
}

async fn search_index(
    db: &Database,
    index: Index,
    query: &[f32],
    top_k: usize,
    filter: &VectorFilter,
) -> Result<Vec<VectorHit>> {
    let query = query.to_vec();
    let filter = filter.clone();
    db.read(move |conn| {
        let tx = conn.unchecked_transaction().map_err(sql_error)?;
        let scope = Scope::new(
            branch(&tx, filter.branch_id)?.id,
            &filter,
            &SearchFilter::default(),
        );
        index.scoped(&tx, &query, top_k, scope)
    })
    .await
}

#[async_trait]
impl VectorStore for SqliteVec {
    fn kind(&self) -> EngineKind {
        EngineKind::SqliteVec
    }
    fn dimensions(&self) -> usize {
        self.dimensions
    }

    async fn upsert(&self, records: &[VectorRecord]) -> Result<()> {
        let records = records.to_vec();
        let dimensions = self.dimensions;
        self.db
            .write(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                for record in records {
                    checked_vector(&record.vector, dimensions)?;
                    validate_target(&tx, record.memory_id)?;
                    Self::replace(&tx, record.memory_id, &record.vector)?;
                }
                tx.commit().map_err(sql_error)
            })
            .await
    }

    async fn delete(&self, memory_ids: &[Id]) -> Result<()> {
        let ids = memory_ids.to_vec();
        self.db
            .write(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                for id in ids {
                    Self::remove(&tx, id)?;
                }
                tx.commit().map_err(sql_error)
            })
            .await
    }

    async fn search(
        &self,
        query: &[f32],
        top_k: usize,
        filter: &VectorFilter,
    ) -> Result<Vec<VectorHit>> {
        search_index(&self.db, self.clone().into(), query, top_k, filter).await
    }

    async fn count(&self) -> Result<u64> {
        self.db.read(|conn| conn.query_row(
            "SELECT count(*) FROM vec_memories v JOIN memories m ON m.id = v.memory_id WHERE m.is_encrypted = 0",
            [], |row| row.get::<_, i64>(0),
        ).map(|count| count as u64).map_err(sql_error)).await
    }

    async fn flush(&self) -> Result<()> {
        Ok(())
    }

    async fn health_check(&self) -> Result<()> {
        self.db.read(Self::probe).await
    }
}

#[async_trait]
impl VectorStore for Usearch {
    fn kind(&self) -> EngineKind {
        EngineKind::Usearch
    }
    fn dimensions(&self) -> usize {
        self.dimensions
    }

    async fn upsert(&self, records: &[VectorRecord]) -> Result<()> {
        let index = self.clone();
        let records = records.to_vec();
        self.db
            .write(move |conn| {
                let mut put = Vec::with_capacity(records.len());
                for record in &records {
                    checked_vector(&record.vector, index.dimensions)?;
                    validate_target(conn, record.memory_id)?;
                    put.push((record.memory_id, record.vector.as_slice()));
                }
                index.edit(conn, &put, &[])
            })
            .await
    }

    async fn delete(&self, memory_ids: &[Id]) -> Result<()> {
        let index = self.clone();
        let ids = memory_ids.to_vec();
        self.db.write(move |conn| index.edit(conn, &[], &ids)).await
    }

    async fn search(
        &self,
        query: &[f32],
        top_k: usize,
        filter: &VectorFilter,
    ) -> Result<Vec<VectorHit>> {
        search_index(&self.db, self.clone().into(), query, top_k, filter).await
    }

    async fn count(&self) -> Result<u64> {
        let index = self.clone();
        self.db.read(move |conn| index.count_live(conn)).await
    }

    async fn flush(&self) -> Result<()> {
        let index = self.clone();
        self.db
            .write(move |_| {
                let _lock = index.db.index_io().read().map_err(engine_error)?;
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&index.file)?
                    .sync_all()?;
                #[cfg(unix)]
                if let Some(parent) = index.file.parent() {
                    std::fs::File::open(parent)?.sync_all()?;
                }
                Ok(())
            })
            .await
    }

    async fn health_check(&self) -> Result<()> {
        let index = self.clone();
        self.db
            .read(move |_| {
                let _lock = index.db.index_io().read().map_err(engine_error)?;
                index.open_index(true)?;
                Ok(())
            })
            .await
    }
}

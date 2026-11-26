use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;

use async_trait::async_trait;
use cobalt_core::config::AppSettings;
use cobalt_core::enums::{FileAvailability, SourceType};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, Timestamp, new_id, now, timestamp_from_sql, timestamp_to_sql};
use cobalt_core::model::{
    Branch, NewProject, NewSourceDocument, Project, ProjectPatch, ProjectStats, SourceDocument,
};
use cobalt_core::traits::{ConfigRepository, ProjectRepository, SourceDocumentRepository};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::SqliteStore;
use crate::db::sql_error;

pub(crate) fn text<T: FromStr<Err = CobaltError>>(row: &Row<'_>, col: &str) -> rusqlite::Result<T> {
    let value: String = row.get(col)?;
    value.parse().map_err(|error| conversion(row, col, error))
}

pub(crate) fn id(row: &Row<'_>, col: &str) -> rusqlite::Result<Id> {
    let value: String = row.get(col)?;
    cobalt_core::ids::id_from_str(&value).map_err(|error| conversion(row, col, error))
}

pub(crate) fn optional_id(row: &Row<'_>, col: &str) -> rusqlite::Result<Option<Id>> {
    row.get::<_, Option<String>>(col)?
        .map(|value| {
            cobalt_core::ids::id_from_str(&value).map_err(|error| conversion(row, col, error))
        })
        .transpose()
}

pub(crate) fn timestamp(row: &Row<'_>, col: &str) -> rusqlite::Result<Timestamp> {
    timestamp_from_sql(&row.get::<_, String>(col)?).map_err(|error| conversion(row, col, error))
}

pub(crate) fn optional_timestamp(row: &Row<'_>, col: &str) -> rusqlite::Result<Option<Timestamp>> {
    row.get::<_, Option<String>>(col)?
        .map(|value| timestamp_from_sql(&value).map_err(|error| conversion(row, col, error)))
        .transpose()
}

pub(crate) fn json<T: serde::de::DeserializeOwned>(
    row: &Row<'_>,
    col: &str,
) -> rusqlite::Result<Option<T>> {
    row.get::<_, Option<String>>(col)?
        .map(|value| serde_json::from_str(&value).map_err(|err| conversion(row, col, err.into())))
        .transpose()
}

fn conversion(row: &Row<'_>, col: &str, error: CobaltError) -> rusqlite::Error {
    match row.as_ref().column_index(col) {
        Ok(index) => rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        ),
        Err(error) => error,
    }
}

pub(crate) fn stamp() -> String {
    timestamp_to_sql(&now())
}

pub(crate) fn branch_row(row: &Row<'_>) -> rusqlite::Result<Branch> {
    Ok(Branch {
        id: id(row, "id")?,
        name: row.get("name")?,
        parent_branch_id: optional_id(row, "parent_branch_id")?,
        created_at: timestamp(row, "created_at")?,
        is_active: row.get("is_active")?,
    })
}

pub(crate) fn branch(conn: &Connection, branch_id: Option<Id>) -> Result<Branch> {
    let branch = conn
        .query_row(
            "SELECT * FROM branches WHERE (?1 IS NULL AND is_active = 1) OR id = ?1",
            [branch_id.map(|id| id.to_string())],
            branch_row,
        )
        .optional()
        .map_err(sql_error)?;
    branch.ok_or_else(|| {
        CobaltError::NotFound(
            branch_id.map_or_else(|| "active branch".into(), |id| format!("branch {id}")),
        )
    })
}

pub(crate) fn load_settings(conn: &Connection) -> Result<AppSettings> {
    let mut statement = conn
        .prepare("SELECT key, value_json FROM app_config")
        .map_err(sql_error)?;
    let entries = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sql_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)?;
    Ok(AppSettings::from_entries(entries.into_iter().filter_map(
        |(key, value)| serde_json::from_str(&value).ok().map(|value| (key, value)),
    )))
}

pub(crate) const UPSERT_CONFIG: &str = "INSERT INTO app_config (key, value_json, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at";

#[async_trait]
impl ConfigRepository for SqliteStore {
    async fn load_settings(&self) -> Result<AppSettings> {
        self.db.read(load_settings).await
    }

    async fn save_settings(&self, settings: &AppSettings) -> Result<()> {
        let entries = settings.to_entries()?;
        self.db
            .write(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                let updated = stamp();
                for (key, value) in entries {
                    tx.execute(UPSERT_CONFIG, params![key, value.to_string(), updated])
                        .map_err(sql_error)?;
                }
                tx.commit().map_err(sql_error)
            })
            .await
    }

    async fn get_raw(&self, key: &str) -> Result<Option<Value>> {
        let key = key.to_owned();
        self.db
            .read(move |conn| {
                let raw: Option<String> = conn
                    .query_row(
                        "SELECT value_json FROM app_config WHERE key = ?1",
                        [key],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(sql_error)?;
                raw.map(|value| serde_json::from_str(&value).map_err(Into::into))
                    .transpose()
            })
            .await
    }

    async fn set_raw(&self, key: &str, value: Value) -> Result<()> {
        let key = key.to_owned();
        self.db
            .write(move |conn| {
                conn.execute(UPSERT_CONFIG, params![key, value.to_string(), stamp()])
                    .map_err(sql_error)?;
                Ok(())
            })
            .await
    }
}

fn project(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: id(row, "id")?,
        name: row.get("name")?,
        root_path: row.get("root_path")?,
        color_hex: row.get("color_hex")?,
        is_archived: row.get("is_archived")?,
        created_at: timestamp(row, "created_at")?,
        updated_at: timestamp(row, "updated_at")?,
    })
}

pub(crate) fn project_stats(
    conn: &Connection,
    branch_id: Id,
    include_archived: bool,
) -> Result<Vec<ProjectStats>> {
    let mut statement = conn.prepare(
        "SELECT p.*, count(m.id) AS vector_count, coalesce(sum(m.chunk_tokens), 0) AS total_tokens,
                coalesce(sum(m.is_reusable), 0) AS reusable_count
         FROM projects p LEFT JOIN memories m
           ON m.project_id = p.id AND m.branch_id = ?1 AND m.status = 'active'
         WHERE ?2 OR p.is_archived = 0 GROUP BY p.id ORDER BY p.name, p.id",
    ).map_err(sql_error)?;
    statement
        .query_map(params![branch_id.to_string(), include_archived], |row| {
            Ok(ProjectStats {
                project: project(row)?,
                vector_count: row.get::<_, i64>("vector_count")? as u64,
                total_tokens: row.get::<_, i64>("total_tokens")? as u64,
                reusable_count: row.get::<_, i64>("reusable_count")? as u64,
            })
        })
        .map_err(sql_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(sql_error)
}

fn validated_project(project: &Project) -> Result<()> {
    if project.name.trim().is_empty() {
        return Err(CobaltError::InvalidInput("project name is empty".into()));
    }
    if project
        .root_path
        .as_ref()
        .is_some_and(|root| !Path::new(root).is_absolute())
    {
        return Err(CobaltError::InvalidInput(
            "project root must be absolute".into(),
        ));
    }
    let color = project.color_hex.as_bytes();
    if color.len() != 7 || color[0] != b'#' || !color[1..].iter().all(u8::is_ascii_hexdigit) {
        return Err(CobaltError::InvalidInput(
            "project color must be #RRGGBB".into(),
        ));
    }
    Ok(())
}

fn insert_project(conn: &Connection, input: NewProject) -> Result<Project> {
    let id = new_id().to_string();
    let color = input.color_hex.unwrap_or_else(|| {
        let hash = Sha256::digest(input.name.as_bytes());
        format!("#{:02X}{:02X}{:02X}", hash[0], hash[1], hash[2])
    });
    conn.execute(
        "INSERT INTO projects (id, name, root_path, color_hex, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, input.name, input.root_path, color, stamp()],
    )
    .map_err(sql_error)?;
    let result = conn
        .query_row("SELECT * FROM projects WHERE id = ?1", [id], project)
        .map_err(sql_error)?;
    validated_project(&result)?;
    Ok(result)
}

fn path_components(path: &Path) -> Vec<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(parts.last(), Some(Component::Normal(_))) {
                    parts.pop();
                }
            }
            _ => parts.push(component),
        }
    }
    parts
        .iter()
        .map(|part| {
            let value = part.as_os_str().to_string_lossy();
            if cfg!(any(windows, target_os = "macos")) {
                value.to_lowercase()
            } else {
                value.into_owned()
            }
        })
        .collect()
}

fn resolve_path(conn: &Connection, path: &Path) -> Result<Option<Project>> {
    let parts = path_components(path);
    let mut stmt = conn
        .prepare("SELECT * FROM projects WHERE root_path IS NOT NULL ORDER BY id")
        .map_err(sql_error)?;
    let mut best = None;
    let mut best_len = 0;
    for row in stmt.query_map([], project).map_err(sql_error)? {
        let project = row.map_err(sql_error)?;
        if let Some(root) = &project.root_path {
            let root = path_components(Path::new(root));
            if root.len() > best_len && parts.starts_with(&root) {
                best_len = root.len();
                best = Some(project);
            }
        }
    }
    Ok(best)
}

#[async_trait]
impl ProjectRepository for SqliteStore {
    async fn list_projects(&self, include_archived: bool) -> Result<Vec<ProjectStats>> {
        self.db
            .read(move |conn| project_stats(conn, branch(conn, None)?.id, include_archived))
            .await
    }

    async fn get_project(&self, id: Id) -> Result<Option<Project>> {
        self.db
            .read(move |conn| {
                conn.query_row(
                    "SELECT * FROM projects WHERE id = ?1",
                    [id.to_string()],
                    project,
                )
                .optional()
                .map_err(sql_error)
            })
            .await
    }

    async fn find_project_by_name(&self, name: &str) -> Result<Option<Project>> {
        let name = name.to_owned();
        self.db
            .read(move |conn| {
                conn.query_row("SELECT * FROM projects WHERE name = ?1", [name], project)
                    .optional()
                    .map_err(sql_error)
            })
            .await
    }

    async fn resolve_project_by_path(
        &self,
        path: &str,
        create_if_missing: bool,
    ) -> Result<Option<Project>> {
        let path = PathBuf::from(path);
        if !create_if_missing {
            return self.db.read(move |conn| resolve_path(conn, &path)).await;
        }
        self.db
            .write(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                if let Some(project) = resolve_path(&tx, &path)? {
                    return Ok(Some(project));
                }
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| {
                        CobaltError::InvalidInput("project path needs a final component".into())
                    })?;
                let result = insert_project(
                    &tx,
                    NewProject {
                        name: name.into(),
                        root_path: Some(path.to_string_lossy().into_owned()),
                        color_hex: None,
                    },
                )?;
                tx.commit().map_err(sql_error)?;
                Ok(Some(result))
            })
            .await
    }

    async fn create_project(&self, new: NewProject) -> Result<Project> {
        self.db
            .write(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                let result = insert_project(&tx, new)?;
                tx.commit().map_err(sql_error)?;
                Ok(result)
            })
            .await
    }

    async fn update_project(&self, id: Id, patch: ProjectPatch) -> Result<Project> {
        self.db.write(move |conn| {
            let key = id.to_string();
            let mut row = conn.query_row("SELECT * FROM projects WHERE id = ?1", [&key], project)
                .optional().map_err(sql_error)?.ok_or_else(|| CobaltError::NotFound(format!("project {id}")))?;
            row.name = patch.name.unwrap_or(row.name);
            row.root_path = patch.root_path.unwrap_or(row.root_path);
            row.color_hex = patch.color_hex.unwrap_or(row.color_hex);
            row.is_archived = patch.is_archived.unwrap_or(row.is_archived);
            validated_project(&row)?;
            conn.query_row(
                "UPDATE projects SET name = ?2, root_path = ?3, color_hex = ?4, is_archived = ?5, updated_at = ?6
                 WHERE id = ?1 RETURNING *",
                params![key, row.name, row.root_path, row.color_hex, row.is_archived, stamp()], project,
            ).map_err(sql_error)
        }).await
    }
}

fn source(row: &Row<'_>) -> rusqlite::Result<SourceDocument> {
    Ok(SourceDocument {
        id: id(row, "id")?,
        project_id: optional_id(row, "project_id")?,
        file_path: row.get("file_path")?,
        is_dir: row.get("is_dir")?,
        source_type: text(row, "source_type")?,
        file_hash: row.get("file_hash")?,
        total_tokens: row.get("total_tokens")?,
        is_watched: row.get("is_watched")?,
        updated_at: timestamp(row, "updated_at")?,
    })
}

pub(crate) fn source_by_id(conn: &Connection, id: Id) -> Result<Option<SourceDocument>> {
    conn.query_row(
        "SELECT * FROM source_documents WHERE id = ?1",
        [id.to_string()],
        source,
    )
    .optional()
    .map_err(sql_error)
}

fn hash_file(path: &Path) -> Result<Option<String>> {
    let metadata = std::fs::metadata(path)?;
    if metadata.is_dir() {
        return Ok(None);
    }
    if !metadata.is_file() {
        return Err(CobaltError::InvalidInput(format!(
            "unsupported source {}",
            path.display()
        )));
    }
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 32 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(Some(hex::encode(hash.finalize())))
}

pub(crate) fn source_availability(doc: &SourceDocument, snippet: bool) -> Result<FileAvailability> {
    match hash_file(Path::new(&doc.file_path)) {
        Ok(hash) if hash.is_none() == doc.is_dir && hash == doc.file_hash => {
            Ok(FileAvailability::Available)
        }
        Ok(_) => Ok(FileAvailability::Modified),
        Err(CobaltError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => Ok(if snippet {
            FileAvailability::SnippetOnly
        } else {
            FileAvailability::Missing
        }),
        Err(err) => Err(err),
    }
}

#[async_trait]
impl SourceDocumentRepository for SqliteStore {
    async fn upsert_source_document(&self, doc: NewSourceDocument) -> Result<SourceDocument> {
        self.db.write(move |conn| {
            let source_type = doc.source_type.unwrap_or_else(|| SourceType::from_path(Path::new(&doc.file_path)));
            let hash = if doc.is_dir { None } else { doc.file_hash };
            conn.query_row(
                "INSERT INTO source_documents (id, project_id, file_path, is_dir, source_type, file_hash, total_tokens, is_watched, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(file_path) DO UPDATE SET project_id = excluded.project_id, is_dir = excluded.is_dir,
                    source_type = excluded.source_type, file_hash = excluded.file_hash, total_tokens = excluded.total_tokens,
                    is_watched = excluded.is_watched, updated_at = excluded.updated_at RETURNING *",
                params![new_id().to_string(), doc.project_id.map(|id| id.to_string()), doc.file_path, doc.is_dir,
                    source_type.as_str(), hash, doc.total_tokens, doc.is_watched, stamp()], source,
            ).map_err(sql_error)
        }).await
    }

    async fn get_source_document(&self, id: Id) -> Result<Option<SourceDocument>> {
        self.db.read(move |conn| source_by_id(conn, id)).await
    }

    async fn find_source_document_by_path(&self, path: &str) -> Result<Option<SourceDocument>> {
        let path = path.to_owned();
        self.db
            .read(move |conn| {
                conn.query_row(
                    "SELECT * FROM source_documents WHERE file_path = ?1",
                    [path],
                    source,
                )
                .optional()
                .map_err(sql_error)
            })
            .await
    }

    async fn verify_source_document(&self, id: Id) -> Result<FileAvailability> {
        let (doc, snippet) = self.db.read(move |conn| {
            let doc = source_by_id(conn, id)?.ok_or_else(|| CobaltError::NotFound(format!("source document {id}")))?;
            let snippet: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM memories WHERE source_doc_id = ?1 AND is_encrypted = 0 AND is_reusable = 1 AND reusable_snippet <> '')",
                [id.to_string()], |row| row.get(0),
            ).map_err(sql_error)?;
            Ok((doc, snippet))
        }).await?;
        crate::db::blocking(move || source_availability(&doc, snippet)).await
    }

    async fn relink_source_document(&self, id: Id, new_path: &str) -> Result<SourceDocument> {
        let path = new_path.to_owned();
        let (path, hash) = crate::db::blocking(move || {
            let hash = hash_file(Path::new(&path))?;
            Ok((path, hash))
        })
        .await?;
        self.db
            .write(move |conn| {
                conn.query_row(
                    "UPDATE source_documents SET file_path = ?2, file_hash = ?3, updated_at = ?4
             WHERE id = ?1 AND is_dir = ?5 RETURNING *",
                    params![id.to_string(), path, hash, stamp(), hash.is_none()],
                    source,
                )
                .optional()
                .map_err(sql_error)?
                .ok_or_else(|| match source_by_id(conn, id) {
                    Ok(Some(_)) => CobaltError::InvalidInput(
                        "relink target must have the same file type".into(),
                    ),
                    Ok(None) => CobaltError::NotFound(format!("source document {id}")),
                    Err(err) => err,
                })
            })
            .await
    }

    async fn set_watched(&self, id: Id, watched: bool) -> Result<SourceDocument> {
        self.db.write(move |conn| conn.query_row(
            "UPDATE source_documents SET is_watched = ?2, updated_at = ?3 WHERE id = ?1 RETURNING *",
            params![id.to_string(), watched, stamp()], source,
        ).optional().map_err(sql_error)?.ok_or_else(|| CobaltError::NotFound(format!("source document {id}")))).await
    }

    async fn list_watched(&self) -> Result<Vec<SourceDocument>> {
        self.db
            .read(|conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT * FROM source_documents WHERE is_watched = 1 ORDER BY file_path",
                    )
                    .map_err(sql_error)?;
                stmt.query_map([], source)
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(sql_error)
            })
            .await
    }
}

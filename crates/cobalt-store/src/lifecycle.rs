use async_trait::async_trait;
use chrono::TimeDelta;
use cobalt_core::enums::MemoryStatus;
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, MAIN_BRANCH_ID, new_id, now, timestamp_to_sql};
use cobalt_core::model::{
    Branch, BranchMergeReport, Handoff, InstalledTheme, Memory, NewBranch, NewHandoff, NewMemory,
};
use cobalt_core::traits::{BranchRepository, HandoffRepository, ThemeRepository, TokenCounter};
use cobalt_embeddings::TiktokenCounter;
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::db::sql_error;
use crate::governance::branch_memories;
use crate::memory::{
    WriteMode, clear_semantic_edges, exact_match, mark_superseded, refresh_edges, remove_vectors,
    semantic_match, write_memory,
};
use crate::repositories::{
    branch, branch_row, id, json, load_settings, optional_id, stamp, text, timestamp,
};
use crate::{Retrieval, SqliteStore};

fn ensure_side_branch(id: Id) -> Result<()> {
    if id == MAIN_BRANCH_ID {
        return Err(CobaltError::InvalidInput(
            "main cannot be merged or discarded".into(),
        ));
    }
    Ok(())
}

fn activate(conn: &Connection, id: Id) -> Result<Branch> {
    branch(conn, Some(id))?;
    conn.execute("UPDATE branches SET is_active = 0 WHERE is_active = 1", [])
        .map_err(sql_error)?;
    conn.query_row(
        "UPDATE branches SET is_active = 1 WHERE id = ?1 RETURNING *",
        [id.to_string()],
        branch_row,
    )
    .map_err(sql_error)
}

fn remove_branch(conn: &Connection, source: &Branch) -> Result<()> {
    if source.is_active {
        activate(conn, MAIN_BRANCH_ID)?;
    }
    conn.execute(
        "DELETE FROM branches WHERE id = ?1",
        [source.id.to_string()],
    )
    .map_err(sql_error)?;
    Ok(())
}

fn move_to_main(conn: &Connection, row: &mut Memory) -> Result<()> {
    clear_semantic_edges(conn, row.id)?;
    conn.execute(
        "DELETE FROM memory_edges WHERE edge_type = 'same_project' AND
                  (source_id = ?1 OR target_id = ?1)",
        [row.id.to_string()],
    )
    .map_err(sql_error)?;
    row.branch_id = MAIN_BRANCH_ID;
    conn.execute(
        "UPDATE memories SET branch_id = ?2 WHERE id = ?1",
        params![row.id.to_string(), MAIN_BRANCH_ID.to_string()],
    )
    .map_err(sql_error)?;
    Ok(())
}

fn redirect_history(conn: &Connection, from: Id, to: Id) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO memory_edges (source_id, target_id, edge_type, weight)
         SELECT ?2, target_id, edge_type, weight FROM memory_edges WHERE source_id = ?1
           AND edge_type = 'supersedes' AND target_id <> ?2",
        params![from.to_string(), to.to_string()],
    )
    .map_err(sql_error)?;
    conn.execute(
        "UPDATE memories SET superseded_by = ?2 WHERE superseded_by = ?1 AND id <> ?2",
        params![from.to_string(), to.to_string()],
    )
    .map_err(sql_error)?;
    Ok(())
}

fn merge_rows(
    conn: &Connection,
    retrieval: Option<&Retrieval>,
    source: &Branch,
) -> Result<BranchMergeReport> {
    let mut report = BranchMergeReport {
        source_branch_id: source.id,
        target_branch_id: MAIN_BRANCH_ID,
        merged: 0,
        superseded: 0,
        skipped_duplicates: 0,
    };
    let rows = branch_memories(conn, source.id)?;
    let settings = load_settings(conn)?.search;
    // Move history and archived rows before resolving the live branch heads.
    for mut row in rows
        .iter()
        .filter(|row| row.status != MemoryStatus::Active)
        .cloned()
    {
        move_to_main(conn, &mut row)?;
        report.merged += 1;
    }
    let active = rows
        .into_iter()
        .filter(|row| row.status == MemoryStatus::Active);
    let mut removed = Vec::new();
    for mut row in active {
        if let Some(existing) = exact_match(
            conn,
            MAIN_BRANCH_ID,
            row.project_id,
            &row.content_hash,
            None,
        )? {
            redirect_history(conn, row.id, existing.id)?;
            removed.push(row.id);
            report.skipped_duplicates += 1;
            continue;
        }
        if row.is_encrypted {
            move_to_main(conn, &mut row)?;
            report.merged += 1;
            continue;
        }
        let retrieval = retrieval.ok_or_else(|| {
            CobaltError::Engine("configure retrieval before merging branch memories".into())
        })?;
        let vector = retrieval
            .index
            .vectors(conn, &[row.id])?
            .into_iter()
            .next()
            .flatten()
            .ok_or_else(|| {
                CobaltError::Integrity(format!("missing branch vector for {}", row.id))
            })?;
        let matched = semantic_match(conn, retrieval, MAIN_BRANCH_ID, row.project_id, &vector)?;
        if let Some((previous, score)) =
            matched.filter(|(_, score)| *score > settings.dedup_threshold)
        {
            if score >= settings.duplicate_threshold {
                let new = NewMemory {
                    content: row.content,
                    category: row.category,
                    project_id: row.project_id,
                    branch_id: Some(MAIN_BRANCH_ID),
                    source_doc_id: row.source_doc_id,
                    source_type: Some(row.source_type),
                    confidence: Some(row.confidence),
                    is_core_pin: row.is_core_pin,
                    is_reusable: row.is_reusable,
                    reusable_snippet: row.reusable_snippet,
                    source_client: row.source_client,
                };
                let result = write_memory(
                    conn,
                    retrieval,
                    MAIN_BRANCH_ID,
                    new,
                    &vector,
                    WriteMode::Normal,
                )?;
                redirect_history(conn, row.id, result.memory.id)?;
                removed.push(row.id);
                report.merged += 1;
                continue;
            }
            mark_superseded(
                conn,
                previous.id,
                row.id,
                "Semantic match on branch merge",
                score,
            )?;
            if previous.is_core_pin && !row.is_core_pin {
                conn.execute(
                    "UPDATE memories SET is_core_pin = 1 WHERE id = ?1",
                    [row.id.to_string()],
                )
                .map_err(sql_error)?;
                row.is_core_pin = true;
            }
            report.superseded += 1;
        }
        move_to_main(conn, &mut row)?;
        refresh_edges(
            conn,
            retrieval,
            &row,
            &vector,
            settings.semantic_edge_threshold,
        )?;
        report.merged += 1;
    }
    if !removed.is_empty() {
        remove_vectors(conn, retrieval.map(|r| &r.index), &removed)?;
    }
    remove_branch(conn, source)?;
    Ok(report)
}

#[async_trait]
impl BranchRepository for SqliteStore {
    async fn list_branches(&self) -> Result<Vec<Branch>> {
        self.db
            .read(|conn| {
                let mut stmt = conn
                    .prepare("SELECT * FROM branches ORDER BY created_at, id")
                    .map_err(sql_error)?;
                stmt.query_map([], branch_row)
                    .map_err(sql_error)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(sql_error)
            })
            .await
    }

    async fn active_branch(&self) -> Result<Branch> {
        self.db.read(|conn| branch(conn, None)).await
    }

    async fn create_branch(&self, new: NewBranch) -> Result<Branch> {
        self.db
            .write(move |conn| {
                if new.name.trim().is_empty() {
                    return Err(CobaltError::InvalidInput("branch name is empty".into()));
                }
                let parent = branch(conn, new.parent_branch_id)?;
                conn.query_row(
                    "INSERT INTO branches (id, name, parent_branch_id, created_at)
                 VALUES (?1, ?2, ?3, ?4) RETURNING *",
                    params![
                        new_id().to_string(),
                        new.name.trim(),
                        parent.id.to_string(),
                        stamp()
                    ],
                    branch_row,
                )
                .map_err(sql_error)
            })
            .await
    }

    async fn switch_branch(&self, id: Id) -> Result<Branch> {
        self.db
            .write(move |conn| {
                let tx = conn.transaction().map_err(sql_error)?;
                let result = activate(&tx, id)?;
                tx.commit().map_err(sql_error)?;
                Ok(result)
            })
            .await
    }

    async fn merge_branch(&self, id: Id) -> Result<BranchMergeReport> {
        ensure_side_branch(id)?;
        let gate = self.engine_write().await;
        let retrieval = self.configured_retrieval()?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                crate::migration::edit_transaction(conn, retrieval.as_deref(), |tx, retrieval| {
                    let source = branch(tx, Some(id))?;
                    merge_rows(tx, retrieval, &source)
                })
            })
            .await
    }

    async fn discard_branch(&self, id: Id) -> Result<()> {
        ensure_side_branch(id)?;
        let gate = self.engine_write().await;
        let retrieval = self.configured_retrieval()?;
        self.db
            .write(move |conn| {
                let _gate = gate;
                crate::migration::edit_transaction(conn, retrieval.as_deref(), |tx, retrieval| {
                    let source = branch(tx, Some(id))?;
                    let ids: Vec<_> = branch_memories(tx, source.id)?
                        .into_iter()
                        .map(|row| row.id)
                        .collect();
                    if !ids.is_empty() {
                        remove_vectors(tx, retrieval.map(|r| &r.index), &ids)?;
                    }
                    remove_branch(tx, &source)
                })
            })
            .await
    }
}

pub(crate) fn handoff(row: &Row<'_>) -> rusqlite::Result<Handoff> {
    Ok(Handoff {
        id: id(row, "id")?,
        project_id: optional_id(row, "project_id")?,
        source_client: row.get("source_client")?,
        summary: row.get("summary")?,
        last_error: row.get("last_error")?,
        open_files: json(row, "open_files_json")?.unwrap_or_default(),
        created_at: timestamp(row, "created_at")?,
        expires_at: timestamp(row, "expires_at")?,
        consumed_by: row.get("consumed_by")?,
    })
}

#[async_trait]
impl HandoffRepository for SqliteStore {
    async fn create_handoff(&self, new: NewHandoff) -> Result<Handoff> {
        let retrieval = self.configured_retrieval()?;
        self.db
            .write(move |conn| {
                let counter;
                let tokens: &dyn TokenCounter = if let Some(retrieval) = &retrieval {
                    retrieval.tokens.as_ref()
                } else {
                    counter = TiktokenCounter::new(load_settings(conn)?.token_encoding);
                    &counter
                };
                if new.source_client.trim().is_empty()
                    || new.summary.trim().is_empty()
                    || tokens.count(&new.summary) >= 250
                {
                    return Err(CobaltError::InvalidInput(
                        "handoff requires a client and a summary under 250 tokens".into(),
                    ));
                }
                let created = now();
                let expires = created
                    .checked_add_signed(TimeDelta::hours(i64::from(new.ttl_hours.unwrap_or(48))))
                    .ok_or_else(|| {
                        CobaltError::InvalidInput("handoff expiry exceeds timestamp range".into())
                    })?;
                conn.query_row(
                    "INSERT INTO handoffs (id, project_id, source_client, summary, last_error,
                    open_files_json, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING *",
                    params![
                        new_id().to_string(),
                        new.project_id.map(|id| id.to_string()),
                        new.source_client,
                        new.summary,
                        new.last_error,
                        serde_json::to_string(&new.open_files)?,
                        timestamp_to_sql(&created),
                        timestamp_to_sql(&expires)
                    ],
                    handoff,
                )
                .map_err(sql_error)
            })
            .await
    }

    async fn resume_handoff(
        &self,
        project_id: Option<Id>,
        consumer: &str,
    ) -> Result<Option<Handoff>> {
        let consumer = consumer.to_owned();
        if consumer.trim().is_empty() {
            return Err(CobaltError::InvalidInput(
                "handoff consumer is empty".into(),
            ));
        }
        self.db
            .write(move |conn| {
                conn.query_row(
                    "UPDATE handoffs SET consumed_by = ?3 WHERE id = (
                    SELECT id FROM handoffs WHERE (project_id IS NULL OR project_id = ?1)
                      AND expires_at > ?2 AND consumed_by IS NULL
                    ORDER BY project_id IS NULL, created_at DESC, id DESC LIMIT 1
                 ) RETURNING *",
                    params![project_id.map(|id| id.to_string()), stamp(), consumer],
                    handoff,
                )
                .optional()
                .map_err(sql_error)
            })
            .await
    }
}

#[async_trait]
impl ThemeRepository for SqliteStore {
    async fn list_installed_themes(&self) -> Result<Vec<InstalledTheme>> {
        self.db
            .read(|conn| {
                let mut stmt = conn
                    .prepare("SELECT * FROM installed_themes ORDER BY name, id")
                    .map_err(sql_error)?;
                stmt.query_map([], |row| {
                    Ok(InstalledTheme {
                        id: row.get("id")?,
                        name: row.get("name")?,
                        author: row.get("author")?,
                        version: row.get("version")?,
                        size_bytes: row.get("size_bytes")?,
                        hardware_tier: text(row, "hardware_tier")?,
                        local_path: row.get("local_path")?,
                        installed_at: timestamp(row, "installed_at")?,
                    })
                })
                .map_err(sql_error)?
                .collect::<rusqlite::Result<_>>()
                .map_err(sql_error)
            })
            .await
    }

    async fn record_installed_theme(&self, theme: InstalledTheme) -> Result<()> {
        if theme.id.trim().is_empty() || theme.size_bytes < 0 {
            return Err(CobaltError::InvalidInput(
                "invalid installed theme id or size".into(),
            ));
        }
        self.db.write(move |conn| {
            conn.execute(
                "INSERT INTO installed_themes (id, name, author, version, size_bytes, hardware_tier, local_path, installed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name, author = excluded.author, version = excluded.version,
                    size_bytes = excluded.size_bytes, hardware_tier = excluded.hardware_tier,
                    local_path = excluded.local_path, installed_at = excluded.installed_at",
                params![theme.id, theme.name, theme.author, theme.version, theme.size_bytes,
                    theme.hardware_tier.as_str(), theme.local_path, timestamp_to_sql(&theme.installed_at)],
            ).map_err(sql_error)?;
            Ok(())
        }).await
    }

    async fn remove_installed_theme(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.db
            .write(move |conn| {
                conn.execute("DELETE FROM installed_themes WHERE id = ?1", [id])
                    .map_err(sql_error)?;
                Ok(())
            })
            .await
    }
}

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::Path;

use cobalt_core::SCHEMA_VERSION;
use cobalt_core::catalog::Catalog;
use cobalt_core::enums::{MemoryStatus, WriteAction};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::ids::{Id, MAIN_BRANCH_ID, now, timestamp_to_sql};
use cobalt_core::model::{
    Branch, GraphQuery, Handoff, Memory, MemoryEdge, MemoryPatch, NewBranch, NewMemory, NewProject,
    NewSourceDocument, Project, ProjectPatch, SourceDocument, UpdateMemoryRequest,
};
use cobalt_core::scrubber::scrub;
use cobalt_core::telemetry::{TelemetryLog, TelemetryQuery};
use cobalt_core::transfer::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

use crate::documents::{digest, ignored};
use crate::{Context, blocking};

const DATA: &str = "data.json";
const MANIFEST: &str = "manifest.json";
const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST: u64 = 1024 * 1024;
const IMPORT_CLIENT: &str = "cobalt-import";

#[derive(Default, Serialize, Deserialize)]
struct PortableData {
    projects: Vec<Project>,
    branches: Vec<Branch>,
    source_documents: Vec<SourceDocument>,
    memories: Vec<Memory>,
    edges: Vec<MemoryEdge>,
    telemetry: Vec<TelemetryLog>,
    handoffs: Vec<Handoff>,
    #[serde(default)]
    warnings: Vec<String>,
}

impl PortableData {
    fn counts(&self) -> BackupCounts {
        BackupCounts {
            projects: self.projects.len() as u64,
            branches: self.branches.len() as u64,
            source_documents: self.source_documents.len() as u64,
            memories: self.memories.len() as u64,
            memory_edges: self.edges.len() as u64,
            handoffs: self.handoffs.len() as u64,
            telemetry_logs: self.telemetry.len() as u64,
            snapshots: 0,
        }
    }

    fn validate(&self) -> Result<()> {
        let projects: HashSet<_> = self.projects.iter().map(|row| row.id).collect();
        let branches: HashSet<_> = self.branches.iter().map(|row| row.id).collect();
        let documents: HashSet<_> = self.source_documents.iter().map(|row| row.id).collect();
        let memories: HashSet<_> = self.memories.iter().map(|row| row.id).collect();
        if projects.len() != self.projects.len()
            || branches.len() != self.branches.len()
            || documents.len() != self.source_documents.len()
            || memories.len() != self.memories.len()
        {
            return Err(integrity("duplicate record UUID in archive"));
        }
        let has_project = |id: Option<Id>| id.is_none_or(|id| projects.contains(&id));
        if self.projects.iter().any(|row| {
            row.name.trim().is_empty()
                || !row.color_hex.starts_with('#')
                || row.color_hex.len() != 7
                || !row.color_hex[1..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        }) || self.branches.iter().any(|row| row.name.trim().is_empty())
            || self.source_documents.iter().any(|row| {
                !has_project(row.project_id) || row.file_path.is_empty() || row.total_tokens < 0
            })
            || self.memories.iter().any(|row| {
                !has_project(row.project_id)
                    || !branches.contains(&row.branch_id)
                    || row.source_doc_id.is_some_and(|id| !documents.contains(&id))
                    || row.superseded_by == Some(row.id)
                    || !(0.0..=1.0).contains(&row.confidence)
                    || row.reuse_count < 0
                    || row.hit_count < 0
                    || !row.relevance_score.is_finite()
            })
            || self.handoffs.iter().any(|row| !has_project(row.project_id))
            || self
                .telemetry
                .iter()
                .any(|row| !has_project(row.project_id))
        {
            return Err(integrity("invalid entity or reference in portable data"));
        }
        Ok(())
    }

    fn sanitize(&mut self, global: Option<&Path>, from_archive: bool) -> Result<()> {
        let roots: HashMap<_, _> = self
            .projects
            .iter()
            .filter_map(|project| {
                project
                    .root_path
                    .as_ref()
                    .map(|path| (project.id, path.clone()))
            })
            .collect();
        let mut excluded = HashSet::new();
        for doc in &self.source_documents {
            if transfer_path_ignored(
                &doc.file_path,
                doc.is_dir,
                doc.project_id
                    .and_then(|id| roots.get(&id))
                    .map(String::as_str),
                global,
            )? || scrub(&doc.file_path).text != doc.file_path
            {
                excluded.insert(doc.id);
            }
        }
        self.source_documents
            .retain(|doc| !excluded.contains(&doc.id));
        for project in &mut self.projects {
            project.name = scrub(&project.name).text;
            project.root_path = project
                .root_path
                .take()
                .filter(|path| scrub(path).text == *path);
        }
        for branch in &mut self.branches {
            branch.name = scrub(&branch.name).text;
        }
        let mut retained = Vec::new();
        let encrypted = self.memories.iter().filter(|row| row.is_encrypted).count();
        if encrypted > 0 {
            self.warnings.push(format!(
                "{encrypted} vault-encrypted memories require their original vault and were omitted"
            ));
        }
        for mut row in std::mem::take(&mut self.memories) {
            if row.is_encrypted || row.source_doc_id.is_some_and(|id| excluded.contains(&id)) {
                continue;
            }
            if from_archive && row.content_hash != digest(row.content.as_bytes()) {
                return Err(integrity(format!(
                    "memory {} has an inconsistent content hash",
                    row.id
                )));
            }
            row.content = scrub(&row.content).text;
            row.content_hash = digest(row.content.as_bytes());
            if row.content.trim().is_empty() {
                continue;
            }
            row.version_reason = row.version_reason.map(|reason| scrub(&reason).text);
            row.reusable_snippet = row.reusable_snippet.map(|snippet| scrub(&snippet).text);
            row.source_client = row.source_client.map(|client| scrub(&client).text);
            retained.push(row);
        }
        self.memories = retained;
        let kept: HashSet<_> = self.memories.iter().map(|row| row.id).collect();
        self.edges
            .retain(|edge| kept.contains(&edge.source_id) && kept.contains(&edge.target_id));
        for log in &mut self.telemetry {
            log.client_name = scrub(&log.client_name).text;
            log.query_text = log.query_text.take().map(|value| scrub(&value).text);
            for item in &mut log.returned_items {
                item.content_snapshot = item
                    .content_snapshot
                    .take()
                    .filter(|_| kept.contains(&item.memory_id))
                    .map(|value| scrub(&value).text);
            }
        }
        for handoff in &mut self.handoffs {
            handoff.summary = scrub(&handoff.summary).text;
            handoff.last_error = handoff.last_error.take().map(|value| scrub(&value).text);
            handoff.source_client = scrub(&handoff.source_client).text;
            handoff.consumed_by = handoff.consumed_by.take().map(|value| scrub(&value).text);
            let root = handoff
                .project_id
                .and_then(|id| roots.get(&id))
                .map(String::as_str);
            let mut files = Vec::new();
            for path in std::mem::take(&mut handoff.open_files) {
                if scrub(&path).text == path && !transfer_path_ignored(&path, false, root, global)?
                {
                    files.push(path);
                }
            }
            handoff.open_files = files;
        }
        if !excluded.is_empty() {
            self.warnings.push(format!(
                "{} source documents excluded by privacy rules",
                excluded.len()
            ));
        }
        Ok(())
    }
}

fn transfer_path_ignored(
    path: &str,
    is_dir: bool,
    root: Option<&str>,
    global: Option<&Path>,
) -> Result<bool> {
    if ignored(Path::new(path), is_dir, root.map(Path::new), global)? {
        return Ok(true);
    }
    #[cfg(unix)]
    if path.contains('\\') {
        let path = path.replace('\\', "/");
        let root = root.map(|root| root.replace('\\', "/"));
        return ignored(
            Path::new(&path),
            is_dir,
            root.as_deref().map(Path::new),
            global,
        );
    }
    Ok(false)
}

fn check_destination(path: &str, extension: &str) -> Result<()> {
    if Path::new(path)
        .extension()
        .is_none_or(|ext| !ext.eq_ignore_ascii_case(extension))
    {
        return Err(CobaltError::InvalidInput(format!(
            "archive destination requires the .{extension} extension"
        )));
    }
    Ok(())
}

fn integrity(message: impl ToString) -> CobaltError {
    CobaltError::Integrity(message.to_string())
}

fn entries(data: &PortableData) -> Result<(Vec<u8>, BTreeMap<String, String>)> {
    let bytes = serde_json::to_vec(data)?;
    if bytes.len() as u64 > MAX_ARCHIVE {
        return Err(CobaltError::InvalidInput(
            "portable data exceeds size limit".into(),
        ));
    }
    let checksums = BTreeMap::from([(DATA.into(), digest(&bytes))]);
    Ok((bytes, checksums))
}

fn write_archive(
    path: &str,
    manifest: Vec<u8>,
    data: Vec<u8>,
    password: Option<&str>,
) -> Result<()> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Zstd);
    for (name, bytes) in [(MANIFEST, manifest), (DATA, data)] {
        zip.start_file(name, options).map_err(integrity)?;
        zip.write_all(&bytes)?;
    }
    let bytes = zip.finish().map_err(integrity)?.into_inner();
    let bytes = match password {
        Some(password) => cobalt_core::vault::seal_with_password(password, &bytes)?,
        None => bytes,
    };
    if bytes.len() as u64 > MAX_ARCHIVE {
        return Err(CobaltError::InvalidInput(
            "archive exceeds size limit".into(),
        ));
    }
    let path = std::path::absolute(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| CobaltError::InvalidInput("archive needs a parent directory".into()))?;
    let mut output = tempfile::NamedTempFile::new_in(parent)?;
    output.write_all(&bytes)?;
    output.as_file().sync_all()?;
    output.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn read_bounded(reader: impl Read, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(integrity("archive exceeds size limit"));
    }
    Ok(bytes)
}

fn open_backup(password: &str, sealed: &[u8]) -> Result<Vec<u8>> {
    // Version 1 exports use the vault's default KDF parameters. Check the plaintext header
    // before key derivation so an untrusted archive cannot request unbounded work.
    let params = cobalt_core::vault::KdfParams::default();
    let kdf_header: [u8; 12] = [params.m_cost, params.t_cost, params.p_cost]
        .map(u32::to_le_bytes)
        .concat()
        .try_into()
        .map_err(|_| integrity("invalid backup KDF header"))?;
    if sealed.get(8..20) != Some(kdf_header.as_slice()) {
        return Err(integrity("unsupported backup key-derivation parameters"));
    }
    cobalt_core::vault::open_with_password(password, sealed)
}

fn read_archive(
    path: &str,
    password: Option<&str>,
    backup: bool,
) -> Result<(u32, String, PortableData)> {
    let bytes = read_bounded(std::fs::File::open(path)?, MAX_ARCHIVE)?;
    let sealed = cobalt_core::vault::is_sealed(&bytes);
    let bytes = if sealed {
        if !backup {
            return Err(integrity("knowledge capsules cannot be password sealed"));
        }
        let password =
            password.ok_or_else(|| CobaltError::InvalidInput("backup password required".into()))?;
        open_backup(password, &bytes)?
    } else {
        bytes
    };
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(integrity)?;
    if archive.len() != 2 || archive.file_names().count() != 2 {
        return Err(integrity("unexpected archive entries"));
    }
    let manifest = read_bounded(archive.by_name(MANIFEST).map_err(integrity)?, MAX_MANIFEST)?;
    let (version, schema, model, checksums, counts) = if backup {
        let manifest: BackupManifest = serde_json::from_slice(&manifest)?;
        if manifest.encrypted != sealed {
            return Err(integrity("backup encryption flag mismatch"));
        }
        (
            manifest.format_version,
            manifest.schema_version,
            manifest.embedding_model_id,
            manifest.checksums,
            manifest.counts,
        )
    } else {
        let manifest: CapsuleManifest = serde_json::from_slice(&manifest)?;
        (
            manifest.format_version,
            manifest.schema_version,
            manifest.embedding_model_id,
            manifest.checksums,
            BackupCounts {
                memories: manifest.memory_count,
                source_documents: manifest.source_document_count,
                ..Default::default()
            },
        )
    };
    if version != TRANSFER_FORMAT_VERSION || !(1..=SCHEMA_VERSION).contains(&schema) {
        return Err(CobaltError::Unsupported(format!(
            "archive uses format {version} and schema {schema}"
        )));
    }
    let data = read_bounded(archive.by_name(DATA).map_err(integrity)?, MAX_ARCHIVE)?;
    if checksums != BTreeMap::from([(DATA.into(), digest(&data))]) {
        return Err(integrity("archive checksum mismatch"));
    }
    let data: PortableData = serde_json::from_slice(&data)?;
    let actual = data.counts();
    if (backup && actual != counts)
        || actual.memories != counts.memories
        || actual.source_documents != counts.source_documents
    {
        return Err(integrity("archive manifest counts do not match contents"));
    }
    data.validate()?;
    Ok((schema, model, data))
}

impl Context {
    async fn dimensions(&self, model: &str) -> Result<u32> {
        if let Some(store) = &self.sqlite {
            return store.portable_embedding_dimensions().await;
        }
        Catalog::builtin()?
            .model(model)
            .map(|entry| entry.spec.dimensions)
            .ok_or_else(|| {
                CobaltError::Unsupported(format!(
                    "embedding dimensions are unavailable for {model}"
                ))
            })
    }

    async fn collect_portable(
        &self,
        capsule: Option<&CapsuleExportRequest>,
        history: bool,
    ) -> Result<PortableData> {
        let mut data = PortableData::default();
        let mut sources = HashSet::new();
        let mut wanted =
            capsule.map_or_else(HashSet::new, |req| req.memory_ids.iter().copied().collect());
        let selection = !wanted.is_empty();
        data.branches = self.store.list_branches().await?;
        let mut encrypted = 0;
        for branch in &data.branches {
            let graph = self
                .store
                .graph(GraphQuery {
                    branch_id: Some(branch.id),
                    include_archived: history || capsule.is_some(),
                    include_superseded: history,
                    min_edge_weight: Some(0.0),
                    limit: None,
                })
                .await?;
            for node in graph.nodes {
                if let Some(req) = capsule {
                    if req.project_id.is_some() && req.project_id != node.project_id {
                        continue;
                    }
                    if selection {
                        if !wanted.remove(&node.id) {
                            continue;
                        }
                    } else if !branch.is_active || node.project_id != req.project_id {
                        continue;
                    }
                }
                if node.is_encrypted {
                    encrypted += 1;
                    continue;
                }
                if let Some(row) = self.store.get_memory(node.id).await? {
                    sources.extend(row.source_doc_id);
                    data.memories.push(row);
                }
            }
            data.edges.extend(graph.edges);
        }
        if !wanted.is_empty() {
            return Err(CobaltError::NotFound(
                "some selected memories are outside the capsule scope".into(),
            ));
        }
        if encrypted > 0 {
            data.warnings.push(format!(
                "{encrypted} vault-encrypted memories require their original vault and were omitted"
            ));
        }
        if capsule.is_none()
            && let Some(store) = &self.sqlite
        {
            data.source_documents = store.portable_source_documents().await?;
        } else {
            for id in sources {
                if let Some(doc) = self.store.get_source_document(id).await? {
                    data.source_documents.push(doc);
                }
            }
            data.source_documents.sort_by_key(|doc| doc.id);
        }
        let project_ids: HashSet<_> = data
            .memories
            .iter()
            .filter_map(|row| row.project_id)
            .chain(
                data.source_documents
                    .iter()
                    .filter_map(|doc| doc.project_id),
            )
            .collect();
        data.projects = self
            .store
            .list_projects(true)
            .await?
            .into_iter()
            .map(|row| row.project)
            .filter(|project| {
                capsule.is_none()
                    || project_ids.contains(&project.id)
                    || capsule.and_then(|req| req.project_id) == Some(project.id)
            })
            .collect();
        if capsule.is_some() {
            data.branches
                .retain(|branch| data.memories.iter().any(|row| row.branch_id == branch.id));
        } else if history {
            if let Some(store) = &self.sqlite {
                data.handoffs = store.portable_handoffs().await?;
            }
            let mut offset = 0;
            loop {
                let page = self
                    .store
                    .query_telemetry(TelemetryQuery {
                        limit: Some(500),
                        offset: Some(offset),
                        ..Default::default()
                    })
                    .await?;
                let size = page.items.len() as u32;
                data.telemetry.extend(page.items);
                offset = offset.saturating_add(size);
                if size < 500 || u64::from(offset) >= page.total || offset == u32::MAX {
                    break;
                }
            }
            if !self.store.list_snapshots().await?.is_empty() {
                data.warnings
                    .push("Local SQLite snapshot files are excluded from portable backups".into());
            }
        }
        data.sanitize(self.global_ignore.as_deref(), false)?;
        Ok(data)
    }

    pub(crate) async fn export_capsule(
        &self,
        req: CapsuleExportRequest,
    ) -> Result<CapsuleManifest> {
        check_destination(&req.dest_path, CAPSULE_EXT)?;
        let _write = self.writes.lock().await;
        if let Some(project) = req.project_id
            && self.store.get_project(project).await?.is_none()
        {
            return Err(CobaltError::NotFound(format!("project {project}")));
        }
        let data = self.collect_portable(Some(&req), false).await?;
        let model = self.store.load_settings().await?.embedding_model_id;
        let dimensions = self.dimensions(&model).await?;
        blocking(move || {
            let (bytes, checksums) = entries(&data)?;
            let manifest = CapsuleManifest {
                format_version: TRANSFER_FORMAT_VERSION,
                schema_version: SCHEMA_VERSION,
                app_version: env!("CARGO_PKG_VERSION").into(),
                created_at: now(),
                project: data
                    .projects
                    .into_iter()
                    .find(|project| Some(project.id) == req.project_id),
                memory_count: data.memories.len() as u64,
                source_document_count: data.source_documents.len() as u64,
                embedding_model_id: model,
                dimensions,
                checksums,
            };
            write_archive(&req.dest_path, serde_json::to_vec(&manifest)?, bytes, None)?;
            Ok(manifest)
        })
        .await
    }

    pub(crate) async fn export_backup(&self, req: BackupExportRequest) -> Result<BackupManifest> {
        check_destination(&req.dest_path, BACKUP_EXT)?;
        let _write = self.writes.lock().await;
        let data = self.collect_portable(None, req.include_history).await?;
        let settings = self.store.load_settings().await?;
        let dimensions = self.dimensions(&settings.embedding_model_id).await?;
        let theme_ids = self
            .store
            .list_installed_themes()
            .await?
            .into_iter()
            .map(|theme| theme.id)
            .collect();
        blocking(move || {
            let (bytes, checksums) = entries(&data)?;
            let manifest = BackupManifest {
                format_version: TRANSFER_FORMAT_VERSION,
                schema_version: SCHEMA_VERSION,
                app_version: env!("CARGO_PKG_VERSION").into(),
                created_at: now(),
                source_os: std::env::consts::OS.into(),
                embedding_model_id: settings.embedding_model_id,
                dimensions,
                vector_engine: settings.vector_engine.to_string(),
                encrypted: req.password.is_some(),
                counts: data.counts(),
                checksums,
                theme_ids,
            };
            write_archive(
                &req.dest_path,
                serde_json::to_vec(&manifest)?,
                bytes,
                req.password.as_deref(),
            )?;
            Ok(manifest)
        })
        .await
    }

    pub(crate) async fn import_package(
        &self,
        path: String,
        password: Option<String>,
        backup: bool,
    ) -> Result<ImportReport> {
        let _write = self.writes.lock().await;
        let settings = self.store.load_settings().await?;
        if settings.read_only {
            return Err(CobaltError::ReadOnly);
        }
        let global = self.global_ignore.clone();
        let max = settings.firewall.max_tokens_per_memory as usize;
        let tokens = self.tokens.clone();
        let (schema_version, model, mut data) = blocking(move || {
            let (schema_version, model, mut data) =
                read_archive(&path, password.as_deref(), backup)?;
            data.sanitize(global.as_deref(), true)?;
            let mut skipped = 0;
            data.memories.retain(|row| {
                let accepted = tokens.count(&row.content) <= max
                    && !cobalt_core::firewall::looks_like_log_dump(&row.content);
                skipped += usize::from(!accepted);
                accepted
            });
            if skipped > 0 {
                data.warnings.push(format!(
                    "{skipped} imported memories exceeded content limits"
                ));
            }
            Ok((schema_version, model, data))
        })
        .await?;
        let active = self.store.active_branch().await?.id;
        let mut report = ImportReport {
            warnings: std::mem::take(&mut data.warnings),
            ..Default::default()
        };
        if self.sqlite.is_none() {
            report.warnings.push("Generic store import assigns new IDs and supports active memories only; use the SQLite constructor to retain portable history".into());
        }
        let projects = self.import_projects(data.projects, &mut report).await?;
        let sources = self
            .import_sources(data.source_documents, &projects)
            .await?;
        let branches = if backup {
            self.import_branches(data.branches, active).await?
        } else {
            HashMap::new()
        };
        let mut state = ImportState {
            context: self,
            active,
            report,
            remapped: HashMap::new(),
            review: None,
            reembed: model != settings.embedding_model_id,
        };
        let mut versions = Vec::new();
        let mut collisions = HashSet::new();
        let threshold = if self.sqlite.is_some() {
            settings.search.import_collision_threshold
        } else {
            settings
                .search
                .import_collision_threshold
                .min(settings.search.dedup_threshold)
        };
        data.memories.sort_by_key(|row| (row.updated_at, row.id));
        for row in &mut data.memories {
            let origin = row.id;
            versions.extend(row.superseded_by.take().map(|next| (origin, next)));
            row.project_id = row.project_id.and_then(|id| projects.get(&id).copied());
            row.source_doc_id = row.source_doc_id.and_then(|id| sources.get(&id).copied());
            row.branch_id = branches.get(&row.branch_id).copied().unwrap_or(active);
            if row.status != MemoryStatus::Active || self.store.get_memory(origin).await?.is_some()
            {
                continue;
            }
            let collides = if row.branch_id == active {
                self.store
                    .find_similar(&row.content, row.project_id, threshold)
                    .await?
                    .is_some_and(|(matched, score)| {
                        score > threshold && matched.content_hash != row.content_hash
                    })
            } else if let Some(store) = &self.sqlite {
                if let Some((id, score)) = store
                    .find_import_collision(&row.content, row.project_id, Some(row.branch_id))
                    .await?
                {
                    score > threshold
                        && self
                            .store
                            .get_memory(id)
                            .await?
                            .is_some_and(|matched| matched.content_hash != row.content_hash)
                } else {
                    false
                }
            } else {
                false
            };
            if collides {
                collisions.insert(origin);
            }
        }
        for row in data.memories {
            let isolate = collisions.contains(&row.id);
            state.import_memory(row, isolate).await?;
        }
        if let Some(store) = &self.sqlite {
            let edges = data
                .edges
                .into_iter()
                .filter_map(|mut edge| {
                    edge.source_id = *state.remapped.get(&edge.source_id)?;
                    edge.target_id = *state.remapped.get(&edge.target_id)?;
                    Some(edge)
                })
                .collect();
            let versions = versions
                .into_iter()
                .filter_map(|(id, next)| {
                    let id = *state.remapped.get(&id)?;
                    let next = *state.remapped.get(&next)?;
                    (id != next).then_some((id, next))
                })
                .collect();
            for row in &mut data.handoffs {
                row.project_id = row.project_id.and_then(|id| projects.get(&id).copied());
            }
            for log in &mut data.telemetry {
                log.project_id = log.project_id.and_then(|id| projects.get(&id).copied());
                log.returned_items.retain_mut(|item| {
                    let Some(id) = state.remapped.get(&item.memory_id) else {
                        return false;
                    };
                    item.memory_id = *id;
                    item.source_doc_id =
                        item.source_doc_id.and_then(|id| sources.get(&id).copied());
                    true
                });
            }
            if backup {
                store
                    .insert_portable_history_for_schema(
                        schema_version,
                        edges,
                        versions,
                        data.handoffs,
                        data.telemetry,
                    )
                    .await?;
            } else {
                store
                    .insert_portable_history(edges, versions, data.handoffs, data.telemetry)
                    .await?;
            }
        }
        Ok(state.report)
    }

    async fn import_projects(
        &self,
        rows: Vec<Project>,
        report: &mut ImportReport,
    ) -> Result<HashMap<Id, Id>> {
        let mut mapped = HashMap::new();
        for project in rows {
            if let Some(local) = self.store.get_project(project.id).await? {
                mapped.insert(project.id, local.id);
                continue;
            }
            if let Some(local) = self.store.find_project_by_name(&project.name).await? {
                mapped.insert(project.id, local.id);
                continue;
            }
            // A path on the source machine may denote an unrelated local directory.
            let local = self
                .store
                .create_project(NewProject {
                    name: project.name,
                    root_path: None,
                    color_hex: Some(project.color_hex),
                })
                .await?;
            if project.is_archived {
                self.store
                    .update_project(
                        local.id,
                        ProjectPatch {
                            is_archived: Some(true),
                            ..Default::default()
                        },
                    )
                    .await?;
            }
            mapped.insert(project.id, local.id);
            report.projects_created += 1;
        }
        Ok(mapped)
    }

    async fn import_sources(
        &self,
        rows: Vec<SourceDocument>,
        projects: &HashMap<Id, Id>,
    ) -> Result<HashMap<Id, Id>> {
        let mut mapped = HashMap::new();
        for doc in rows {
            let project_id = doc.project_id.and_then(|id| projects.get(&id).copied());
            let local = match self
                .store
                .find_source_document_by_path(&doc.file_path)
                .await?
            {
                Some(local)
                    if local.project_id == project_id && local.file_hash == doc.file_hash =>
                {
                    local
                }
                Some(_) => continue,
                None => {
                    self.store
                        .upsert_source_document(NewSourceDocument {
                            project_id,
                            file_path: doc.file_path,
                            is_dir: doc.is_dir,
                            source_type: Some(doc.source_type),
                            file_hash: doc.file_hash,
                            total_tokens: doc.total_tokens,
                            is_watched: false,
                        })
                        .await?
                }
            };
            if local.project_id == project_id {
                mapped.insert(doc.id, local.id);
            }
        }
        Ok(mapped)
    }

    async fn import_branches(&self, rows: Vec<Branch>, active: Id) -> Result<HashMap<Id, Id>> {
        let local = self.store.list_branches().await?;
        let mut mapped = HashMap::from([(MAIN_BRANCH_ID, MAIN_BRANCH_ID)]);
        let mut pending: Vec<_> = rows
            .into_iter()
            .filter(|row| row.id != MAIN_BRANCH_ID)
            .collect();
        while !pending.is_empty() {
            let idx = pending
                .iter()
                .position(|row| {
                    row.parent_branch_id
                        .is_none_or(|id| mapped.contains_key(&id))
                })
                .unwrap_or(0);
            let row = pending.remove(idx);
            let id = if let Some(branch) = local
                .iter()
                .find(|branch| branch.id == row.id || branch.name == row.name)
            {
                branch.id
            } else {
                self.store
                    .create_branch(NewBranch {
                        name: row.name,
                        parent_branch_id: row
                            .parent_branch_id
                            .and_then(|id| mapped.get(&id).copied())
                            .or(Some(active)),
                    })
                    .await?
                    .id
            };
            mapped.insert(row.id, id);
        }
        Ok(mapped)
    }
}

struct ImportState<'a> {
    context: &'a Context,
    active: Id,
    report: ImportReport,
    remapped: HashMap<Id, Id>,
    review: Option<Id>,
    reembed: bool,
}

impl ImportState<'_> {
    async fn review_branch(&mut self) -> Result<Id> {
        if let Some(id) = self.review {
            return Ok(id);
        }
        let name = format!("import-{}", now().date_naive());
        let store = &self.context.store;
        let existing = store
            .list_branches()
            .await?
            .into_iter()
            .find(|branch| branch.name == name);
        let branch = match existing {
            Some(branch) => branch,
            None => {
                store
                    .create_branch(NewBranch {
                        name,
                        parent_branch_id: Some(self.active),
                    })
                    .await?
            }
        };
        self.review = Some(branch.id);
        self.report.review_branch = Some(branch.name);
        Ok(branch.id)
    }

    async fn import_memory(&mut self, mut row: Memory, mut isolate: bool) -> Result<()> {
        let original = row.id;
        let store = &self.context.store;
        let local = store.get_memory(original).await?;
        if local
            .as_ref()
            .is_some_and(|local| local.content_hash == row.content_hash)
        {
            self.report.skipped_identical += 1;
            self.remapped.insert(original, original);
            return Ok(());
        }
        let mut previous = None;
        if let Some(local) = local {
            row.id = version_id(&row);
            if let Some(existing) = store.get_memory(row.id).await? {
                if existing.content_hash != row.content_hash {
                    return Err(integrity("portable version UUID collision"));
                }
                self.report.skipped_identical += 1;
                self.remapped.insert(original, row.id);
                return Ok(());
            }
            let local = if local.status == MemoryStatus::Superseded {
                store
                    .memory_history(local.id)
                    .await?
                    .into_iter()
                    .find(|entry| {
                        entry.superseded_by.is_none() && entry.status != MemoryStatus::Superseded
                    })
                    .unwrap_or(local)
            } else {
                local
            };
            if local.content_hash == row.content_hash {
                self.report.skipped_identical += 1;
                self.remapped.insert(original, local.id);
                return Ok(());
            }
            if local.is_encrypted
                || local.branch_id != row.branch_id
                || local.project_id != row.project_id
                || local.updated_at == row.updated_at
            {
                isolate = true;
            } else if local.updated_at < row.updated_at && local.status != MemoryStatus::Superseded
            {
                previous = Some((local.id, local.updated_at));
                row.is_core_pin |= local.is_core_pin;
            } else if local.status == MemoryStatus::Superseded {
                isolate = true;
            } else {
                row.status = MemoryStatus::Superseded;
                row.version_reason = Some("Superseded by newer local memory".into());
                row.superseded_by = Some(local.id);
            }
        }
        if isolate {
            row.branch_id = self.review_branch().await?;
        }

        let mut superseded = previous.is_some();
        let next = row.superseded_by;
        let id = if let Some(sqlite) = &self.context.sqlite {
            let id = row.id;
            if !sqlite.insert_portable_memory(row, previous).await? {
                self.report.skipped_identical += 1;
                self.remapped.insert(original, id);
                return Ok(());
            }
            superseded |= next.is_some();
            id
        } else {
            if row.status == MemoryStatus::Superseded {
                return Ok(());
            }
            let saved = if let Some((id, _)) = previous {
                store
                    .update_memory(UpdateMemoryRequest {
                        memory_id: id,
                        new_content: row.content,
                        confidence: Some(row.confidence),
                        reason: "Superseded by newer imported memory".into(),
                        source_client: Some(IMPORT_CLIENT.into()),
                    })
                    .await?
            } else {
                // A general-purpose repository applies Check-Before-Write to this input.
                store
                    .save_memory(NewMemory {
                        content: row.content,
                        category: row.category,
                        project_id: row.project_id,
                        branch_id: Some(row.branch_id),
                        source_doc_id: row.source_doc_id,
                        source_type: Some(row.source_type),
                        confidence: Some(row.confidence),
                        is_core_pin: row.is_core_pin,
                        is_reusable: row.is_reusable,
                        reusable_snippet: row.reusable_snippet,
                        source_client: Some(IMPORT_CLIENT.into()),
                    })
                    .await?
            };
            if matches!(
                saved.action,
                WriteAction::Duplicate | WriteAction::UpdatedExisting
            ) {
                self.remapped.insert(original, saved.memory.id);
                return Ok(());
            }
            if row.status == MemoryStatus::Archived && !row.is_core_pin {
                store
                    .patch_memory(
                        saved.memory.id,
                        MemoryPatch {
                            status: Some(row.status),
                            ..Default::default()
                        },
                    )
                    .await?;
            }
            saved.memory.id
        };
        self.remapped.insert(original, id);
        self.report.inserted += 1;
        self.report.superseded += u64::from(superseded);
        self.report.isolated += u64::from(isolate);
        self.report.reembedded += u64::from(self.reembed);
        Ok(())
    }
}

fn version_id(row: &Memory) -> Id {
    let mut hash = Sha256::new();
    hash.update(row.id.as_bytes());
    hash.update(row.content_hash.as_bytes());
    hash.update(timestamp_to_sql(&row.updated_at).as_bytes());
    let digest = hash.finalize();
    let mut id = *row.id.as_bytes();
    id[6..].copy_from_slice(&digest[..10]);
    id[6] = (id[6] & 0x0f) | 0x70;
    id[8] = (id[8] & 0x3f) | 0x80;
    Id::from_bytes(id)
}

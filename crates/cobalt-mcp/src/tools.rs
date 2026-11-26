//! The 7 MCP tools (`docs/MCP_SPEC.md` §2): docstrings, JSON input schemas and handlers.
//! Every handler applies the same pipeline: read-only check (writes) → Secret Scrubber →
//! Token Firewall → store → telemetry → live `cobalt://mcp-activity` event.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use cobalt_core::enums::{MemoryChangeKind, SourceType, TelemetryOperation};
use cobalt_core::error::{CobaltError, Result};
use cobalt_core::firewall::FirewallVerdict;
use cobalt_core::ids::Id;
use cobalt_core::mcp::*;
use cobalt_core::memoryignore::MemoryIgnore;
use cobalt_core::model::{
    Memory, MemoryChanged, NewHandoff, NewMemory, NewSourceDocument, UpdateMemoryRequest,
};
use cobalt_core::scrubber::scrub;
use cobalt_core::search::{ReusableAssetQuery, SearchFilter, SearchRequest, TokenSavings};
use cobalt_core::telemetry::{
    MatchedNode, McpActivity, NewTelemetryEvent, ReturnedItem, TelemetryLog,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::daemon::Daemon;
use crate::project::{ClientContext, Resolved};
use crate::render;

/// Max file size hashed/tokenized when linking `original_file_path`.
const MAX_LINKED_FILE_BYTES: u64 = 8 * 1024 * 1024;

pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub read_only: bool,
}

pub const TOOLS: [ToolSpec; 7] = [
    ToolSpec {
        name: TOOL_SEARCH_MEMORY,
        read_only: true,
        description: "Search the user's persistent memory (shared by all their AI tools) BEFORE reading large files, re-asking for context, or re-deriving past decisions. Runs hybrid semantic + exact-text search (vector + BM25, fused with RRF) over the current project and global memories. Returns atomic facts with confidence scores, the project's Nuclear Laws (always obey them), and token-savings metrics. Use precise queries: identifiers, error messages, component names, or the decision you need.",
    },
    ToolSpec {
        name: TOOL_SEARCH_REUSABLE_ASSETS,
        read_only: true,
        description: "Call BEFORE writing boilerplate, utilities, auth/config modules, schemas, or reusable components from scratch. Returns a compact ~50-token interface summary, origin project, verified local file path from `source_documents` if still on disk (or fallback snippet), so you can copy and adapt instead of regenerating.",
    },
    ToolSpec {
        name: TOOL_SAVE_MEMORY,
        read_only: false,
        description: "Save a durable, atomic memory WITHOUT being asked whenever you: make or learn an architecture decision, fix a non-trivial bug (root cause + fix), learn a user preference or convention, or create a reusable piece of code (set is_reusable=true and original_file_path). Write 1–4 lines as \"Context -> Decision -> Reason\". Never save raw logs, full files, stack traces or secrets (they are redacted anyway). Near-duplicates are merged or versioned automatically, so do not search first just to avoid duplicates.",
    },
    ToolSpec {
        name: TOOL_UPDATE_MEMORY,
        read_only: false,
        description: "Replace a memory that is outdated or wrong (e.g. a decision was reversed, an API changed). Creates a new version, marks the old one as superseded and records your reason, keeping history. Use the memory_id returned by search_memory.",
    },
    ToolSpec {
        name: TOOL_CREATE_HANDOFF,
        read_only: false,
        description: "Leave a short-lived baton for the next AI session when you stop mid-task (context limit, switching tools, end of day). Summarize current state, next step, last error and open files in under 250 tokens. Handoffs expire and never pollute permanent memory.",
    },
    ToolSpec {
        name: TOOL_RESUME_HANDOFF,
        read_only: true,
        description: "When the user asks to continue, resume, or pick up where they (or another AI) left off, call this first to get the latest active handoff for the project: summary, next step, last error and open files.",
    },
    ToolSpec {
        name: TOOL_LIST_PROJECT_RULES,
        read_only: true,
        description: "Call once at the start of every session (and after switching projects) to load the user's Nuclear Laws and stable preferences for this project plus global ones. These rules override your defaults; follow them for the whole session.",
    },
];

const SOURCE_TYPES: [&str; 18] = [
    "md",
    "sql",
    "bash",
    "rs",
    "ts",
    "js",
    "py",
    "java",
    "json",
    "yaml",
    "toml",
    "html",
    "css",
    "dockerfile",
    "pdf",
    "image",
    "note",
    "other",
];

fn project_prop() -> Value {
    json!({ "type": "string", "description": "Project name or absolute path. Omit to auto-detect from the workspace." })
}

/// JSON Schema of each tool input (MCP_SPEC §2).
pub fn input_schema(name: &str) -> Value {
    match name {
        TOOL_SEARCH_MEMORY => json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "minLength": 1, "description": "What you need to know: identifiers, error text, topic or question." },
                "project": project_prop(),
                "include_archived": { "type": "boolean", "default": false, "description": "Also search archived (decayed) memories." },
                "top_k": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Max results (default from settings, usually 8)." }
            },
            "required": ["query"], "additionalProperties": false
        }),
        TOOL_SEARCH_REUSABLE_ASSETS => json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "minLength": 1, "description": "What you are about to build, e.g. 'JWT refresh middleware axum'." },
                "source_type": { "type": "string", "enum": SOURCE_TYPES, "description": "Restrict to one language/file kind." },
                "exclude_current_project": { "type": "boolean", "default": false, "description": "Only look in OTHER projects." },
                "top_k": { "type": "integer", "minimum": 1, "maximum": 20, "description": "Max assets (default 5)." }
            },
            "required": ["query"], "additionalProperties": false
        }),
        TOOL_SAVE_MEMORY => json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "minLength": 1, "description": "Atomic summary, max ~4 lines: Context -> Decision -> Reason." },
                "category": { "type": "string", "enum": ["preference","decision","code","doc","note","ocr"] },
                "project": { "type": "string", "description": "Project name or absolute path. Omit to auto-detect; use 'global' for cross-project facts." },
                "original_file_path": { "type": "string", "description": "Absolute path of the file this memory describes (links it as a source document)." },
                "source_type": { "type": "string", "enum": SOURCE_TYPES, "description": "Inferred from original_file_path when omitted." },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1, "default": 1.0, "description": "How certain this fact is." },
                "is_reusable": { "type": "boolean", "default": false, "description": "True for reusable code/config/schemas worth copying into other projects." },
                "reusable_snippet": { "type": "string", "description": "Compact fallback snippet (interface/signature) in case the file moves." }
            },
            "required": ["content", "category"], "additionalProperties": false
        }),
        TOOL_UPDATE_MEMORY => json!({
            "type": "object",
            "properties": {
                "memory_id": { "type": "string", "format": "uuid" },
                "new_content": { "type": "string", "minLength": 1, "description": "Corrected atomic summary (Context -> Decision -> Reason)." },
                "reason": { "type": "string", "minLength": 1, "description": "Why the previous version is obsolete." },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
            },
            "required": ["memory_id", "new_content", "reason"], "additionalProperties": false
        }),
        TOOL_CREATE_HANDOFF => json!({
            "type": "object",
            "properties": {
                "summary": { "type": "string", "minLength": 1, "description": "State + next step, < 250 tokens." },
                "last_error": { "type": "string", "description": "Last blocking error, if any (trimmed)." },
                "open_files": { "type": "array", "items": { "type": "string" }, "maxItems": 30 },
                "project": project_prop()
            },
            "required": ["summary"], "additionalProperties": false
        }),
        TOOL_RESUME_HANDOFF | TOOL_LIST_PROJECT_RULES => json!({
            "type": "object",
            "properties": { "project": project_prop() },
            "additionalProperties": false
        }),
        _ => json!({ "type": "object" }),
    }
}

/// Result of a tool: token-lean text for the model + structured output.
pub struct ToolOutput {
    pub text: String,
    pub structured: Value,
}

fn parse<T: DeserializeOwned>(args: Value) -> Result<T> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args)
        .map_err(|e| CobaltError::InvalidInput(format!("invalid arguments: {e}")))
}

fn structured<T: Serialize>(text: String, value: &T) -> Result<ToolOutput> {
    Ok(ToolOutput {
        text,
        structured: serde_json::to_value(value)?,
    })
}

impl Daemon {
    /// Dispatches a `tools/call`.
    pub async fn call_tool(
        &self,
        name: &str,
        args: Value,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        match name {
            TOOL_SEARCH_MEMORY => self.tool_search_memory(parse(args)?, ctx).await,
            TOOL_SEARCH_REUSABLE_ASSETS => self.tool_search_reusable(parse(args)?, ctx).await,
            TOOL_SAVE_MEMORY => self.tool_save_memory(parse(args)?, ctx).await,
            TOOL_UPDATE_MEMORY => self.tool_update_memory(parse(args)?, ctx).await,
            TOOL_CREATE_HANDOFF => self.tool_create_handoff(parse(args)?, ctx).await,
            TOOL_RESUME_HANDOFF => self.tool_resume_handoff(parse(args)?, ctx).await,
            TOOL_LIST_PROJECT_RULES => self.tool_list_project_rules(parse(args)?, ctx).await,
            other => Err(CobaltError::NotFound(format!("tool '{other}'"))),
        }
    }

    /// Tool description, honoring Pro-mode docstring overrides.
    pub fn tool_description(&self, spec: &ToolSpec) -> String {
        self.config
            .get()
            .mcp
            .tool_docstring_overrides
            .get(spec.name)
            .cloned()
            .unwrap_or_else(|| spec.description.to_owned())
    }

    // -------------------------------------------------------------------- helpers

    fn guard_read(&self, ctx: &ClientContext) -> Result<()> {
        if let FirewallVerdict::Blocked { detail, .. } = self.firewall.check_read(&ctx.client_name)
        {
            return Err(self.blocked(ctx, None, &detail));
        }
        Ok(())
    }

    fn guard_writable(&self) -> Result<()> {
        if self.is_read_only() {
            Err(CobaltError::ReadOnly)
        } else {
            Ok(())
        }
    }

    /// Records a `blocked_firewall` event (fire-and-forget) and returns the error to report.
    fn blocked(&self, ctx: &ClientContext, query: Option<String>, detail: &str) -> CobaltError {
        self.emit_firewall_blocked(&ctx.client_name, detail);
        let event = NewTelemetryEvent {
            client_name: ctx.client_name.clone(),
            operation: TelemetryOperation::BlockedFirewall,
            query_text: query,
            returned_items: Vec::new(),
            injected_tokens: 0,
            output_tokens_saved: 0,
            latency_ms: 0,
            project_id: None,
        };
        let store = self.store().clone();
        tokio::spawn(async move {
            if let Err(err) = store.record_event(event).await {
                tracing::warn!(%err, "failed to record firewall telemetry");
            }
        });
        CobaltError::FirewallBlocked(detail.to_owned())
    }

    /// Scrubs + firewalls content; returns (clean content, redacted count, truncated).
    fn sanitize_write(&self, ctx: &ClientContext, content: &str) -> Result<(String, u32, bool)> {
        let scrubbed = scrub(content);
        let redacted = scrubbed.count();
        match self.firewall.check_write(&ctx.client_name, &scrubbed.text) {
            FirewallVerdict::Allow => Ok((scrubbed.text, redacted, false)),
            FirewallVerdict::Truncated { content, .. } => Ok((content, redacted, true)),
            FirewallVerdict::Blocked { detail, .. } => {
                Err(self.blocked(ctx, Some(preview(&scrubbed.text, 120)), &detail))
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn record(
        &self,
        ctx: &ClientContext,
        operation: TelemetryOperation,
        query_text: Option<String>,
        returned_items: Vec<ReturnedItem>,
        injected_tokens: i64,
        output_tokens_saved: i64,
        started: Instant,
        project_id: Option<Id>,
    ) -> Result<TelemetryLog> {
        let latency_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
        let log = self
            .store()
            .record_event(NewTelemetryEvent {
                client_name: ctx.client_name.clone(),
                operation,
                query_text,
                returned_items,
                injected_tokens,
                output_tokens_saved,
                latency_ms,
                project_id,
            })
            .await?;
        self.emit_activity(McpActivity {
            log_id: log.id,
            timestamp: log.timestamp,
            client_name: log.client_name.clone(),
            operation: log.operation,
            query_text: log.query_text.clone(),
            matched_nodes: log
                .returned_items
                .iter()
                .map(|i| MatchedNode {
                    memory_id: i.memory_id,
                    similarity_score: i.similarity_score,
                })
                .collect(),
            injected_tokens: log.injected_tokens,
            avoided_full_tokens: log.avoided_full_tokens,
            saved_tokens: log.saved_tokens,
            latency_ms: log.latency_ms,
            is_replay: false,
        });
        Ok(log)
    }

    fn count(&self, text: &str) -> i64 {
        i64::try_from(self.tokens.count(text)).unwrap_or(i64::MAX)
    }

    async fn project_names(&self) -> Result<HashMap<Id, String>> {
        Ok(self
            .store()
            .list_projects(true)
            .await?
            .into_iter()
            .map(|p| (p.project.id, p.project.name))
            .collect())
    }

    async fn compact(
        &self,
        memories: Vec<(Memory, Option<f64>)>,
        names: &HashMap<Id, String>,
    ) -> Result<Vec<CompactMemory>> {
        let mut paths: HashMap<Id, Option<String>> = HashMap::new();
        let mut out = Vec::with_capacity(memories.len());
        for (m, similarity) in memories {
            let file_path = match m.source_doc_id {
                Some(doc_id) => {
                    if let std::collections::hash_map::Entry::Vacant(e) = paths.entry(doc_id) {
                        let doc = self.store().get_source_document(doc_id).await?;
                        e.insert(doc.map(|d| d.file_path));
                    }
                    paths.get(&doc_id).cloned().flatten()
                }
                None => None,
            };
            out.push(CompactMemory {
                id: m.id,
                content: m.content,
                category: m.category,
                source_type: m.source_type,
                confidence: m.confidence,
                similarity,
                project: m.project_id.and_then(|p| names.get(&p).cloned()),
                is_core_pin: m.is_core_pin,
                is_reusable: m.is_reusable,
                file_path,
                updated_at: m.updated_at,
            });
        }
        Ok(out)
    }

    /// Links (or creates) the source document for `path`, honoring `.memoryignore`.
    async fn link_source_document(
        &self,
        path: &str,
        resolved: &Resolved,
        source_type: Option<SourceType>,
    ) -> Result<Id> {
        let p = Path::new(path);
        if !p.is_absolute() {
            return Err(CobaltError::InvalidInput(
                "original_file_path must be absolute".into(),
            ));
        }
        let root = resolved.root_path().map(Path::new).or_else(|| p.parent());
        if let Some(root) = root {
            let ignore = MemoryIgnore::for_root(root, Some(&self.home))?;
            if ignore.is_ignored(p, false) {
                return Err(CobaltError::InvalidInput(format!(
                    "{path} is excluded by .memoryignore; save a summary without original_file_path"
                )));
            }
        }
        if let Some(doc) = self.store().find_source_document_by_path(path).await? {
            return Ok(doc.id);
        }
        let (hash, total_tokens) = match tokio::fs::metadata(p).await {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_LINKED_FILE_BYTES => {
                let bytes = tokio::fs::read(p).await?;
                let hash = hex::encode(Sha256::digest(&bytes));
                let tokens = std::str::from_utf8(&bytes)
                    .map(|t| self.count(t))
                    .unwrap_or(0);
                (Some(hash), tokens)
            }
            _ => (None, 0),
        };
        let doc = self
            .store()
            .upsert_source_document(NewSourceDocument {
                project_id: resolved.project_id(),
                file_path: path.to_owned(),
                is_dir: p.is_dir(),
                source_type: source_type.or_else(|| Some(SourceType::from_path(p))),
                file_hash: hash,
                total_tokens,
                is_watched: false,
            })
            .await?;
        Ok(doc.id)
    }

    // -------------------------------------------------------------------- tools

    async fn tool_search_memory(
        &self,
        args: SearchMemoryArgs,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        let started = Instant::now();
        self.guard_read(ctx)?;
        let resolved = self.resolve_project(args.project.as_deref(), ctx).await?;
        let response = self
            .store()
            .search(SearchRequest {
                query: args.query.clone(),
                scope: resolved.scope(),
                branch_id: None,
                top_k: args.top_k.map(|k| k.clamp(1, MAX_TOP_K)),
                include_archived: args.include_archived.unwrap_or(false),
                filter: SearchFilter::default(),
                rrf_override: None,
                record_hits: true,
            })
            .await?;
        let names = self.project_names().await?;
        let items: Vec<ReturnedItem> = response
            .hits
            .iter()
            .map(|h| ReturnedItem {
                memory_id: h.memory.id,
                source_doc_id: h.memory.source_doc_id,
                similarity_score: h.similarity_score,
                chunk_tokens: h.memory.chunk_tokens,
                content_snapshot: Some(h.memory.content.clone()),
            })
            .collect();
        let core_rules = self
            .compact(
                response.core_rules.into_iter().map(|m| (m, None)).collect(),
                &names,
            )
            .await?;
        let results = self
            .compact(
                response
                    .hits
                    .into_iter()
                    .map(|h| (h.memory, Some(h.similarity_score)))
                    .collect(),
                &names,
            )
            .await?;
        let mut output = SearchMemoryOutput {
            project: resolved.to_output(),
            core_rules,
            results,
            savings: TokenSavings::default(),
        };
        let injected = self.count(&render::search_memory(&output));
        let log = self
            .record(
                ctx,
                TelemetryOperation::Read,
                Some(args.query),
                items,
                injected,
                0,
                started,
                resolved.project_id(),
            )
            .await?;
        output.savings = savings_of(&log);
        structured(render::search_memory(&output), &output)
    }

    async fn tool_search_reusable(
        &self,
        args: SearchReusableAssetsArgs,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        let started = Instant::now();
        self.guard_read(ctx)?;
        let resolved = self.resolve_project(None, ctx).await?;
        let assets = self
            .store()
            .search_reusable(ReusableAssetQuery {
                query: args.query.clone(),
                source_type: args.source_type,
                current_project_id: resolved.project_id(),
                exclude_current_project: args.exclude_current_project.unwrap_or(false),
                top_k: Some(args.top_k.unwrap_or(5).clamp(1, 20)),
                record_reuse: true,
            })
            .await?;
        let items = assets
            .iter()
            .map(|a| ReturnedItem {
                memory_id: a.memory_id,
                source_doc_id: a.source_doc_id,
                similarity_score: a.similarity_score,
                chunk_tokens: self.count(&a.summary),
                content_snapshot: Some(a.summary.clone()),
            })
            .collect();
        let output_saved: i64 = assets.iter().map(|a| a.output_tokens_saved).sum();
        let mut output = SearchReusableAssetsOutput {
            assets,
            savings: TokenSavings::default(),
        };
        let injected = self.count(&render::reusable_assets(&output));
        let log = self
            .record(
                ctx,
                TelemetryOperation::Reuse,
                Some(args.query),
                items,
                injected,
                output_saved,
                started,
                resolved.project_id(),
            )
            .await?;
        output.savings = savings_of(&log);
        structured(render::reusable_assets(&output), &output)
    }

    async fn tool_save_memory(
        &self,
        args: SaveMemoryArgs,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        let started = Instant::now();
        self.guard_writable()?;
        let (content, mut redacted, truncated) = self.sanitize_write(ctx, &args.content)?;
        let snippet = args.reusable_snippet.as_deref().map(|s| {
            let out = scrub(s);
            redacted += out.count();
            out.text
        });
        let resolved = self.resolve_project(args.project.as_deref(), ctx).await?;
        let source_doc_id = match args.original_file_path.as_deref() {
            Some(path) => Some(
                self.link_source_document(path, &resolved, args.source_type)
                    .await?,
            ),
            None => None,
        };
        let outcome = {
            let _slot = self.write_slot().await;
            self.store()
                .save_memory(NewMemory {
                    content,
                    category: args.category,
                    project_id: resolved.project_id(),
                    branch_id: None,
                    source_doc_id,
                    source_type: args.source_type,
                    confidence: args.confidence,
                    is_core_pin: false,
                    is_reusable: args.is_reusable.unwrap_or(false),
                    reusable_snippet: snippet,
                    source_client: Some(ctx.client_name.clone()),
                })
                .await?
        };
        let m = &outcome.memory;
        let item = ReturnedItem {
            memory_id: m.id,
            source_doc_id: m.source_doc_id,
            similarity_score: outcome.matched_similarity.unwrap_or(1.0),
            chunk_tokens: m.chunk_tokens,
            content_snapshot: Some(m.content.clone()),
        };
        let output = SaveMemoryOutput {
            memory_id: m.id,
            action: outcome.action,
            previous_id: outcome.previous_id,
            project: resolved.to_output(),
            redacted_secrets: outcome.redacted_secrets.max(redacted),
            truncated: truncated || outcome.truncated,
        };
        let text = render::save_memory(&output);
        let injected = self.count(&text);
        self.record(
            ctx,
            TelemetryOperation::Write,
            None,
            vec![item],
            injected,
            0,
            started,
            resolved.project_id(),
        )
        .await?;
        self.emit_memory_changed(MemoryChanged {
            kind: change_kind(outcome.action),
            memory_ids: std::iter::once(m.id).chain(outcome.previous_id).collect(),
            source_client: Some(ctx.client_name.clone()),
        });
        structured(text, &output)
    }

    async fn tool_update_memory(
        &self,
        args: UpdateMemoryArgs,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        let started = Instant::now();
        self.guard_writable()?;
        let existing = self
            .store()
            .get_memory(args.memory_id)
            .await?
            .ok_or_else(|| CobaltError::NotFound(format!("memory {}", args.memory_id)))?;
        if existing.is_core_pin {
            return Err(CobaltError::Conflict(
                "Nuclear Laws can only be changed from the Cobalt app".into(),
            ));
        }
        let (content, redacted, _) = self.sanitize_write(ctx, &args.new_content)?;
        let reason = scrub(&args.reason).text;
        let outcome = {
            let _slot = self.write_slot().await;
            self.store()
                .update_memory(UpdateMemoryRequest {
                    memory_id: args.memory_id,
                    new_content: content,
                    reason,
                    confidence: args.confidence,
                    source_client: Some(ctx.client_name.clone()),
                })
                .await?
        };
        let m = &outcome.memory;
        let output = UpdateMemoryOutput {
            memory_id: m.id,
            previous_id: outcome.previous_id.unwrap_or(args.memory_id),
            redacted_secrets: outcome.redacted_secrets.max(redacted),
        };
        let text = render::update_memory(&output);
        let item = ReturnedItem {
            memory_id: m.id,
            source_doc_id: m.source_doc_id,
            similarity_score: 1.0,
            chunk_tokens: m.chunk_tokens,
            content_snapshot: Some(m.content.clone()),
        };
        let injected = self.count(&text);
        self.record(
            ctx,
            TelemetryOperation::Update,
            None,
            vec![item],
            injected,
            0,
            started,
            m.project_id,
        )
        .await?;
        self.emit_memory_changed(MemoryChanged {
            kind: MemoryChangeKind::Superseded,
            memory_ids: vec![m.id, output.previous_id],
            source_client: Some(ctx.client_name.clone()),
        });
        structured(text, &output)
    }

    async fn tool_create_handoff(
        &self,
        args: CreateHandoffArgs,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        let started = Instant::now();
        self.guard_writable()?;
        let resolved = self.resolve_project(args.project.as_deref(), ctx).await?;
        let summary = self
            .tokens
            .truncate(&scrub(&args.summary).text, HANDOFF_MAX_TOKENS as usize);
        if summary.trim().is_empty() {
            return Err(CobaltError::InvalidInput(
                "summary must not be empty".into(),
            ));
        }
        let last_error = args
            .last_error
            .as_deref()
            .map(|e| self.tokens.truncate(&scrub(e).text, 120));
        let open_files: Vec<String> = args
            .open_files
            .unwrap_or_default()
            .into_iter()
            .take(30)
            .collect();
        let handoff = {
            let _slot = self.write_slot().await;
            self.store()
                .create_handoff(NewHandoff {
                    project_id: resolved.project_id(),
                    source_client: ctx.client_name.clone(),
                    summary: summary.clone(),
                    last_error,
                    open_files,
                    ttl_hours: Some(self.config.get().mcp.handoff_ttl_hours),
                })
                .await?
        };
        let output = CreateHandoffOutput {
            handoff_id: handoff.id,
            expires_at: handoff.expires_at,
            tokens: u32::try_from(self.count(&summary)).unwrap_or(u32::MAX),
        };
        let text = render::create_handoff(&output);
        let injected = self.count(&text);
        self.record(
            ctx,
            TelemetryOperation::Handoff,
            Some("create_handoff".into()),
            Vec::new(),
            injected,
            0,
            started,
            resolved.project_id(),
        )
        .await?;
        structured(text, &output)
    }

    async fn tool_resume_handoff(
        &self,
        args: ResumeHandoffArgs,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        let started = Instant::now();
        self.guard_read(ctx)?;
        let resolved = self.resolve_project(args.project.as_deref(), ctx).await?;
        let handoff = self
            .store()
            .resume_handoff(resolved.project_id(), &ctx.client_name)
            .await?;
        let output = ResumeHandoffOutput { handoff };
        let text = render::resume_handoff(&output);
        let injected = self.count(&text);
        self.record(
            ctx,
            TelemetryOperation::Handoff,
            Some("resume_handoff".into()),
            Vec::new(),
            injected,
            0,
            started,
            resolved.project_id(),
        )
        .await?;
        structured(text, &output)
    }

    async fn tool_list_project_rules(
        &self,
        args: ListProjectRulesArgs,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        let started = Instant::now();
        self.guard_read(ctx)?;
        let resolved = self.resolve_project(args.project.as_deref(), ctx).await?;
        let names = self.project_names().await?;
        let laws = self.store().list_core_rules(resolved.project_id()).await?;
        let prefs = self.store().list_preferences(resolved.project_id()).await?;
        let items = laws
            .iter()
            .chain(prefs.iter())
            .map(|m| ReturnedItem {
                memory_id: m.id,
                source_doc_id: m.source_doc_id,
                similarity_score: 1.0,
                chunk_tokens: m.chunk_tokens,
                content_snapshot: Some(m.content.clone()),
            })
            .collect();
        let output = ListProjectRulesOutput {
            project: resolved.to_output(),
            core_laws: self
                .compact(laws.into_iter().map(|m| (m, None)).collect(), &names)
                .await?,
            preferences: self
                .compact(prefs.into_iter().map(|m| (m, None)).collect(), &names)
                .await?,
        };
        let text = render::project_rules(&output);
        let injected = self.count(&text);
        self.record(
            ctx,
            TelemetryOperation::Read,
            Some("list_project_rules".into()),
            items,
            injected,
            0,
            started,
            resolved.project_id(),
        )
        .await?;
        structured(text, &output)
    }
}

fn savings_of(log: &TelemetryLog) -> TokenSavings {
    TokenSavings {
        injected_tokens: log.injected_tokens,
        avoided_full_tokens: log.avoided_full_tokens,
        saved_tokens: log.saved_tokens,
    }
}

fn change_kind(action: cobalt_core::enums::WriteAction) -> MemoryChangeKind {
    use cobalt_core::enums::WriteAction::*;
    match action {
        Inserted | Duplicate => MemoryChangeKind::Created,
        UpdatedExisting => MemoryChangeKind::Updated,
        Superseded => MemoryChangeKind::Superseded,
    }
}

pub(crate) fn preview(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

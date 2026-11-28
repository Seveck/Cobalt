//! The 9 MCP tools (`docs/MCP_SPEC.md` §2): docstrings, JSON input schemas and handlers.
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

pub const TOOLS: [ToolSpec; 9] = [
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
    ToolSpec {
        name: TOOL_ARCHIVE_MEMORY,
        read_only: false,
        description: "Archive a memory that is wrong or no longer useful, removing it from searches (reversible by the user in Cobalt). Memories are SHARED by all the user's AI tools: another agent may depend on this one. ALWAYS call first with confirm=false to see who uses it, then tell the user plainly that other agents may rely on it and that archiving could hurt their work, and only call again with confirm=true if the user explicitly agrees. Prefer update_memory when the memory is outdated rather than wrong. Nuclear Laws cannot be archived.",
    },
    ToolSpec {
        name: TOOL_CREATE_THEME,
        read_only: false,
        description: "Create (or replace) a visual theme for the user's Cobalt app when they ask you to design one (e.g. 'make me a calm sunset theme'). Themes are data only and fully validated by Cobalt. Send a complete manifest: id (lowercase-dashes, not a built-in id), name, author, version '1.0.0', description, hardware_tier 'eco', layout_type (galaxy|brain|neural_net|knowledge_tree|project_clusters|project_islands), palette (#RRGGBB colors: background, node, core_pin, reusable, edge, text, pulse_read, pulse_reuse, pulse_write, pulse_update, pulse_blocked, category_colors for preference/decision/code/doc/note/ocr), node_geometry, camera, and ui for the whole interface: {mode light|dark, base_hue 0-360, base_tint 0-100, contrast 0-100, accent #RRGGBB, radius 0-16, density compact|comfortable|spacious}. Keep enough contrast; one accent color. Set apply=true only if the user asked to switch to it now. Full spec: GET http://127.0.0.1:7437/api/v1/guide (section 7).",
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
                "top_k": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Max results (default from settings, usually 8)." },
                "max_tokens": { "type": "integer", "minimum": 200, "maximum": 8000, "description": "Token budget for the answer (default ~1200). Long chunks come as excerpts around your query; memories already sent in this session are not repeated." }
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
        TOOL_ARCHIVE_MEMORY => json!({
            "type": "object",
            "properties": {
                "memory_id": { "type": "string", "format": "uuid" },
                "reason": { "type": "string", "minLength": 1, "description": "Why it should be archived (shown to the user)." },
                "confirm": { "type": "boolean", "default": false, "description": "false = dry run that returns who uses it; true = archive (only after the user agreed)." }
            },
            "required": ["memory_id", "reason"], "additionalProperties": false
        }),
        TOOL_CREATE_THEME => json!({
            "type": "object",
            "properties": {
                "manifest": { "type": "object", "description": "Complete .cobalt-theme manifest (THEME_SPEC §3 + §3.1 `ui`)." },
                "apply": { "type": "boolean", "default": false, "description": "Switch the app to this theme now (only if the user asked)." }
            },
            "required": ["manifest"], "additionalProperties": false
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
            TOOL_ARCHIVE_MEMORY => self.tool_archive_memory(parse(args)?, ctx).await,
            TOOL_CREATE_THEME => self.tool_create_theme(parse(args)?, ctx).await,
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
        if self.permission(&ctx.client_name) == cobalt_core::config::ClientPermission::None {
            return Err(CobaltError::PermissionDenied(
                "this AI has no access to the user's memory; the user can allow it in Cobalt > Conectores"
                    .into(),
            ));
        }
        if let FirewallVerdict::Blocked { detail, .. } = self.firewall.check_read(&ctx.client_name)
        {
            return Err(self.blocked(ctx, None, &detail));
        }
        Ok(())
    }

    fn guard_writable(&self, ctx: &ClientContext) -> Result<()> {
        if self.permission(&ctx.client_name) != cobalt_core::config::ClientPermission::ReadWrite {
            Err(CobaltError::PermissionDenied(
                "this AI may only read the user's memory; the user can allow writes in Cobalt > Conectores"
                    .into(),
            ))
        } else if self.is_read_only() {
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

    // The async lookup between check and insert rules out the `entry` API.
    #[allow(clippy::map_entry)]
    async fn compact(
        &self,
        memories: Vec<(Memory, Option<f64>)>,
        names: &HashMap<Id, String>,
    ) -> Result<Vec<CompactMemory>> {
        let mut paths: HashMap<Id, (Option<String>, bool)> = HashMap::new();
        let mut out = Vec::with_capacity(memories.len());
        for (m, similarity) in memories {
            let (file_path, file_changed) = match m.source_doc_id {
                Some(doc_id) => {
                    if let std::collections::hash_map::Entry::Vacant(e) = paths.entry(doc_id) {
                        let store = self.store();
                        let doc = store.get_source_document(doc_id).await?;
                        // Ingest chunks are refreshed by the watcher; only memories written by
                        // agents/users are flagged when their file changed afterwards.
                        let authored = m.source_client.as_deref() != Some("cobalt-ingest");
                        // The watcher refreshes the document when its file changes, so a
                        // document updated after this memory means the memory may be outdated.
                        let changed = authored
                            && match &doc {
                                Some(d) if d.updated_at > m.updated_at => true,
                                Some(_) => matches!(
                                    store.verify_source_document(doc_id).await,
                                    Ok(cobalt_core::enums::FileAvailability::Modified)
                                ),
                                None => false,
                            };
                        e.insert((doc.map(|d| d.file_path), changed));
                    }
                    paths.get(&doc_id).cloned().unwrap_or((None, false))
                }
                None => (None, false),
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
                file_changed,
                updated_at: m.updated_at,
                excerpt: false,
                already_sent: false,
                suspicious: false,
                related_to: None,
                outranked_by: None,
            });
        }
        for m in &mut out {
            m.suspicious = cobalt_core::injection::scan(&m.content).is_some();
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
                expand_graph: true,
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
        let related: HashMap<Id, Id> = response
            .hits
            .iter()
            .filter_map(|h| h.related_to.map(|p| (h.memory.id, p)))
            .collect();
        let outranked: HashMap<Id, Id> = response
            .hits
            .iter()
            .filter_map(|h| h.outranked_by.map(|w| (h.memory.id, w)))
            .collect();
        let results = self
            .compact(
                response
                    .hits
                    .into_iter()
                    .map(|h| {
                        // Text-only matches (identifiers, error codes) have no vector score.
                        let similarity = h.vector_rank.map(|_| h.similarity_score);
                        (h.memory, similarity)
                    })
                    .collect(),
                &names,
            )
            .await?;
        let mut results = results;
        for r in &mut results {
            r.related_to = related.get(&r.id).copied();
            r.outranked_by = outranked.get(&r.id).copied();
        }
        let budget = args
            .max_tokens
            .unwrap_or(self.config.get().search.response_token_budget)
            .clamp(200, 8000) as usize;
        let tokens = self.tokens.clone();
        let results = crate::shaping::shape_results(results, &args.query, budget, &ctx.sent, |t| {
            tokens.count(t)
        });
        // Telemetry: only what was actually handed over.
        let kept: std::collections::HashSet<Id> = results.iter().map(|r| r.id).collect();
        let items: Vec<ReturnedItem> = items
            .into_iter()
            .filter(|i| kept.contains(&i.memory_id))
            .collect();
        let hint = (matches!(resolved, Resolved::Global) && args.project.is_none()).then(|| {
            "no project detected: only global memories were searched. Pass project=<project \
             name or absolute path> to search the user's project."
                .to_owned()
        });
        let mut output = SearchMemoryOutput {
            project: resolved.to_output(),
            core_rules,
            results,
            savings: TokenSavings::default(),
            hint,
        };
        // Clients may read the text or the structured JSON: count the larger one.
        let injected = self
            .count(&render::search_memory(&output))
            .max(self.count(&serde_json::to_string(&output).unwrap_or_default()));
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

    async fn tool_create_theme(
        &self,
        args: CreateThemeInput,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        self.guard_writable(ctx)?;
        let service = self.theme_service().ok_or_else(|| {
            CobaltError::Unsupported("themes can only be created while the Cobalt app runs".into())
        })?;
        let installed = service
            .save_custom_theme(args.manifest, args.apply, &ctx.client_name)
            .await?;
        let out = CreateThemeOutput {
            theme_id: installed.id.clone(),
            name: installed.name.clone(),
            applied: args.apply,
        };
        let text = if args.apply {
            format!("[cobalt] theme \"{}\" created and applied.", out.name)
        } else {
            format!(
                "[cobalt] theme \"{}\" created. The user can apply it in Cobalt > Tienda de temas.",
                out.name
            )
        };
        structured(text, &out)
    }

    /// The project that collects memories saved without a known project (created on demand).
    async fn unsorted_project(&self) -> Result<Resolved> {
        if let Some(project) = self
            .store()
            .find_project_by_name(UNSORTED_PROJECT_NAME)
            .await?
        {
            return Ok(Resolved::Project {
                project,
                created: false,
            });
        }
        let project = self
            .store()
            .create_project(cobalt_core::model::NewProject {
                name: UNSORTED_PROJECT_NAME.to_owned(),
                root_path: None,
                color_hex: Some("#6B7280".to_owned()),
            })
            .await?;
        Ok(Resolved::Project {
            project,
            created: true,
        })
    }

    /// Instruction-like text from an AI is never saved directly (v1.15.0): it goes to the
    /// user's proposals inbox as `suspicious` and the AI gets a firewall error.
    async fn hold_if_instructions(
        &self,
        ctx: &ClientContext,
        content: &str,
        project_id: Option<Id>,
    ) -> Result<()> {
        let Some(pattern) = cobalt_core::injection::scan(content) else {
            return Ok(());
        };
        let project_id = match project_id {
            Some(p) => Some(p),
            None => self
                .resolve_project(None, ctx)
                .await
                .ok()
                .and_then(|r| r.project_id()),
        };
        let _ = self
            .store()
            .add_proposal(cobalt_core::model::NewMemoryProposal {
                project_id,
                client_name: ctx.client_name.clone(),
                kind: cobalt_core::enums::ProposalKind::Suspicious,
                content: scrub(content).text.chars().take(600).collect(),
                evidence: Some(format!(
                    "Contiene texto con forma de instrucción: «{pattern}»"
                )),
            })
            .await;
        self.announce_proposals().await;
        Err(self.blocked(
            ctx,
            None,
            "held for the user's review: the text looks like instructions to an AI, so it was \
             not saved (memories must be facts, not orders)",
        ))
    }

    async fn tool_save_memory(
        &self,
        args: SaveMemoryArgs,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        let started = Instant::now();
        self.guard_writable(ctx)?;
        self.hold_if_instructions(ctx, &args.content, None).await?;
        let (content, mut redacted, truncated) = self.sanitize_write(ctx, &args.content)?;
        let snippet = args.reusable_snippet.as_deref().map(|s| {
            let out = scrub(s);
            redacted += out.count();
            out.text
        });
        let mut resolved = self.resolve_project(args.project.as_deref(), ctx).await?;
        // Never "global by accident" (v1.16.0): without a known project, facts go to
        // Sin clasificar; only preferences or an explicit project="global" are global.
        let mut hint = None;
        if matches!(resolved, Resolved::Global)
            && args.project.is_none()
            && args.category != cobalt_core::enums::MemoryCategory::Preference
        {
            resolved = self.unsorted_project().await?;
            hint = Some(
                "no project detected, so it was saved to 'Sin clasificar' (never shown in other \
                 projects). Next time pass project=<project name or absolute path>; use \
                 project='global' only for facts that are true everywhere."
                    .to_owned(),
            );
        }
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
            possible_conflicts: outcome.possible_conflicts.clone(),
            hint,
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
        self.guard_writable(ctx)?;
        self.hold_if_instructions(ctx, &args.new_content, None)
            .await?;
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
        self.guard_writable(ctx)?;
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

impl Daemon {
    /// Usage impact of archiving `id`, excluding `caller` from the agent list.
    pub async fn archive_impact(&self, id: Id, caller: Option<&str>) -> Result<ArchiveImpact> {
        let store = self.store();
        let m = store
            .get_memory(id)
            .await?
            .ok_or_else(|| CobaltError::NotFound(format!("memory {id}")))?;
        let other_clients = store
            .memory_usage_by_client(id)
            .await?
            .into_iter()
            .filter(|u| Some(u.client_name.as_str()) != caller)
            .collect();
        Ok(ArchiveImpact {
            memory_id: m.id,
            preview: preview(&m.content, 160),
            is_core_pin: m.is_core_pin,
            is_reusable: m.is_reusable,
            hit_count: m.hit_count,
            reuse_count: m.reuse_count,
            last_accessed_at: m.last_accessed_at,
            other_clients,
        })
    }

    async fn tool_archive_memory(
        &self,
        args: ArchiveMemoryArgs,
        ctx: &ClientContext,
    ) -> Result<ToolOutput> {
        let started = Instant::now();
        self.guard_writable(ctx)?;
        let reason = scrub(args.reason.trim()).text;
        if reason.is_empty() {
            return Err(CobaltError::InvalidInput("reason must not be empty".into()));
        }
        let impact = self
            .archive_impact(args.memory_id, Some(&ctx.client_name))
            .await?;
        if impact.is_core_pin {
            return Err(CobaltError::Conflict(
                "Nuclear Laws cannot be archived by agents".into(),
            ));
        }
        if !args.confirm.unwrap_or(false) {
            self.record_archive_dry_run(&ctx.client_name, args.memory_id);
            let output = ArchiveMemoryOutput {
                memory_id: args.memory_id,
                archived: false,
                impact,
            };
            return structured(render::archive_dry_run(&output), &output);
        }
        if !self.take_archive_dry_run(&ctx.client_name, args.memory_id) {
            return Err(CobaltError::Conflict(
                "call archive_memory with confirm=false first, show the impact to the user and get explicit consent".into(),
            ));
        }
        if let FirewallVerdict::Blocked { detail, .. } = self.firewall.check_write(
            &ctx.client_name,
            &format!("archive {} {reason}", args.memory_id),
        ) {
            return Err(self.blocked(ctx, None, &detail));
        }
        let archived = {
            let _slot = self.write_slot().await;
            self.store()
                .archive_memory(
                    args.memory_id,
                    &format!("archived by {}: {reason}", ctx.client_name),
                )
                .await?
        };
        let output = ArchiveMemoryOutput {
            memory_id: archived.id,
            archived: true,
            impact,
        };
        let text = render::archive_done(&output);
        let item = ReturnedItem {
            memory_id: archived.id,
            source_doc_id: archived.source_doc_id,
            similarity_score: 1.0,
            chunk_tokens: archived.chunk_tokens,
            content_snapshot: Some(output.impact.preview.clone()),
        };
        let injected = self.count(&text);
        self.record(
            ctx,
            TelemetryOperation::Update,
            Some(format!("archive_memory: {reason}")),
            vec![item],
            injected,
            0,
            started,
            archived.project_id,
        )
        .await?;
        self.emit_memory_changed(MemoryChanged {
            kind: MemoryChangeKind::Archived,
            memory_ids: vec![archived.id],
            source_client: Some(ctx.client_name.clone()),
        });
        self.emit_agent_archived(
            &ctx.client_name,
            &output.impact.preview,
            output.impact.other_clients.len(),
        );
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

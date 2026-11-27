# Cobalt — Frozen Contracts (v1.7.0)

> v1.7.0 (additive): local OCR — `OcrStatus`, `OcrInstallRequest`, IPC `get_ocr_status` /
> `install_ocr`, trait `OcrEngine`, catalog `ocr.json` (§6.1).

> v1.6.1 (additive): `IngestProgress.{file_chunks_done, file_chunks_total}` (chunk progress inside
> the current file, so large files do not look frozen).

> v1.6.0 (additive): every ingest job ends with a terminal stage (`completed|cancelled|failed`);
> `IngestProgress.{background, project_id, eta_seconds}`; `CaptureSettings.indexing_paused`;
> IPC `set_project_watched`.

> v1.5.0 (additive): `AppSettings.user_display_name`, IPC `get_system_user_name`, layout
> `project_islands` (each project as a separate flat island on a grid).
> v1.4.0: automatic CLI capture (see `docs/CLI_CAPTURE.md`).

> v1.3.2 (Phase 3 fix, additive): `IngestService::cancel_job` + IPC `cancel_ingest`; ingest
> progress is emitted per chunk/embedding batch; folder walks skip binaries (sniffed from the first
> bytes) and text files > 2 MiB (reported); wider default `.memoryignore` rules.

> v1.3.1 (Phase 3, additive): `DeletionImpact` + IPC `get_deletion_impact`. Users can permanently
> delete memories from the UI; the dialog must state it is irreversible and list every consequence
> (`delete.consequence.*`: core_law, reusable, used_by_agents, history, snapshots, encrypted) and
> require an explicit confirmation. Agents still can never delete.

> v1.3.0 (Phase 3, additive): MCP tool #8 `archive_memory` (two-step, `ArchiveImpact`,
> `ClientUsage`), `MemoryRepository::{archive_memory, find_similar}`,
> `TelemetryRepository::memory_usage_by_client`, IPC `get_archive_impact` (Phase 3).

> v1.2.0 (Phase 2, additive, requested by [GEMINI]): `get_source_document` (new) and
> `verify_source_document` moved to Phase 2 for the Node Inspector.

> v1.1.0 (Phase 1, additive): `Pooling` enum and `EmbeddingModelSpec.pooling`; built-in pinned
> catalog (`cobalt_core::catalog`) and model file layout `~/.cobalt/models/<model_id>/`.

Owner: **[CLAUDE]**. Source of truth: `crates/cobalt-core/src/*` (Rust) and its exact mirror
`src/types/contracts.ts` (TypeScript). This document explains them and freezes the SQL schema.
Changing anything here requires a contract version bump made by [CLAUDE] in all three places.

---

## 1. Wire conventions

| Topic | Rule |
|---|---|
| Field names | `snake_case` everywhere (serde default). Only frontend-only 3D types (`LayoutResult`, `ProjectContainer`, `VisualFilters`) use camelCase. |
| Enums | Lowercase `snake_case` string literals, identical in SQL `CHECK`s, JSON and TS unions (`cobalt_core::enums`). |
| Ids | UUID (v7 for new rows) as lowercase hyphenated text. `main` branch id is fixed: `00000000-0000-7000-8000-000000000001`. |
| Timestamps | IPC: RFC 3339. SQLite: RFC 3339 UTC with millis and `Z` (`ids::timestamp_to_sql`). |
| Booleans (SQL) | `INTEGER NOT NULL DEFAULT 0 CHECK (x IN (0,1))`. |
| Blobs | `BLOB` in SQL, base64 strings over IPC (`model::b64_opt`). |
| Option | `Option<T>` ⇒ `T \| null` (always present in Rust → JS payloads). |
| Patch fields | `Option<Option<T>>` with `model::double_option` ⇒ TS `PatchField<T>`: omitted = unchanged, `null` = clear. |
| Errors | `CobaltError` serializes as `ErrorPayload { kind, message }`; `kind` is `ErrorKind`. |
| IPC commands | Zero or one parameter, **always named `args`**: `invoke("cmd", { args })`. |

---

## 2. SQLite canonical schema (`SCHEMA_VERSION = 1`, `PRAGMA user_version = 1`)

Owner of migrations: **[CODEX]** (`crates/cobalt-store`). The DDL below is normative: column
names, types, nullability, defaults and `CHECK`s must match exactly. Extra *indexes* are
allowed; extra *columns or tables* require a contract change.

Connection pragmas (every connection): `journal_mode = WAL`, `foreign_keys = ON`,
`synchronous = NORMAL`, `busy_timeout = 5000`, `temp_store = MEMORY`.

```sql
-- 1. projects
CREATE TABLE projects (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL UNIQUE,
  root_path   TEXT NULL UNIQUE,
  color_hex   TEXT NOT NULL CHECK (length(color_hex) = 7 AND substr(color_hex, 1, 1) = '#'),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 2. branches
CREATE TABLE branches (
  id               TEXT PRIMARY KEY NOT NULL,
  name             TEXT NOT NULL UNIQUE,
  parent_branch_id TEXT NULL REFERENCES branches(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
);
CREATE UNIQUE INDEX idx_branches_single_active ON branches(is_active) WHERE is_active = 1;
-- Seed: ('00000000-0000-7000-8000-000000000001', 'main', NULL, <now>, 1)

-- 3. source_documents
CREATE TABLE source_documents (
  id           TEXT PRIMARY KEY NOT NULL,
  project_id   TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL UNIQUE,
  is_dir       INTEGER NOT NULL DEFAULT 0 CHECK (is_dir IN (0, 1)),
  source_type  TEXT NOT NULL DEFAULT 'note' CHECK (source_type IN
                ('md','sql','bash','rs','ts','js','py','java','json','yaml','toml',
                 'html','css','dockerfile','pdf','image','note','other')),
  file_hash    TEXT NULL,
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  is_watched   INTEGER NOT NULL DEFAULT 0 CHECK (is_watched IN (0, 1)),
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_source_documents_project ON source_documents(project_id);
CREATE INDEX idx_source_documents_type    ON source_documents(source_type);
CREATE INDEX idx_source_documents_watched ON source_documents(is_watched) WHERE is_watched = 1;

-- 4. memories (canonical)
CREATE TABLE memories (
  id               TEXT PRIMARY KEY NOT NULL,
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  project_id       TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_doc_id    TEXT NULL REFERENCES source_documents(id) ON DELETE SET NULL,
  content          TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  source_type      TEXT NOT NULL DEFAULT 'note' CHECK (source_type IN
                    ('md','sql','bash','rs','ts','js','py','java','json','yaml','toml',
                     'html','css','dockerfile','pdf','image','note','other')),
  category         TEXT NOT NULL CHECK (category IN
                    ('preference','decision','code','doc','note','ocr')),
  confidence       REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
  superseded_by    TEXT NULL REFERENCES memories(id) ON DELETE SET NULL,
  version_reason   TEXT NULL,
  is_core_pin      INTEGER NOT NULL DEFAULT 0 CHECK (is_core_pin IN (0, 1)),
  is_reusable      INTEGER NOT NULL DEFAULT 0 CHECK (is_reusable IN (0, 1)),
  reusable_snippet TEXT NULL,
  reuse_count      INTEGER NOT NULL DEFAULT 0 CHECK (reuse_count >= 0),
  is_encrypted     INTEGER NOT NULL DEFAULT 0 CHECK (is_encrypted IN (0, 1)),
  ciphertext       BLOB NULL,
  nonce            BLOB NULL,
  chunk_tokens     INTEGER NOT NULL CHECK (chunk_tokens >= 0),
  hit_count        INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  relevance_score  REAL NOT NULL DEFAULT 1.0,
  pos_x            REAL NULL,
  pos_y            REAL NULL,
  pos_z            REAL NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_accessed_at TEXT NULL,
  source_client    TEXT NULL,
  CHECK (is_encrypted = 0 OR (ciphertext IS NOT NULL AND nonce IS NOT NULL AND content = ''))
);
CREATE INDEX idx_memories_scope       ON memories(branch_id, project_id, status);
CREATE INDEX idx_memories_source_type ON memories(source_type);
CREATE INDEX idx_memories_reusable    ON memories(is_reusable) WHERE is_reusable = 1;
CREATE INDEX idx_memories_core_pin    ON memories(is_core_pin) WHERE is_core_pin = 1;
CREATE INDEX idx_memories_hash        ON memories(content_hash);
CREATE INDEX idx_memories_source_doc  ON memories(source_doc_id);
CREATE INDEX idx_memories_accessed    ON memories(last_accessed_at);

-- 5. memories_fts (external content, BM25)
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, source_type, category,
  content = 'memories', content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
);
-- Triggers memories_ai / memories_ad / memories_au keep it in sync (standard external-content
-- pattern: INSERT; INSERT ... VALUES('delete', ...); delete+insert on UPDATE).
-- Encrypted rows are never indexed: the triggers carry `WHEN is_encrypted = 0` and, after any
-- 'rebuild', the same transaction must remove the entries of encrypted rows (rebuild would
-- otherwise re-index their source_type/category). Search joins must also filter is_encrypted = 0.
-- RULE: never run plain VACUUM without `INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`
-- right after (VACUUM may renumber implicit rowids). Snapshots use the online backup API.

-- 6. vec_memories (sqlite-vec, created at runtime once the model dimension is known)
-- CREATE VIRTUAL TABLE vec_memories USING vec0(
--   memory_id TEXT PRIMARY KEY, embedding float[<dims>] distance_metric=cosine);
-- Keyed by memories.id (never rowid). Dropped/recreated by the engine swap when dims change.
-- USearch / Qdrant / external engines replace it behind the VectorStore trait; their indexes
-- live in ~/.cobalt/index/<engine>-<model>/ and are always rebuildable from `memories`.

-- 7. memory_edges
CREATE TABLE memory_edges (
  source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK (edge_type IN ('semantic','supersedes','same_project')),
  weight    REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (source_id, target_id, edge_type),
  CHECK (source_id <> target_id)
);
CREATE INDEX idx_memory_edges_target ON memory_edges(target_id);

-- 8. handoffs
CREATE TABLE handoffs (
  id              TEXT PRIMARY KEY NOT NULL,
  project_id      TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_client   TEXT NOT NULL,
  summary         TEXT NOT NULL,
  last_error      TEXT NULL,
  open_files_json TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  consumed_by     TEXT NULL
);
CREATE INDEX idx_handoffs_project ON handoffs(project_id, expires_at);

-- 9. telemetry_logs
CREATE TABLE telemetry_logs (
  id                  TEXT PRIMARY KEY NOT NULL,
  timestamp           TEXT NOT NULL,
  client_name         TEXT NOT NULL,
  operation           TEXT NOT NULL CHECK (operation IN
                       ('read','write','update','reuse','handoff','blocked_firewall')),
  query_text          TEXT NULL,
  returned_items_json TEXT NULL,
  injected_tokens     INTEGER NOT NULL DEFAULT 0,
  avoided_full_tokens INTEGER NOT NULL DEFAULT 0,
  saved_tokens        INTEGER NOT NULL DEFAULT 0,
  latency_ms          INTEGER NOT NULL DEFAULT 0,
  project_id          TEXT NULL REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX idx_telemetry_time      ON telemetry_logs(timestamp);
CREATE INDEX idx_telemetry_client    ON telemetry_logs(client_name, timestamp);
CREATE INDEX idx_telemetry_operation ON telemetry_logs(operation, timestamp);
CREATE INDEX idx_telemetry_project   ON telemetry_logs(project_id);

-- 10. snapshots
CREATE TABLE snapshots (
  id           TEXT PRIMARY KEY NOT NULL,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  memory_count INTEGER NOT NULL DEFAULT 0,
  file_path    TEXT NOT NULL UNIQUE
);

-- 11. installed_themes
CREATE TABLE installed_themes (
  id            TEXT PRIMARY KEY NOT NULL,
  name          TEXT NOT NULL,
  author        TEXT NOT NULL,
  version       TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  hardware_tier TEXT NOT NULL CHECK (hardware_tier IN ('eco','balanced','ultra')),
  local_path    TEXT NOT NULL,
  installed_at  TEXT NOT NULL
);

-- 12. app_config (one row per top-level AppSettings field; see config.rs)
CREATE TABLE app_config (
  key        TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Domain invariants (enforced by `cobalt-store`)

1. **Scope**: memory queries for a project use `project_id = ? OR project_id IS NULL` and the active branch, plus `status = 'active'` unless `include_archived`.
2. **Check-Before-Write**: before insert, cosine > `search.dedup_threshold` (0.85) within the same `project_id` + `branch_id` ⇒ either `updated_existing` (same meaning) or a new row with the old one `superseded` (`superseded_by`, `version_reason`, `supersedes` edge). Identical `content_hash` ⇒ `duplicate`, nothing written.
3. **Nuclear Laws** (`is_core_pin = 1`) never decay, are never auto-archived and are always returned first.
4. **No double counting**: `avoided_full_tokens` = Σ `source_documents.total_tokens` over the *unique* `source_doc_id`s of the returned items, plus `chunk_tokens` of items without a source document. `saved_tokens = max(0, avoided - injected) + output_tokens_saved`.
5. **3D coordinates**: deterministic projection of the embedding (fixed-seed random projection to 3D, scaled into a sphere of radius 100) computed on insert/update; recomputed on engine/model swap.
6. **Encryption**: encrypted rows store `content = ''`, have no FTS/vector entries and are invisible to MCP. `content_hash` keeps the plaintext hash.
7. **Retention**: purges only `returned_items_json[].content_snapshot` and `query_text`; numeric metrics are never deleted.
8. **Single writer**: only the daemon process writes; bridges talk to it over the local socket.

---

## 3. Service traits (`cobalt_core::traits`)

| Trait | Implemented by | Consumed by |
|---|---|---|
| `VectorStore` (sqlite-vec, USearch, Qdrant sidecar, LanceDB, Qdrant remote, Chroma) | [CODEX] `cobalt-store` | store internals, engine swap |
| `Embedder` (fastembed ONNX, Ollama) | [CODEX] `cobalt-embeddings` | store, ingest |
| `TokenCounter` (tiktoken-rs) | [CODEX] `cobalt-embeddings` | store, ingest, MCP, Token Firewall |
| `CobaltStore` = Project + SourceDocument + Memory + Search + Governance + Branch + Snapshot + Handoff + Telemetry + Config + Theme repositories + `EngineMigrator` | [CODEX] `cobalt-store` | [CLAUDE] `cobalt-mcp`, `src-tauri` |
| `IngestService` | [CODEX] `cobalt-ingest` | [CLAUDE] `src-tauri` |

All traits are object-safe (`Arc<dyn Trait>`), async via `async_trait`, `Send + Sync`.
Callers run **Secret Scrubber → Token Firewall → store** for every external write.

---

## 4. Tauri events (backend → frontend)

| Event | Payload |
|---|---|
| `cobalt://mcp-activity` | `McpActivity` (`is_replay = true` for history Replay) |
| `cobalt://memory-changed` | `MemoryChanged` |
| `cobalt://download-progress` | `DownloadProgress` |
| `cobalt://engine-swap-progress` | `EngineSwapProgress` |
| `cobalt://ingest-progress` | `IngestProgress` |
| `cobalt://read-only-changed` | `ReadOnlyChanged` |
| `cobalt://vault-status` | `VaultStatus` |
| `cobalt://daemon-status` | `DaemonStatus` |

Pulse colors (`OPERATION_COLORS`): read `#0047AB`, reuse `#8B5CF6`, write `#10B981`,
update `#F59E0B`, handoff `#38BDF8`, blocked_firewall `#EF4444`.

---

## 5. IPC commands (`invoke(name, { args })`)

Typed map: `IpcCommandMap` in `src/types/contracts.ts`; names in `cobalt_core::ipc::commands`.
Until a command's phase is delivered, the frontend must not assume it exists (Phase 1 UI uses
a typed mock adapter clearly labelled as such, removed in Phase 3).

| Phase | Commands |
|---|---|
| 0 | `app_info` |
| 1 | `get_hardware_profile`, `get_settings`, `update_settings`, `list_embedding_models`, `install_engine`, `cancel_download`, `get_engine_status`, `vault_status`, `vault_setup`, `vault_unlock`, `vault_lock` |
| 2 | `get_graph`, `get_memory`, `get_memory_history`, `save_memory`, `update_memory`, `patch_memory`, `delete_memory`, `set_memory_encrypted`, `reveal_memory`, `search_memories`, `list_branches`, `create_branch`, `switch_branch`, `merge_branch`, `discard_branch`, `list_snapshots`, `create_snapshot`, `restore_snapshot`, `delete_snapshot`, `find_duplicates`, `merge_duplicates`, `archive_memories`, `restore_memories`, `get_read_only`, `set_read_only`, `get_daemon_status`, `replay_activity`, `get_source_document`, `verify_source_document` |
| 3 | `get_archive_impact`, `get_deletion_impact`, `list_projects`, `create_project`, `update_project`, `list_library`, `relink_source_document`, `set_watched`, `promote_file_to_reusable`, `get_telemetry_summary`, `query_telemetry`, `list_connectors`, `toggle_connector`, `run_doctor`, `doctor_fix`, `get_mcp_tool_docs`, `search_theme_registry`, `install_theme`, `install_theme_file`, `uninstall_theme`, `list_installed_themes`, `get_theme_manifest`, `ingest_paths`, `cancel_ingest`, `import_past_life`, `export_capsule`, `import_capsule`, `export_backup`, `import_backup`, `swap_engine`, `remove_engine_artifacts`, `build_web_context`, `submit_quick_note` |

---

## 6. Embedding models (`cobalt_core::engine`)

Multilingual (ES/EN) models are the default on **every** tier. English-only models are
selectable only in Pro mode (`PRO_ENGLISH_MODELS`). Defaults come from
`default_model_for_tier` / `default_engine_for_tier` (mirrored as `DEFAULT_MODEL_BY_TIER` /
`DEFAULT_ENGINE_BY_TIER` in TS).

| Tier | Model id | Source (HF) | Dims | Precision | Vector engine | Prefixes |
|---|---|---|---|---|---|---|
| Eco (default) | `multilingual-e5-small` | `intfloat/multilingual-e5-small` | 384 | INT8 | `sqlite_vec` | `query: ` / `passage: ` |
| Balanced | `multilingual-e5-base` | `intfloat/multilingual-e5-base` | 768 | FP32 (INT8 if available) | `usearch` | `query: ` / `passage: ` |
| Ultra | `bge-m3` | `BAAI/bge-m3` | 1024 | FP32 (GPU optional) | `qdrant_sidecar` | none |
| Pro only | `all-minilm-l6-v2`, `bge-small-en-v1.5`, `bge-large-en-v1.5` | — | 384 / 384 / 1024 | INT8 / FP32 | any | none |

- **Pooling**: e5 family = `mean` (attention-mask weighted), bge family = `cls`; always
  L2-normalize. Declared in `EmbeddingModelSpec.pooling`.
- **Model files** (downloaded and SHA-256-verified by the `EngineManager`, revision-pinned in
  `crates/cobalt-core/catalog/models.json`): `~/.cobalt/models/<model_id>/model.onnx`
  (+ `model.onnx_data` for bge-m3), `tokenizer.json`, `config.json`, `special_tokens_map.json`,
  `tokenizer_config.json`. `cobalt-embeddings` loads them as a user-defined ONNX model and must
  not download anything itself; use `catalog::Catalog::builtin().model(id)` for specs.
- **Prefix rule (mandatory, inside the ONNX provider of `cobalt-embeddings`)**: for the e5
  family, `embed_query` prepends `"query: "` and `embed_documents` prepends `"passage: "`
  (`prefixes_for_model`, also exposed as `EmbeddingModelSpec.query_prefix/document_prefix`).
  Callers never add prefixes themselves. Ollama models use the prefixes declared in their spec.
- If `fastembed-rs` has no built-in variant for a model/precision (e.g. INT8 e5-small or
  bge-m3), load it as a user-defined ONNX model downloaded by the `EngineManager`
  (SHA-256 verified) — the model id and dims above stay the same.
- Token counting for chunking/telemetry is always `tiktoken-rs` (`TokenEncoding`), independent
  of the embedding tokenizer.

## 6.1 OCR (v1.7.0)

- Catalog: `crates/cobalt-core/catalog/ocr.json` (`Catalog::ocr_models`, `DEFAULT_OCR_MODEL =
  "ocrs-latin"`): detection + recognition ONNX files for [ocrs](https://github.com/robertknight/ocrs),
  pinned by SHA-256 + size (upstream URLs are unversioned, so a replaced upstream file fails
  verification instead of loading). Basic Latin only: the recognition alphabet is ASCII
  (A–Z, a–z, digits, punctuation), so accented letters, ñ, ü, ¿ and ¡ are misread. English reads
  well; Spanish/French text is readable but loses its accents.
  OCR is approximate: it can misread handwriting, but also computer-made text (small or
  stylized fonts, low resolution, blur, noisy backgrounds, tables, columns). The UI must say so,
  and OCR memories (`category = ocr`) should be treated as possibly inexact.
- `EngineManager::{ocr_status, install_ocr, ocr_model_paths}`; downloads reuse
  `cobalt://download-progress`.
- Trait `OcrEngine { fn recognize(&self, image: &[u8]) -> Result<String> }` (CPU-bound, called on a
  blocking thread). Implemented in `cobalt-ingest` with `ocrs`; injected into the ingest service
  only when the model is installed. Without it, images/scanned PDFs keep failing with a clear
  "install OCR" error. OCR text becomes memories with `category = ocr`.
- IPC (v1.7.0): `get_ocr_status() -> OcrStatus`, `install_ocr({ model_id }) -> OcrStatus`.

## 7. Process model & local endpoints (`cobalt_core::paths`)

- Data home: `~/.cobalt/` on **Linux, macOS and Windows** (`%USERPROFILE%\.cobalt`), never the
  OS app-data dir, so MCP connectors and the `--mcp-stdio` bridge always find the DB and socket
  at a predictable path. The bundle identifier `app.cobalt.brain` is used only for OS
  integration (installers, WebView data, notifications). `$COBALT_HOME` overrides it (tests): `cobalt.db`, `models/`, `engines/`,
  `index/`, `themes/`, `snapshots/`, `backups/`, `logs/`, `daemon.token`, `daemon.sock`.
- Single daemon hosted by the Tauri process. `cobalt --mcp-stdio` = thin stdio⇄daemon bridge over
  a Unix domain socket (`~/.cobalt/daemon.sock`) or Windows named pipe (`\\.\pipe\cobalt-daemon`),
  authenticated with the ephemeral token in `daemon.token`; it starts `cobalt --headless` if the
  daemon is not running.
- HTTP (127.0.0.1 only, default port `7437`): MCP streamable HTTP at `/mcp` (+ legacy SSE),
  REST at `/api/v1`, WebSocket at `/api/v1/ws`, OpenAPI at `/api/v1/openapi.json` + Swagger UI.

## 8. 3D layout contract (frontend-only)

`LayoutType = galaxy | brain | neural_net | knowledge_tree | project_clusters | project_islands | custom_mesh`.
A layout is a pure `LayoutFn` returning `LayoutResult { nodePositions, virtualAnchors?,
structuralEdges?, projectContainers? }`; `ProjectContainer = { id, projectId, label, center,
radius, vectorCount, totalTokens, color }`. Data ⟂ layout math ⟂ materials/shaders; switching
layouts lerps positions. GPU resources must be disposed on layout/theme change.

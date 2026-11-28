# Cobalt MCP Server — Specification (v1.0.0)

Owner: **[CLAUDE]** (`crates/cobalt-mcp`). Rust DTOs: `cobalt_core::mcp`.

## 1. Transports & identity

| Transport | How |
|---|---|
| stdio | Client launches `cobalt --mcp-stdio`; the bridge relays JSON-RPC to the single daemon over the local authenticated socket (auto-starts `cobalt --headless`). |
| Streamable HTTP | `http://127.0.0.1:7437/mcp` (+ legacy SSE endpoint for older clients). Localhost only. |

- Server name `cobalt`, version = app version. Capabilities: `tools` (with `listChanged`), `logging`.
- **Client identity** = `clientInfo.name` from `initialize` (fallback `unknown`). Every telemetry row and live pulse carries it.
- **Project resolution** (every tool with `project?`), first match wins:
  1. explicit `project` argument: exact project name, else an absolute path resolved by `projects.root_path` prefix;
  2. MCP roots (`roots/list`) when the client supports them;
  3. bridge working directory (`cwd` of the `--mcp-stdio` process);
  4. none ⇒ `global` only.
  Paths 1–3 call `resolve_project_by_path(path, create_if_missing = true)`, so unknown roots auto-create a project. Queries then use `project_id = <resolved> OR project_id IS NULL`.
- **Pipeline for writes**: Read-Only check → Secret Scrubber → Token Firewall → store (Check-Before-Write) → telemetry → `cobalt://mcp-activity`.
- **Pipeline for reads**: Token Firewall rate limit → store → telemetry (dedup by `source_doc_id`) → live pulse.
- In Read-Only / Incognito mode, write tools return a tool error `read_only` (reads keep working).
- Docstrings below are defaults; Pro mode can override them (`McpSettings.tool_docstring_overrides`).
- Tool results contain a compact text block (token-lean, for the model) **and** `structuredContent` (the output DTO).

## 2. Tools

### 2.1 `search_memory`

**Docstring**
> Search the user's persistent memory (shared by all their AI tools) BEFORE reading large files, re-asking for context, or re-deriving past decisions. Runs hybrid semantic + exact-text search (vector + BM25, fused with RRF) over the current project and global memories. Returns atomic facts with confidence scores, the project's Nuclear Laws (always obey them), and token-savings metrics. Use precise queries: identifiers, error messages, component names, or the decision you need.

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "minLength": 1, "description": "What you need to know: identifiers, error text, topic or question." },
    "project": { "type": "string", "description": "Project name or absolute path. Omit to auto-detect from the workspace." },
    "include_archived": { "type": "boolean", "default": false, "description": "Also search archived (decayed) memories." },
    "top_k": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Max results (default from settings, usually 8)." }
  },
  "required": ["query"],
  "additionalProperties": false
}
```
Output: `SearchMemoryOutput { project, core_rules[], results[], savings }`. Telemetry `operation = 'read'`.

### 2.2 `search_reusable_assets`

**Docstring**
> Call BEFORE writing boilerplate, utilities, auth/config modules, schemas, or reusable components from scratch. Returns a compact ~50-token interface summary, origin project, verified local file path from `source_documents` if still on disk (or fallback snippet), so you can copy and adapt instead of regenerating.

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "minLength": 1, "description": "What you are about to build, e.g. 'JWT refresh middleware axum'." },
    "source_type": { "type": "string", "enum": ["md","sql","bash","rs","ts","js","py","java","json","yaml","toml","html","css","dockerfile","pdf","image","note","other"], "description": "Restrict to one language/file kind." },
    "exclude_current_project": { "type": "boolean", "default": false, "description": "Only look in OTHER projects." },
    "top_k": { "type": "integer", "minimum": 1, "maximum": 20, "description": "Max assets (default 5)." }
  },
  "required": ["query"],
  "additionalProperties": false
}
```
Searches **all projects**, `is_reusable = 1` only (never mixed into `search_memory`). For each
asset the daemon re-verifies `source_documents.file_path` + `file_hash` (`available` / `modified`
/ `snippet_only` / `missing`). The store increments `reuse_count` of returned assets; the daemon logs `operation = 'reuse'`
(attributed to `clientInfo.name`) with `output_tokens_saved` (estimated tokens of the asset body).
Output: `SearchReusableAssetsOutput { assets[], savings }`.

### 2.3 `save_memory`

**Docstring**
> Save a durable, atomic memory WITHOUT being asked whenever you: make or learn an architecture decision, fix a non-trivial bug (root cause + fix), learn a user preference or convention, or create a reusable piece of code (set is_reusable=true and original_file_path). Write 1–4 lines as "Context -> Decision -> Reason". Never save raw logs, full files, stack traces or secrets (they are redacted anyway). Near-duplicates are merged or versioned automatically, so do not search first just to avoid duplicates.

```json
{
  "type": "object",
  "properties": {
    "content": { "type": "string", "minLength": 1, "description": "Atomic summary, max ~4 lines: Context -> Decision -> Reason." },
    "category": { "type": "string", "enum": ["preference","decision","code","doc","note","ocr"] },
    "project": { "type": "string", "description": "Project name or absolute path. Omit to auto-detect; use 'global' for cross-project facts." },
    "original_file_path": { "type": "string", "description": "Absolute path of the file this memory describes (links it as a source document)." },
    "source_type": { "type": "string", "enum": ["md","sql","bash","rs","ts","js","py","java","json","yaml","toml","html","css","dockerfile","pdf","image","note","other"], "description": "Inferred from original_file_path when omitted." },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1, "default": 1.0, "description": "How certain this fact is." },
    "is_reusable": { "type": "boolean", "default": false, "description": "True for reusable code/config/schemas worth copying into other projects." },
    "reusable_snippet": { "type": "string", "description": "Compact fallback snippet (interface/signature) in case the file moves." }
  },
  "required": ["content", "category"],
  "additionalProperties": false
}
```
`project: "global"` (case-insensitive) forces `project_id = NULL`. Token Firewall: content
> 800 tokens (configurable) is blocked or trimmed; write bursts / identical repeats are blocked
(`blocked_firewall` telemetry + discreet OS notification). Output: `SaveMemoryOutput`.
Telemetry `operation = 'write'`.

### 2.4 `update_memory`

**Docstring**
> Replace a memory that is outdated or wrong (e.g. a decision was reversed, an API changed). Creates a new version, marks the old one as superseded and records your reason, keeping history. Use the memory_id returned by search_memory.

```json
{
  "type": "object",
  "properties": {
    "memory_id": { "type": "string", "format": "uuid" },
    "new_content": { "type": "string", "minLength": 1, "description": "Corrected atomic summary (Context -> Decision -> Reason)." },
    "reason": { "type": "string", "minLength": 1, "description": "Why the previous version is obsolete." },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "required": ["memory_id", "new_content", "reason"],
  "additionalProperties": false
}
```
Output: `UpdateMemoryOutput`. Telemetry `operation = 'update'`. Nuclear Laws can only be
updated from the Cobalt UI (tool error `conflict`).

### 2.5 `create_handoff`

**Docstring**
> Leave a short-lived baton for the next AI session when you stop mid-task (context limit, switching tools, end of day). Summarize current state, next step, last error and open files in under 250 tokens. Handoffs expire and never pollute permanent memory.

```json
{
  "type": "object",
  "properties": {
    "summary": { "type": "string", "minLength": 1, "description": "State + next step, < 250 tokens." },
    "last_error": { "type": "string", "description": "Last blocking error, if any (trimmed)." },
    "open_files": { "type": "array", "items": { "type": "string" }, "maxItems": 30 },
    "project": { "type": "string", "description": "Project name or absolute path. Omit to auto-detect." }
  },
  "required": ["summary"],
  "additionalProperties": false
}
```
Summaries over 250 tokens are trimmed on a token boundary. TTL `McpSettings.handoff_ttl_hours`
(48 h). Output: `CreateHandoffOutput`. Telemetry `operation = 'handoff'`.

### 2.6 `resume_handoff`

**Docstring**
> When the user asks to continue, resume, or pick up where they (or another AI) left off, call this first to get the latest active handoff for the project: summary, next step, last error and open files.

```json
{
  "type": "object",
  "properties": {
    "project": { "type": "string", "description": "Project name or absolute path. Omit to auto-detect." }
  },
  "additionalProperties": false
}
```
Returns the newest non-expired, non-consumed handoff and marks it consumed by the caller.
Output: `ResumeHandoffOutput`. Telemetry `operation = 'handoff'`.

### 2.7 `list_project_rules`

**Docstring**
> Call once at the start of every session (and after switching projects) to load the user's Nuclear Laws and stable preferences for this project plus global ones. These rules override your defaults; follow them for the whole session.

```json
{
  "type": "object",
  "properties": {
    "project": { "type": "string", "description": "Project name or absolute path. Omit to auto-detect." }
  },
  "additionalProperties": false
}
```
Output: `ListProjectRulesOutput { project, core_laws[], preferences[] }` (compact). Telemetry
`operation = 'read'`.

### 2.8 `archive_memory` (Phase 3, contract v1.3.0)

Agents can never hard-delete. This is the only removal tool, and it is reversible.

**Docstring**
> Archive a memory that is wrong or no longer useful, removing it from searches (reversible by the user in Cobalt). Memories are SHARED by all the user's AI tools: another agent may depend on this one. ALWAYS call first with confirm=false to see who uses it, then tell the user plainly that other agents may rely on it and that archiving could hurt their work, and only call again with confirm=true if the user explicitly agrees. Prefer update_memory when the memory is outdated rather than wrong. Nuclear Laws cannot be archived.

```json
{
  "type": "object",
  "properties": {
    "memory_id": { "type": "string", "format": "uuid" },
    "reason": { "type": "string", "minLength": 1, "description": "Why it should be archived (shown to the user)." },
    "confirm": { "type": "boolean", "default": false, "description": "false = dry run that returns usage; true = archive (only after the user agreed)." }
  },
  "required": ["memory_id", "reason"],
  "additionalProperties": false
}
```

- `confirm=false` (dry run): nothing changes. Returns `ArchiveImpact`: memory preview, `hit_count`, `reuse_count`, `is_reusable`, last access, and the **other clients** that read or reused it (from `telemetry_logs.returned_items_json`, excluding the caller) with counts and last date. Text rendering starts with a warning such as: *"⚠ Used by cursor (12×, last 2 days ago) and gemini-cli (3×). Archiving it may hurt those agents. Ask the user before confirming."*
- `confirm=true`: requires a dry run for the same `memory_id` by the same client in the last 10 minutes (else `conflict`); archives (`status = 'archived'`) with `version_reason = "archived by <client>: <reason>"`, emits `memory-changed` + a red pulse, and shows a discreet OS notification to the user ("<client> archived a memory used by N other agents — restore in Cobalt").
- Blocked in Read-Only mode and for Nuclear Laws (`conflict`); goes through the Token Firewall write rate limit; telemetry `operation = 'update'`.

### 2.9 `create_theme` (contract v1.12.0)

**Docstring** (abridged): create or replace a visual theme when the user asks for one ("make me a
calm sunset theme"). Themes are data only; send a complete manifest (THEME_SPEC §3 + §3.1 `ui`);
`apply=true` only if the user asked to switch to it now.

```json
{
  "type": "object",
  "properties": {
    "manifest": { "type": "object", "description": "Complete .cobalt-theme manifest." },
    "apply": { "type": "boolean", "default": false }
  },
  "required": ["manifest"],
  "additionalProperties": false
}
```
- Goes through the desktop app's `ThemeService`: the same validation as a downloaded package
  (ids, ranges, reserved built-in ids), a WebP preview generated from its colors, then
  `cobalt://themes-changed` so the UI shows "Tema creado por <client>".
- Blocked in Read-Only mode; `unsupported` when only the headless daemon runs.
- Output: `CreateThemeOutput { theme_id, name, applied }`.

## 3. Errors

Tool failures return `isError: true` with text `"<kind>: <message>"` and
`structuredContent = ErrorPayload`. Kinds: `invalid_input`, `not_found`, `read_only`,
`firewall_blocked`, `conflict`, `storage`, `engine`, `embedding`, `internal`,
`permission_denied` (the user limited this AI in Cobalt > Conectores, v1.15.0).
Protocol errors (unknown tool, bad JSON) use JSON-RPC error codes.

## 3.1 Safety (v1.15.0)
- **Per-AI permissions**: `none` refuses every call and ignores that client's hooks; `read`
  allows searches/rules only; `read_write` (default) everything. Error kind `permission_denied`.
- **Memories are data, never instructions.** Results whose text looks like an attempt to give
  orders ("ignore previous instructions…", role markers, "don't tell the user…") carry
  `suspicious: true` and a ⚠ note. An AI's `save_memory` / `update_memory` with such text is
  not stored: it becomes a `suspicious` proposal for the user and the call fails with
  `firewall_blocked`.

## 4. Text rendering (token-lean)

```
[cobalt] project: my-app · 3 results · saved ~9.6k tokens
LAW  Always use pnpm, never npm.
0.94 decision  Auth uses short-lived JWT + refresh rotation in Redis (src/auth/jwt.rs) [id:…]
0.81 code      ...
```

# Cobalt — Complete guide for AI assistants

> Read this file once and you can use, integrate with and customize Cobalt.
> Audience: any AI (cloud or **local**, with or without native MCP support) and the developers
> who wire it up. Everything here describes the current build; items marked **(planned)** do not
> work yet. Detailed schemas: `docs/MCP_SPEC.md`, `docs/CONTRACTS.md`, `docs/THEME_SPEC.md`,
> `docs/CLI_CAPTURE.md`.

---

## 0. What Cobalt is — and the five rules you must follow

Cobalt is the user's **local, persistent memory shared by all their AI tools** (Claude, Codex,
Gemini, Cursor, local models…). It runs on the user's computer as one program: a desktop app plus
a background **daemon** that stores memories in SQLite (`~/.cobalt/cobalt.db`) and finds them with
hybrid search (vectors + full text). Nothing leaves the machine.

A **memory** is a short atomic fact (1–4 lines), e.g. *"Auth uses JWT + refresh rotation in Redis
(src/auth/jwt.rs). Reason: stateless API."* Memories belong to a **project** (a folder) or are
**global**. **Nuclear Laws** (core pins) are rules the user marked as absolute.

**Rules for every AI:**
1. **Start of session:** call `list_project_rules` and obey the Nuclear Laws for the whole session.
2. **Before** reading big files, re-asking the user, or re-deriving a past decision: call
   `search_memory`. Trust results; re-check any marked **"⚠ file changed since saved"**.
3. **Before** writing boilerplate/utilities: call `search_reusable_assets`.
4. **Save** (without being asked) decisions, non-trivial bug fixes (root cause + fix) and user
   preferences with `save_memory`: 1–4 lines, *Context → Decision → Reason*. Never save logs, whole
   files, stack traces or secrets. Use `update_memory` when something changed.
5. **Never delete.** Archiving is the only removal and needs the user's explicit consent
   (see `archive_memory`). Never touch `~/.cobalt/cobalt.db` directly.

---

## 1. Is Cobalt running?

```bash
curl -s http://127.0.0.1:7437/api/v1/health        # → {"status":"ok",...}
```

- Default port **7437** (setting `mcp.http_port`; Connectors shows the current URL).
- If it does not answer, ask the user to open Cobalt (or it is started automatically by the
  stdio bridge, §2.1). The HTTP API only listens on `127.0.0.1` (never on the network).

---

## 2. How to connect — pick ONE of four ways

| Your situation | Use |
|---|---|
| Your client supports MCP and launches local commands (Claude Desktop/Code, Cursor, Windsurf, Cline, Codex CLI, Gemini CLI, LM Studio, Continue, …) | **2.1 MCP stdio** |
| Your client supports MCP over HTTP (Open WebUI, custom agents, LangChain/LlamaIndex MCP adapters, …) | **2.2 MCP HTTP** |
| Your program speaks plain HTTP/JSON (scripts, bots, local LLM wrappers) | **2.3 REST API** |
| A local model with **no tool calling at all** (raw Ollama/llama.cpp chat) | **2.4 Host loop** |

### 2.1 MCP over stdio (recommended)

The client launches the Cobalt binary with `--mcp-stdio`. That bridge connects to the daemon over
an authenticated local socket, starts the daemon headless if needed, and **reconnects by itself
if Cobalt restarts** (requests in flight get a "retry" error instead of hanging).

Generic `mcpServers` JSON (most clients):

```json
{
  "mcpServers": {
    "cobalt": { "command": "/absolute/path/to/cobalt", "args": ["--mcp-stdio"] }
  }
}
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.cobalt]
command = "/absolute/path/to/cobalt"
args = ["--mcp-stdio"]
```

- **Easiest:** Cobalt → *Connectors* configures Claude Desktop, Claude Code, Cursor, Windsurf,
  Cline, Gemini CLI and Codex CLI with one switch (it backs up the client config first).
- Binary path: the installed app's executable (development build: `<repo>/target/debug/cobalt`).
- Identity: Cobalt names you by `clientInfo.name` from `initialize`. Send a stable, honest name
  (e.g. `ollama-agent`); it appears in the user's activity feed and telemetry.
- Project detection: MCP `roots` you report, else the bridge's working directory (§4).

### 2.2 MCP over HTTP

- Streamable HTTP endpoint: `POST http://127.0.0.1:7437/mcp` (session via `Mcp-Session-Id`).
- Legacy HTTP+SSE (older clients): `GET /sse` + `POST /messages?sessionId=…`.
- No token needed, but any request carrying an `Origin` header must come from a loopback origin
  (DNS-rebinding protection). Same tools and behavior as stdio.
- Without MCP roots or a working directory, pass `project` explicitly in each tool call (§4),
  otherwise you only see global memories.

### 2.3 REST API (`/api/v1`)

Authenticate with `Authorization: Bearer <token>`, where the token is the content of
`~/.cobalt/daemon.token` (owner-only file, **regenerated at every daemon start** — re-read it
after a 401). Interactive docs: `http://127.0.0.1:7437/api/v1/docs`; schema:
`/api/v1/openapi.json`. JSON is snake_case.

| Method & path | What |
|---|---|
| `GET /health` | Liveness (no auth) |
| `GET /status` | Daemon status, counts, versions |
| `POST /search` | Hybrid search (`SearchRequest`) |
| `POST /memories` | Save a memory (`NewMemory`, same safety pipeline as MCP) |
| `GET /memories/{id}` | One memory |
| `GET /telemetry/summary` | Token-savings summary |
| `GET /ws?token=<token>` | WebSocket stream of live events (§9) |

```bash
TOKEN=$(cat ~/.cobalt/daemon.token)

# Search everything (scope kinds: all | global | project | project_and_global | all_except)
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"why redis for sessions","scope":{"kind":"all"},"top_k":8}' \
  http://127.0.0.1:7437/api/v1/search

# Save (is_core_pin and is_reusable are required booleans; omit optional fields)
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content":"Context: slow login -> Decision: cache sessions in Redis, TTL 15 min -> Reason: latency","category":"decision","is_core_pin":false,"is_reusable":false,"source_client":"my-local-agent"}' \
  http://127.0.0.1:7437/api/v1/memories
```

- `scope` defaults to **global only** when omitted — set it explicitly. A project scope looks like
  `{"kind":"project_and_global","project_id":"<uuid>"}` (ids come from search results / status).
- REST has no handoff, rules, update or archive endpoints yet **(planned)**; use MCP for those.

### 2.4 Local model without tool calling (host loop)

If the model cannot call tools, the **program that hosts it** does the calls:

1. Session start: run `list_project_rules` (MCP) or a REST search for the project's laws, and put
   the result in the system prompt as "rules you must obey".
2. Before each user turn: `POST /search` with the user's message; inject the top results as
   context ("Relevant memories: …"), with their ids.
3. Ask the model to end answers that contain a durable decision/fix/preference with a line like
   `SAVE: <category> | <1–4 line memory>`; the host parses it and calls `POST /memories`.
4. Never let the host save the raw conversation: only those short lines.

---

## 3. The eight MCP tools

Full JSON schemas and docstrings: `docs/MCP_SPEC.md` §2. Every result has a token-lean text block
for the model plus `structuredContent` (typed DTO). `project` accepts a project name, an absolute
path, or `"global"`; omit it to auto-detect.

| Tool | Call it when | Key arguments |
|---|---|---|
| `list_project_rules` | Session start and after switching projects | `project?` |
| `search_memory` | Before reading big files / re-asking / re-deriving | `query` (identifiers, error text, the decision you need), `project?`, `top_k?`, `include_archived?` |
| `search_reusable_assets` | Before writing boilerplate, utilities, configs, schemas | `query`, `source_type?`, `exclude_current_project?` |
| `save_memory` | A decision, fixed bug, preference, or reusable code appears | `content`, `category` (`preference`\|`decision`\|`code`\|`doc`\|`note`\|`ocr`), `project?`, `original_file_path?`, `is_reusable?`, `reusable_snippet?`, `confidence?` |
| `update_memory` | A saved fact became wrong/outdated | `memory_id`, `new_content`, `reason` |
| `create_handoff` | You stop mid-task (context limit, end of day, switching AI) | `summary` (< 250 tokens: state + next step), `last_error?`, `open_files?` |
| `resume_handoff` | The user says "continue / pick up where we left off" | `project?` |
| `archive_memory` | A memory is wrong (not just outdated) | `memory_id`, `reason`, `confirm` |

Behavior you must know:
- **Duplicates are handled for you** (Check-Before-Write merges or versions near-duplicates): do
  not search just to avoid duplicates.
- **`archive_memory` is two-step:** call with `confirm=false` (dry run: shows which other AIs use
  it), tell the user plainly, and only with their explicit "yes" call again with `confirm=true`
  (within 10 minutes). Nuclear Laws cannot be archived or updated by AIs.
- **Secrets are redacted** automatically (keys/tokens become placeholders).
- **Token Firewall:** a memory over ~800 tokens is trimmed or blocked; write bursts (default
  30 writes/min) and identical repeats are blocked; reads are limited (default 120/min).
- **Read-Only / Incognito mode:** write tools return the error `read_only`; reads keep working.
  Tell the user instead of retrying.
- Errors: `isError: true`, text `"<kind>: <message>"`; kinds `invalid_input`, `not_found`,
  `read_only`, `firewall_blocked`, `conflict`, `storage`, `engine`, `embedding`, `internal`.
- Text rendering example:
  ```
  [cobalt] project: my-app · 3 results · saved ~9.6k tokens
  LAW  Always use pnpm, never npm.
  0.94 decision  Auth uses short-lived JWT + refresh rotation in Redis (src/auth/jwt.rs) [id:…]
  ```

---

## 4. Projects

Resolution order for every call (first match wins):
1. explicit `project` argument: `global`, an existing project name, or an absolute path;
2. MCP roots reported by the client;
3. working directory of the stdio bridge;
4. otherwise global only.

- A path inside a known project resolves to that project (longest root wins). An unknown folder
  creates a project named after it and, if *auto-watch* is on, indexes it in the background.
- A **git worktree** of a known repository resolves to the main checkout's project (no duplicate).
- Home directory and filesystem root are never treated as projects.
- Searches use *this project + global*; reusable assets search **all** projects.

---

## 5. Automatic capture & hooks

Cobalt can stay current even when an AI never calls the tools (details: `docs/CLI_CAPTURE.md`).
Everything is optional, reversible, and toggled in *Connectors*.

| Piece | What it does |
|---|---|
| Live project indexing | Watches project folders; changed files are re-indexed, deleted files archived. Memories written by AIs are never rewritten; they get the "file changed since saved" flag instead. |
| Global instructions | Adds a marked block (`<!-- cobalt:begin -->…<!-- cobalt:end -->`) with the five rules to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`. |
| Session hooks | `cobalt --hook <source>` receives the CLI's event JSON (stdin, or last argument for Codex). |
| Git hook | `.git/hooks/post-commit` runs `cobalt --hook git` → each commit becomes a `doc` memory and its files are re-indexed. Existing hooks are preserved and chained. |

Hook sources understood today and their events:

| `source` | Configured in | Events used |
|---|---|---|
| `claude` | `~/.claude/settings.json` → `hooks` | `SessionStart`, `PostToolUse` (`Edit\|Write\|MultiEdit\|NotebookEdit\|Bash`), `Stop`, `SessionEnd` |
| `gemini` | `~/.gemini/settings.json` → `hooks` | `SessionStart`, `AfterTool` (`write_file\|replace\|run_shell_command`), `AfterAgent`, `SessionEnd` |
| `codex` | `~/.codex/config.toml` → `notify = ["<cobalt>", "--hook", "codex"]` | `agent-turn-complete` |
| `git` | `.git/hooks/post-commit` | commit `sha`, `branch`, `subject`, `body`, `files` |

What a hook triggers: live activity in the UI, immediate re-index of edited files, and at turn/
session end an automatic **handoff** (last assistant message, scrubbed, ≤ 250 tokens + touched
files; throttled to one per 10 min per session). Hooks never block the client: if Cobalt is
closed, events go to `~/.cobalt/hook-queue.jsonl` and are replayed at the next start. Exit code
is always 0.

**Writing your own hook:** a hook is just a command your tool runs at an event, e.g.
`/path/to/cobalt --hook claude < event.json`. Sources other than the four above are accepted but
**ignored** today; a generic source for any tool (`--hook custom` with a documented event
format) is **(planned)**. Until then, custom tools should capture through MCP/REST (§2) and use
the git hook for commits.

---

## 6. Controlling what gets indexed — `.memoryignore`

`.gitignore` syntax. Sources, later wins: built-in defaults (VCS/build folders such as `.git/`,
`node_modules/`, `target/`, `dist/`, lockfiles, keys, env files, databases) → global
`~/.cobalt/.memoryignore` → `<project root>/.memoryignore`. Re-include a default with `!pattern`.
Applies to MCP writes linked to files, ingestion and the live watcher. Text files over 2 MiB are
skipped.

---

## 7. Themes — make your own look

A theme is **data only** (JSON + images + GLSL + glTF). No code from a theme is ever executed.

### 7.1 Package

A `.cobalt-theme` file is a ZIP containing exactly:

```
manifest.json            required, ≤ 64 KiB
preview.webp             required, ≤ 1 MiB, real WebP
shaders/<name>.glsl      optional, each ≤ 256 KiB, UTF-8
meshes/<name>.glb        optional, binary glTF 2.0
```

`<name>` matches `^[a-z0-9][a-z0-9_-]{0,63}$`. Anything else (other folders, `.js`, `.html`,
`.svg`, `.wasm`, executables, symlinks, `..` paths) makes the install fail. Limits: ≤ 128 entries,
≤ 25 MiB unpacked, compression ratio ≤ 100 per entry.

### 7.2 `manifest.json`

Start from the built-in theme (`src/themes/minimal/manifest.json`) and change values:

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "author": "Your Name",
  "version": "1.0.0",
  "description": "One sentence.",
  "hardware_tier": "eco",
  "layout_type": "galaxy",
  "layout_params": { "level_spacing": 18, "radial_spread": 40,
                     "show_virtual_anchors": true, "semantic_edges_mode": "hover_only" },
  "palette": {
    "background": "#05070D", "node": "#3B82F6", "core_pin": "#FACC15", "reusable": "#A78BFA",
    "edge": "#1E3A8A", "text": "#E2E8F0",
    "pulse_read": "#0047AB", "pulse_reuse": "#8B5CF6", "pulse_write": "#10B981",
    "pulse_update": "#F59E0B", "pulse_blocked": "#EF4444",
    "category_colors": { "preference": "#F472B6", "decision": "#60A5FA", "code": "#34D399",
                         "doc": "#FBBF24", "note": "#94A3B8", "ocr": "#F97316" }
  },
  "node_geometry": { "shape": "point", "base_size": 0.6, "scale_by_hits": true, "detail": 1 },
  "camera": { "position": [0, 40, 160], "target": [0, 0, 0], "fov": 55,
              "auto_rotate": false, "auto_rotate_speed": 0.3 },
  "shaders": { "node_vertex": null, "node_fragment": null, "edge_vertex": null,
               "edge_fragment": null, "background_fragment": null },
  "mesh_path": null
}
```

| Field | Rule | Used by the renderer today |
|---|---|---|
| `id` | `^[a-z0-9][a-z0-9-]{1,63}$`, not `cobalt-minimal` | yes |
| `version` | SemVer | yes |
| `hardware_tier` | `eco` \| `balanced` \| `ultra` (minimum recommended) | yes (compatibility badge) |
| `layout_type` | see §8 | yes |
| `layout_params` | `level_spacing`, `radial_spread`, `show_virtual_anchors`, `semantic_edges_mode` (`always` \| `hover_only` \| `never`) | yes |
| `palette.*` | every color `#RRGGBB`; `category_colors` per category | yes |
| `node_geometry.base_size`, `scale_by_hits` | node size, grow with usage | yes |
| `node_geometry.shape` | `point` (default) \| `sphere` \| `icosahedron` \| `octahedron` \| `box` \| `mesh` | **(planned)**: nodes render as points |
| `camera.position`, `fov`, `auto_rotate`, `auto_rotate_speed` | initial camera | yes |
| `shaders.*` | paths `shaders/<name>.glsl` | validated, **rendering (planned)** |
| `mesh_path` + `layout_type: custom_mesh` | `meshes/<name>.glb` | validated, **rendering (planned)** (falls back to `galaxy`) |

Unknown fields are ignored, so you can add future fields safely.

### 7.3 Build, install, share

```bash
cd my-theme/            # contains manifest.json, preview.webp, optional shaders/ meshes/
zip -r ../my-theme.cobalt-theme manifest.json preview.webp shaders meshes
```

Install: Cobalt → **Store** → *Install from file* (or drag the file onto the Store). It is
validated in a staging folder and moved to `~/.cobalt/themes/<id>/`; uninstall deletes that folder.
The community catalog is a `registry.json` (id, name, author, version, sizes, `https://`
preview/download URLs and a mandatory `sha256`, see `docs/THEME_SPEC.md` §4); the publishing and
signing process is **(planned)**.

Performance rules: Eco profile disables post-processing and forces edges to `hover_only`;
themes marked `balanced`/`ultra` run "degraded" on weaker machines. Keep previews small.

---

## 8. The graph — layouts and making it yours

The 3D brain places every memory with a pure, deterministic **layout function**. Pick one per
theme with `layout_type` and tune it with `layout_params`:

| `layout_type` | Shape |
|---|---|
| `galaxy` | Default cosmic cloud; uses the stored 3D coordinates of each memory |
| `brain` | Two cerebral hemispheres; Nuclear Laws sit in the central core |
| `neural_net` | Five parallel feed-forward layers along the X axis |
| `knowledge_tree` | Hierarchical 3D canopy (project → category → memory) |
| `project_clusters` | One sphere per project, colored with the project color |
| `project_islands` | One flat disc ("island") per project, plus one for global memories |
| `custom_mesh` | Nodes on your own 3D model **(planned)** |

What you can customize without code: layout, spacing/spread, virtual anchors, when semantic edges
show, all colors, node size, camera. Users can also switch layout live with the layout switcher
and show real connections with *Show connections*.

A completely new layout algorithm is code, so it cannot ship inside a theme. It is added to the
app as a `LayoutFn` in `src/components/canvas3d/layouts/` (pure function: nodes in → positions
out, no side effects) and registered in `layouts/index.ts`.

---

## 9. Live events (WebSocket)

`ws://127.0.0.1:7437/api/v1/ws?token=<token>` streams JSON events:
`cobalt://mcp-activity` (who read/wrote what), `cobalt://memory-changed` (created/updated/
archived ids), `cobalt://read-only-changed`, `cobalt://cli-activity` (hook events). Use it for
dashboards or to refresh your own cache.

---

## 10. Where data lives & what never to do

| Path | Content |
|---|---|
| `~/.cobalt/cobalt.db` | The brain (SQLite WAL + FTS5). **Single writer: the daemon.** |
| `~/.cobalt/index/` | Vector index files |
| `~/.cobalt/models/` | Local embedding models |
| `~/.cobalt/themes/` | Installed themes |
| `~/.cobalt/backups/`, `snapshots/` | User backups |
| `~/.cobalt/daemon.token`, `daemon.sock` | Local auth (secret, regenerated each start) |
| `~/.cobalt/hook-queue.jsonl` | Hook events received while Cobalt was closed |

Never: write to the database or index files directly (vectors would go out of sync), share the
token, expose port 7437 to the network, save secrets or whole files as memories, or archive
without the user's consent. Change the embedding model only from Settings (it re-indexes
everything safely).

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `Connection closed` in an old client | Restart the MCP server in the client; current bridges reconnect automatically |
| REST 401 | Re-read `~/.cobalt/daemon.token` (it changes when Cobalt restarts) |
| Only global results | Pass `project` (name or absolute path) or report MCP roots |
| `read_only` errors | The user enabled Read-Only/Incognito; tell them, do not retry |
| `firewall_blocked` | Shorter memory, fewer writes per minute, no identical repeats |
| Result says "file changed since saved" | Re-read the file before trusting that memory |
| Health check fails | Ask the user to open Cobalt; MCP stdio starts it headless automatically |

# Cobalt — Automatic capture from AI CLIs (v1.4.0)

Goal: Cobalt stays current **even when an AI never calls its MCP tools**, so no agent keeps
receiving outdated knowledge. Owner: [CLAUDE] (hooks, daemon, connectors); [CODEX] (watcher
semantics); [GEMINI] (UI). Every piece is optional, reversible and toggled in Connectors.

## 1. Live project indexing (`capture.auto_watch_projects`, default on)
- When a project is detected (MCP root/cwd, folder import, or a session hook from inside it), its
  root is ingested in the background with `watch = true`, honoring `.memoryignore`, default
  exclusions and the 2 MiB text limit. Progress uses the global ingest bar.
- Watcher semantics for a watched file:
  - **modified** → its ingest chunks (`source_client = cobalt-ingest`) are replaced by fresh ones
    (old chunks deleted: they mirror the file, history lives in git); `file_hash`/`total_tokens`
    updated; `memory-changed` emitted.
  - **deleted** → its chunks are archived with `version_reason = "file deleted"`.
  - Memories written by AIs/users that link the file (`source_doc_id`) are **never** rewritten;
    instead MCP results flag them `file_changed = true` (hash differs from disk) and the text
    rendering prints "⚠ file changed since saved", so agents re-check before trusting them.

## 2. Global instructions (`global_instructions`)
A marked block (`<!-- cobalt:begin -->` … `<!-- cobalt:end -->`) is added to the client's global
instructions file (backup `.bak-<stamp>` first; removal deletes only the block):
- Claude Code: `~/.claude/CLAUDE.md` · Codex CLI: `~/.codex/AGENTS.md` · Gemini CLI: `~/.gemini/GEMINI.md`
- Text: call `list_project_rules` at session start; `search_memory` before reading big files or
  asking for context; `save_memory` for decisions, fixed bugs and preferences; `update_memory`
  when something changed; `create_handoff` when stopping mid-task.

## 3. Session hooks (`session_hooks`) → `cobalt --hook <source>`
- Claude Code (`~/.claude/settings.json` `hooks`): `SessionStart`, `PostToolUse` (matcher
  `Edit|Write|MultiEdit|NotebookEdit|Bash`), `Stop`, `SessionEnd`. Event JSON arrives on stdin.
- Codex CLI (`~/.codex/config.toml`): `notify = ["<cobalt>", "--hook", "codex"]` (JSON as last arg).
- The hook process never blocks the client: it forwards the event over the authenticated local
  socket (`{"cobalt_hook": {...}}` after the handshake) and exits; if the daemon is down the event
  is appended to `~/.cobalt/hook-queue.jsonl` and replayed at the next daemon start. Always exits 0.
- Daemon handling: emits `cobalt://cli-activity`; edited files under a project are re-indexed
  immediately; on `Stop`/`SessionEnd`/Codex `agent-turn-complete` (if `capture.session_handoffs`)
  it creates/refreshes an automatic **handoff** for the project from the last assistant message
  (scrubbed, ≤ 250 tokens) plus touched files — ephemeral, never permanent memory.

## 4. Git (`git_hooks`, per project, `capture.git_commits`)
`.git/hooks/post-commit` (existing hook preserved and chained) runs `cobalt --hook git`, which
records `"Commit <short-sha> on <branch>: <subject>\n<body>"` (+ changed files) as a `doc` memory of
the project (`source_client = git`), and re-indexes the changed files.

## 5. Privacy
Everything stays local, passes the Secret Scrubber and `.memoryignore`, and Read-Only mode pauses
all captured writes (events are still shown live).

# CLAUDE.md

Read `AGENTS.md` first (shared rules, ownership, verification, headless agent commands).

## Role: [CLAUDE] — Principal Architect & Autonomous Orchestrator
- Owns `main`, contracts (`docs/`, `crates/cobalt-core`, `src/types/contracts.ts`),
  `crates/cobalt-mcp`, `src-tauri/`, integration, E2E, packaging and `TASKS.md`.
- Runs ONE phase per turn; dispatches [CODEX] and [GEMINI] in background with micro-prompts
  (≤ 12 lines, never the master prompt), logs in `.agent-logs/phase-<N>-<agent>.log`.
- Before merging: `git diff --stat main..agent/codex` / `main..agent/gemini` must only touch
  the agent's owned paths. After merging: `cargo test --workspace && pnpm typecheck && pnpm build`,
  update `TASKS.md`, then `git -C ../cobalt-<agent> rebase main`.
- [CODEX] work arrives uncommitted: run its verification command in `../cobalt-codex`, then commit
  there on `agent/codex` with its proposed message (no AI trailers).
- On agent failure: relaunch with a corrective micro-prompt containing only the exact error lines.
- Reports to the user in Spanish, then STOP and wait for explicit confirmation of the next phase.
- `PATH="$HOME/.cargo/bin:$PATH"` is required for cargo/rustc in this environment.

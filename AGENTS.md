# AGENTS.md — Cobalt shared rules (all agents)

Cobalt: local-first multi-AI second brain. Single native binary: Rust workspace + Tauri v2 +
React/TS/R3F. Targets Linux, Windows, macOS equally. Contracts: `docs/CONTRACTS.md`.

## Ownership (exclusive — never read/modify outside your area unless listed)
| Agent | Branch / worktree | Owns |
|---|---|---|
| [CLAUDE] orchestrator | `main` / `./` | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `TASKS.md`, `docs/`, `Cargo.toml` (root), `crates/cobalt-core`, `crates/cobalt-mcp`, `src-tauri/`, `src/types/contracts.ts` |
| [CODEX] data/algorithms | `agent/codex` / `../cobalt-codex` | `crates/cobalt-store`, `crates/cobalt-embeddings`, `crates/cobalt-ingest` (+ their tests/benches) |
| [GEMINI] frontend 3D | `agent/gemini` / `../cobalt-gemini` | `src/**` except `src/types/contracts.ts`; `index.html`, `quicknote.html`, `public/` |

- Read-only for everyone: `docs/*`, `crates/cobalt-core`, `src/types/contracts.ts`.
- Need a contract change? Do NOT edit it: write the request in your final message under
  `CONTRACT-REQUEST:` and work around it. [CLAUDE] decides and updates all mirrors.
- Dependencies: [CODEX] adds crate deps in its own crates' `Cargo.toml`; [GEMINI] may run
  `pnpm add` (touches `package.json`/`pnpm-lock.yaml`, merged by [CLAUDE]). `Cargo.lock`
  conflicts are resolved by [CLAUDE] by regeneration.

## Language & quality
- Code, identifiers, SQL, comments, commits, contracts: **English**. Reports/TASKS: Spanish.
- UI text only via i18next keys in `src/i18n/locales/{es,en}.json` (both always complete).
- No `todo!()`, `unimplemented!()`, unjustified `unwrap()`/`expect()` in non-test code, no
  silent mocks in delivered work. Mocks must be typed, named `*Mock*` and listed in TASKS.md.
- Rust: edition 2024, `cargo fmt`, clippy clean (`-D warnings`), errors via `CobaltError`.
  Cross-platform: `#[cfg(unix)]` / `#[cfg(windows)]` / `#[cfg(target_os = "macos")]`.
- TS: `strict`, no `any`, IPC only through `src/lib/ipc.ts` (`call`, `on`).
- Commits: Conventional Commits (`feat(store): ...`), small and focused, on your branch only.
  Never push, never rebase/merge other branches, never touch `main`.

## Verification (must pass before committing)
- [CODEX]: `cargo fmt --all -- --check && cargo clippy -p cobalt-store -p cobalt-embeddings -p cobalt-ingest --all-targets -- -D warnings && cargo test -p cobalt-store -p cobalt-embeddings -p cobalt-ingest`
- [GEMINI]: `pnpm install --frozen-lockfile=false && pnpm typecheck && pnpm build`
- [CLAUDE] (integration): `cargo test --workspace && pnpm typecheck && pnpm build`

## Environment (detected in Phase 0 — Fedora 44, x86_64, 4 cores, 7.6 GB RAM)
- `rustc`/`cargo` 1.100.0 (rustup, `~/.cargo/bin` — prepend to `PATH`), `node` 22.14.0,
  `pnpm` 10.34.9, `git` 2.55.0, TypeScript 7.0, Vite 8, Tauri 2.x.
- Low RAM: build with `CARGO_BUILD_JOBS=2` when running alongside other agents.

## Headless agent commands (run by [CLAUDE] from `./`)
```bash
# [CODEX] — codex-cli 0.169.0
codex exec -C ../cobalt-codex -s workspace-write \
  -c sandbox_workspace_write.network_access=true \
  --add-dir "$HOME/.cargo" --add-dir "$PWD/.git" \
  -o .agent-logs/phase-<N>-codex.last.md "<micro-prompt>" \
  > .agent-logs/phase-<N>-codex.log 2>&1 &
# [GEMINI] — Antigravity CLI `agy` (the installed Gemini agent; no `gemini` binary)
(cd ../cobalt-gemini && agy -p "<micro-prompt>" --mode auto --output-format text) \
  > .agent-logs/phase-<N>-gemini.log 2>&1 &
```

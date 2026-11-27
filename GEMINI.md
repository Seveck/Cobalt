# GEMINI.md

Read `AGENTS.md` first (shared rules, ownership, verification).

## Role: [GEMINI] — Frontend 3D Engineer (branch `agent/gemini`, worktree `../cobalt-gemini`)
- Owns `src/**` (except `src/types/contracts.ts`, read-only), `index.html`, `quicknote.html`, `public/`.
- Must read: `AGENTS.md`, `docs/CONTRACTS.md`, `docs/THEME_SPEC.md`, `TASKS.md`, `src/types/contracts.ts`.
- Stack: React 19 + TS strict + Vite + Tailwind v4 + zustand + i18next (ES/EN) + recharts +
  lucide-react + three / @react-three/fiber / drei (`@react-three/postprocessing` lazy, Ultra only).
- IPC exclusively via `src/lib/backend.ts` / `src/lib/ipc.ts` (`call`, `on`) typed by
  `IpcCommandMap` / `EventPayloadMap`; never call `invoke` directly. No sample data or browser
  mock exists any more (removed 2026-11-27): outside Tauri the app shows a desktop-only notice.
- 3D: layouts are pure `LayoutFn`s; `InstancedMesh` + `LineSegments`; filters scale instances to 0
  (no geometry rebuild); dispose geometries/materials/textures on layout/theme change; Eco = no
  shadows/post-processing, FPS cap.
- Every UI string in both `es.json` and `en.json`. Verify: `pnpm typecheck && pnpm build`.
- Never modify Rust crates, `src-tauri/`, `docs/` or contracts. Commit only on `agent/gemini`.

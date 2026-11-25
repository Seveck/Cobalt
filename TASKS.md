# TASKS.md — Tablero de Cobalt

Leyenda: `[x]` hecho · `[ ]` pendiente · `[~]` en curso. Dueños: [CLAUDE] · [CODEX] · [GEMINI].

## Fase 0 — Cimientos y contratos [SOLO CLAUDE]
- [x] Entorno verificado: Rust 1.100 (rustup), Node 22.14, pnpm 10.34, git 2.55; deps de sistema Tauri en Fedora 44
- [x] CLIs headless detectados: `codex exec` (codex-cli 0.169.0) y `agy -p` (Antigravity, agente Gemini)
- [x] Git `main`, `.gitignore`, Cargo workspace (5 crates + `src-tauri`), frontend React 19 + TS 7 + Vite 8 + Tailwind 4 + R3F + i18next
- [x] `src-tauri`: ventanas `main` + `quicknote`, plugins (global-shortcut, notification, dialog, fs), capabilities por ventana, CSP, asset protocol limitado a temas, iconos
- [x] `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `TASKS.md`, `docs/CONTRACTS.md` (DDL 12 tablas), `docs/MCP_SPEC.md` (7 herramientas), `docs/THEME_SPEC.md`
- [x] `cobalt-core`: enums, entidades, DTOs, traits (`VectorStore`, `Embedder`, `TokenCounter`, `CobaltStore`, `IngestService`), eventos, comandos IPC, settings, paths
- [x] Espejo `src/types/contracts.ts` + test de paridad Rust↔TS (`crates/cobalt-core/tests/contract_parity.rs`)
- [x] Tema base `cobalt-minimal` (`src/themes/minimal/manifest.json`)
- [x] Validación: `cargo check --workspace`, `cargo test -p cobalt-core`, `pnpm typecheck && pnpm build`
- [x] Commit inicial + worktrees `../cobalt-codex` (`agent/codex`) y `../cobalt-gemini` (`agent/gemini`)

## Fase 1 — Núcleo [PARALELO]
### [CLAUDE] `crates/cobalt-core`
- [ ] Hardware Profiler (`sysinfo` + `wgpu`) + reglas de recomendación Eco/Balanceado/Ultra
- [ ] Catálogo de modelos/motores + `EngineManager` (descarga streaming, SHA-256, reintentos, progreso, sidecar Qdrant)
- [ ] Config manager (persistencia vía `ConfigRepository`), Secret Scrubber (regex + entropía), `.memoryignore`
- [ ] Bóveda AES-256-GCM + Argon2id (clave solo en RAM, auto-bloqueo), Token Firewall + tests
- [ ] Comandos IPC Fase 1 en `src-tauri`
### [CODEX] `cobalt-store`, `cobalt-embeddings`
- [ ] Migraciones exactas de `docs/CONTRACTS.md` (12 tablas, FTS5 + triggers, `vec_memories`)
- [ ] Búsqueda híbrida RRF, adaptadores `sqlite-vec` y `USearch` (mmap), coordenadas 3D cacheadas
- [ ] `fastembed-rs` bajo demanda, adaptador Ollama, `tiktoken-rs` + tests
### [GEMINI] `src/`
- [ ] Shell principal (navegación con Biblioteca), stores Zustand, i18n completo ES/EN
- [ ] Onboarding de hardware (progreso de descarga, Aceptar/Personalizar)
- [ ] Canvas R3F base con `cobalt-minimal` (`InstancedMesh`) + adaptador `*Mock*` tipado

## Fase 2 — Daemon, MCP, gobernanza y 3D polimórfico [PARALELO]
- [ ] [CLAUDE] Single-Daemon + `--mcp-stdio`, MCP stdio/HTTP (7 herramientas), REST/WS + OpenAPI, Solo Lectura, Tray, `cobalt://mcp-activity`
- [ ] [CODEX] Check-Before-Write, Leyes Nucleares, proyectos/reutilizables, Decay, Branches, Snapshots, duplicados, telemetría deduplicada, swap atómico
- [ ] [GEMINI] 5 layouts + lerp, Dock de filtros, Modo Sináptico + HUD, Inspector, Depurador RAG, Time-Travel

## Fase 3 — Integración completa [PARALELO]
- [ ] [CLAUDE] Conector 1-Click (Linux/Win/macOS + `.bak`), MCP Doctor, Theme Store sandboxed, cableado IPC completo
- [ ] [CODEX] `cobalt-ingest` completo (importador, OCR, PDF, watcher, `.cbrain`, `.cobalt-backup`, Qdrant/LanceDB/Chroma)
- [ ] [GEMINI] Stores a IPC real (eliminar `*Mock*`), Biblioteca, Conectores/Pro/Doctor, Tienda, Telemetría + Historial + Replay, Puente Web AI, Importador/Mudanza/Branches/Limpiar Cerebro, Nota Rápida

## Fase 4 — Auditoría, pulido y empaquetado [PARALELO]
- [ ] [CODEX] Benchmarks, RAM Eco, OCR/re-vectorización, precisión de ahorro, cobertura
- [ ] [GEMINI] Auditoría visual, FPS/fugas WebGL, traducciones 100 %
- [ ] [CLAUDE] E2E completo, empaquetado `.AppImage/.deb/.rpm`, `.msi/.exe`, `.dmg`, `README.md`, reporte v1.0

## Mocks activos
_Ninguno._

## Solicitudes de cambio de contrato
_Ninguna._

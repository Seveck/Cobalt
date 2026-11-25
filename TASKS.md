# TASKS.md — Tablero de Cobalt

Leyenda: `[x]` hecho · `[ ]` pendiente · `[~]` en curso. Dueños: [CLAUDE] · [CODEX] · [GEMINI].

## Fase 0 — Cimientos y contratos [SOLO CLAUDE]
- [x] Entorno verificado: Rust 1.100 (rustup), Node 22.14, pnpm 10.34, git 2.55; deps de sistema Tauri en Fedora 44
- [x] CLIs headless detectados y probados en sus worktrees: `codex exec` (codex-cli 0.169.0) y `agy -p` (Antigravity / Gemini 4) con lista blanca `scripts/agy-settings.json`
- [x] Git `main`, `.gitignore`, Cargo workspace (5 crates + `src-tauri`), frontend React 19 + TS 7 + Vite 8 + Tailwind 4 + R3F + i18next
- [x] `src-tauri`: ventanas `main` + `quicknote`, plugins (global-shortcut, notification, dialog, fs), capabilities por ventana, CSP, asset protocol limitado a temas, iconos
- [x] `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `TASKS.md`, `docs/CONTRACTS.md` (DDL 12 tablas), `docs/MCP_SPEC.md` (7 herramientas), `docs/THEME_SPEC.md`
- [x] `cobalt-core`: enums, entidades, DTOs, traits (`VectorStore`, `Embedder`, `TokenCounter`, `CobaltStore`, `IngestService`), eventos, comandos IPC, settings, paths
- [x] Espejo `src/types/contracts.ts` + test de paridad Rust↔TS (`crates/cobalt-core/tests/contract_parity.rs`)
- [x] Tema base `cobalt-minimal` (`src/themes/minimal/manifest.json`)
- [x] Decisiones confirmadas: embeddings multilingües por defecto (inglés solo en Modo Pro), bundle id `app.cobalt.brain` con `~/.cobalt/` en los 3 SO, licencia MIT, push de `main` al cerrar cada fase
- [x] Validación: `cargo check --workspace`, `cargo test -p cobalt-core`, `pnpm typecheck && pnpm build`
- [x] Commit inicial + worktrees `../cobalt-codex` (`agent/codex`) y `../cobalt-gemini` (`agent/gemini`)

## Fase 1 — Núcleo [PARALELO] ✅
### [CLAUDE] `crates/cobalt-core` + `src-tauri`
- [x] Catálogo fijado por revisión con SHA-256 reales (e5-small INT8, e5-base INT8, bge-m3, modelos EN Pro, Qdrant v1.20.2 ×4 plataformas)
- [x] Hardware Profiler (`sysinfo` + `wgpu`, feature `hardware`) + reglas Eco/Balanceado/Ultra con RAM nominal
- [x] `EngineManager` (feature `engines`): descarga reanudable con `Range`, SHA-256, reintentos, cancelación, progreso, extracción segura, sidecar Qdrant en loopback con API key
- [x] Config manager (validación, reparación por sección, notificaciones `watch`), Secret Scrubber, `.memoryignore`
- [x] Bóveda AES-256-GCM + Argon2id (clave solo en RAM, auto-bloqueo, AAD por memoria) + blobs sellados para backups; Token Firewall
- [x] 12 comandos IPC Fase 1 en `src-tauri` + ticker de auto-bloqueo + evento `cobalt://vault-status`
- [x] Contratos v1.1.0: `Pooling` + `EmbeddingModelSpec.pooling`; regla FTS para memorias cifradas (petición de Codex)
- [x] E2E real (`src-tauri/tests/e2e_models.rs`, `--ignored`): descarga e5-small desde HF, verifica SHA-256 y embebe ES con prefijos e5
### [CODEX] `cobalt-store`, `cobalt-embeddings`
- [x] Migración v1 exacta (12 tablas, FTS5 + triggers que excluyen cifradas), escritor único + pool WAL
- [x] Repos Config/Project/SourceDocument, save/get/graph de memorias, proyección 3D determinista
- [x] `SqliteVec` y `Usearch` (mmap), búsqueda híbrida RRF con desglose y ahorro deduplicado por `source_doc_id`
- [x] `FastembedEmbedder` (prefijos e5 obligatorios, carga de ONNX instalado), `OllamaEmbedder`, `TiktokenCounter`
### [GEMINI] `src/`
- [x] Shell con navegación (incl. Biblioteca), 9 stores Zustand, i18n ES/EN completo
- [x] Onboarding de hardware (tamaño exacto, Aceptar/Personalizar, progreso en vivo, cancelar) + Ajustes
- [x] Canvas R3F con `cobalt-minimal` (`InstancedMesh`, layout `galaxy` puro, tooltip, dispose, tope 30 FPS en Eco)
- [x] `src/lib/backend.ts` (IPC real Fase 1) + `src/lib/backendMock.ts`

### Correcciones pendientes detectadas en la integración (→ Fase 2)
- [ ] [CODEX] `cobalt-embeddings`: construir specs y archivos solo desde `cobalt_core::catalog` (quitar la ruta `BuiltIn` que descarga por hf-hub; `pooling` del spec)
- [ ] [CODEX] Unificar dependencias con el workspace (reqwest 0.13, sha2 0.11) tras subir el MSRV a 1.95
- [ ] [CODEX] Calibrar umbrales por modelo: con e5 dos notas no relacionadas ya dan coseno ≈ 0.78 (Check-Before-Write 0.85 / duplicados 0.90)

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
- `src/lib/backendMock.ts` [GEMINI]: dentro de Tauri sirve solo comandos de Fases 2/3 aún no entregados (`get_graph`, `list_branches`, `list_library`, `get_telemetry_summary`, `list_connectors`, `list_installed_themes`, `get_theme_manifest`, `get_read_only`, `set_read_only`, `get_daemon_status`) con badge **MOCK** visible; fuera de Tauri sirve todo (vista previa en navegador). Se retira en Fases 2–3.

## Solicitudes de cambio de contrato
- [x] (Codex, Fase 1) Regla FTS + `rebuild` para memorias cifradas → incorporada en `docs/CONTRACTS.md` §2.

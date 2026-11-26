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

## Fase 2 — Daemon, MCP, gobernanza y 3D polimórfico [PARALELO] ✅
### [CLAUDE] `cobalt-mcp` + `src-tauri`
- [x] Single-Daemon: único escritor, cola de escrituras (`write_slot`/`pause_writes`), store intercambiable (activa la búsqueda al instalar el modelo sin reiniciar)
- [x] 7 herramientas MCP con docstrings autónomos (+ overrides Pro), Scrubber → Firewall → store → telemetría con `clientInfo.name` → `cobalt://mcp-activity`
- [x] Resolución de proyecto: argumento / MCP `roots/list` / cwd del puente / global
- [x] Socket local autenticado (Unix socket / named pipe, token 0600) + puente `cobalt --mcp-stdio` con auto-arranque `--headless`
- [x] MCP streamable HTTP (`/mcp`, sesiones) + SSE legado + REST `/api/v1` con bearer, OpenAPI/Swagger, WebSocket de eventos, protección de Origin
- [x] Solo Lectura (tray + `Ctrl+Shift+M`, icono ámbar), bandeja, Nota rápida (`Alt+Space`), cerrar-a-bandeja, instancia única
- [x] 29 comandos IPC de Fase 2 (+ `get_source_document`, `verify_source_document` por petición de Gemini, contrato v1.2.0)
- [x] E2E `crates/cobalt-mcp/tests/e2e.rs` + prueba real del binario `--mcp-stdio` arrancando el daemon
### [CODEX] `cobalt-store`, `cobalt-embeddings`
- [x] `CobaltStore` completo: Check-Before-Write calibrado por modelo (e5 base 0.78), historial, cifrado, reglas, biblioteca, contexto web, decay, duplicados, ramas, snapshots, handoffs, telemetría deduplicada, temas, swap de motor con rollback
- [x] Embeddings solo desde el catálogo verificado (sin descargas propias)
### [GEMINI] `src/`
- [x] Nodos como sprites (`THREE.Points`), índice espacial, 5 layouts + lerp, Dock de filtros, Modo Sináptico + HUD
- [x] Inspector, Depurador RAG, Time-Travel, ramas, Limpiar Cerebro; todos los comandos Fase 2 por IPC real

### Pendiente para Fase 3 (de esta integración)
- [ ] [GEMINI] Usar `get_source_document`/`verify_source_document` reales en el Inspector
- [ ] [CODEX] `find_import_collision` para `.cobalt-backup`; adaptadores Qdrant sidecar / LanceDB / Chroma
- [ ] [CLAUDE] `swap_engine` IPC al cambiar de modelo con memorias existentes (hoy solo se activa en cerebro vacío)

## Fase 3 — Integración completa [PARALELO] ✅
### [CLAUDE]
- [x] Contratos v1.3.0/v1.3.1: herramienta MCP #8 `archive_memory` en dos pasos (simulación → consentimiento → archivo + notificación), `ArchiveImpact`, `DeletionImpact`, `find_similar`, `memory_usage_by_client`
- [x] Conector 1-Click (7 clientes, Linux/Win/macOS, `.bak` fechado, JSON con orden preservado, TOML con comentarios, nunca sobrescribe archivos inválidos, detecta entradas rotas) + "Configuración manual"
- [x] MCP Doctor (socket, HTTP, base de datos, modelo, búsqueda, bóveda, cada cliente) con arreglos automáticos
- [x] Tienda de Temas sandbox: registro solo en memoria, SHA-256, lista blanca, sin código, anti traversal/zip bomb/magic bytes, staging + rename atómico
- [x] Motores externos: Qdrant sidecar (API key en tiempo de ejecución), Qdrant remoto y Chroma; reenganche al arrancar; LanceDB opcional (`--features lancedb`)
- [x] `swap_engine` con nuevo embedder y escrituras MCP en cola; ingesta y vigilante de archivos activados con el motor
- [x] Todos los comandos IPC de Fase 3 (+ `get_archive_impact`, `get_deletion_impact`)
### [CODEX]
- [x] `cobalt-ingest`: chunking por tokens, tipo de fuente, SHA-256, `.memoryignore`, scrubber, PDF, vigilante `notify`, importador Vida Pasada sin LLM, promoción a Biblioteca
- [x] `.cbrain` y `.cobalt-backup` (zip+zstd, checksums, cifrado opcional, restauración no destructiva con rama `import-<fecha>` y re-vectorización)
- [x] Adaptadores Qdrant / Chroma / LanceDB con tests HTTP simulados
### [GEMINI]
- [x] IPC real para todo (0 mocks dentro de Tauri), Biblioteca, Conectores + Pro + Doctor, Tienda de Temas, Telemetría + Historial + Replay, Herramientas (proyectos, puente web, importador, cápsulas, backup), soltar archivos sobre el 3D, Nota rápida
- [x] Inspector: ruta real del archivo, "archivado por <agente>" + Restaurar, agentes que usan el nodo; borrado definitivo con todas las consecuencias y confirmación escrita

### Pendiente detectado en la Fase 3
- [ ] OCR: catalogar los modelos de `ocrs` (revisión fija + SHA-256); hasta entonces imágenes/PDF escaneados dan un error claro
- [ ] Credenciales para Qdrant remoto / Chroma con autenticación (hoy solo endpoint)
- [ ] Mover snapshots y memorias cifradas entre equipos (hoy los backups los excluyen y lo informan)
- [ ] Botón "Borrar por origen" para limpiar datos de prueba

## Propuestas pendientes de decisión (auditoría de problemáticas, 2026-11-25)
- [ ] Búsqueda que sigue el grafo (vecinos a 1 salto) + arista `depends_on` (punto 5)
- [ ] Detector de contradicciones al guardar (`possible_conflicts`) y sección "Contradicciones" en Limpiar Cerebro (punto 6)
- [ ] Defensa contra inyección de instrucciones: memorias entregadas como datos + cuarentena heurística al guardar/importar (punto 8a)
- [ ] Permisos por agente (lectura / escritura / sin acceso) en Conectores (punto 8b)
- [ ] Ahorro en dinero (precio por modelo configurable) y tiempo estimado en el dashboard (punto 9)

## Mocks activos
- `src/lib/backendMock.ts` [GEMINI]: **0 comandos dentro de Tauri**; solo para la vista previa en navegador. Se elimina en la Fase 4.
- Tests: `IngestEmbedderMock`, `RestTransportMock` (Codex), `BagOfWords` (E2E MCP) — solo en `cfg(test)`.

## Solicitudes de cambio de contrato
- [x] (Codex, Fase 1) Regla FTS + `rebuild` para memorias cifradas → incorporada en `docs/CONTRACTS.md` §2.

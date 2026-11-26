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

## Fase 3 — Integración completa [PARALELO]
- [ ] [CLAUDE] Herramienta MCP `archive_memory` en dos pasos (MCP_SPEC §2.8): simulación que avisa qué otros agentes usan el nodo, confirmación explícita del usuario, notificación del SO, reversible; contratos v1.3.0
- [ ] [GEMINI] Borrado definitivo desde la UI: diálogo que deja claro que es **irreversible** y lista todas las consecuencias de `get_deletion_impact` (Ley Nuclear, activo reutilizable, IAs que lo usan, versiones del historial, snapshots, cifrado), con confirmación explícita (escribir el texto o mantener pulsado)
- [ ] [GEMINI] Inspector: mostrar "archivado por <agente>" con botón Restaurar y la lista de agentes que usan el nodo
- [ ] [CLAUDE] Conector 1-Click (Linux/Win/macOS + `.bak`), MCP Doctor, Theme Store sandboxed, cableado IPC completo
- [ ] [CODEX] `cobalt-ingest` completo (importador, OCR, PDF, watcher, `.cbrain`, `.cobalt-backup`, Qdrant/LanceDB/Chroma)
- [ ] [GEMINI] Stores a IPC real (eliminar `*Mock*`), Biblioteca, Conectores/Pro/Doctor, Tienda, Telemetría + Historial + Replay, Puente Web AI, Importador/Mudanza/Branches/Limpiar Cerebro, Nota Rápida

## Fase 3.5 — Asistente conversacional, Personas y Estudio [PARALELO] (decidida 2026-11-25)
Objetivo: que Cobalt sirva también a quien no programa (organizar notas, estudiar), con un chat que
consulta y **actúa** sobre el cerebro. Se construye después de la Fase 3 (sus importadores alimentan el chat).
- [ ] [CLAUDE] Proveedores de modelo elegibles por el usuario en Ajustes: local (Ollama) y APIs propias
      (Claude, Gemini, OpenAI, OpenRouter/compatibles OpenAI). API keys guardadas cifradas (Bóveda /
      llavero del SO), nunca en texto plano; aviso claro de qué fragmentos se envían al proveedor elegido
- [ ] [CLAUDE] Motor del asistente con herramientas internas seguras: buscar nodos (con citas), crear
      tablas/agrupaciones (p. ej. "proyectos de este mes" con sus nodos), mover/reasignar nodos,
      editar, archivar (dos pasos), etiquetar; toda acción queda versionada y es reversible
- [ ] [CLAUDE] Contratos v2: entidad **Personas** (tabla `people`: yo por defecto, familiares, colegas…),
      `memories.owner_id`; las IAs por MCP solo usan memorias del usuario salvo petición explícita
- [ ] [CODEX] Store: Personas + reasignación, consultas agregadas por periodo/proyecto/persona,
      tarjetas con repaso espaciado (algoritmo tipo SM-2/FSRS) y generación/corrección de cuestionarios
- [ ] [GEMINI] Panel de chat (lateral y a pantalla completa) con respuestas que citan nodos (se iluminan
      en el 3D), tablas interactivas, confirmación visible de acciones; zonas por persona en el 3D;
      clic en nodo → "decirle al chat" sobre ese nodo
- [ ] [GEMINI] Modo Estudio: preguntas con citas, tarjetas + repaso espaciado, cuestionarios,
      resúmenes por tema/periodo
- [ ] [CLAUDE+GEMINI] **Módulos y perfiles (anti-saturación)**: núcleo fijo (capturar, buscar, cerebro, chat);
      cada función extra es un módulo activable (Estudio, Desarrollo/MCP, Reuniones, Diario, Investigación,
      Voz…). El onboarding pregunta "¿para qué usarás Cobalt?" y enciende solo lo necesario; la interfaz
      sugiere activar un módulo cuando el uso real lo indica (p. ej. tras importar PDFs de clase → Estudio),
      nunca lo impone. Opciones avanzadas siempre en Modo Pro; la vista 3D puede ser secundaria (lista/tabla)
- [ ] [CLAUDE+GEMINI] **Modo Voz del asistente**: el usuario habla o escribe; el agente busca todo lo
      relacionado en Cobalt y **responde en voz alta** (con las citas visibles e iluminadas en el 3D).
      Voz local por defecto (STT Whisper.cpp + TTS Piper / voz del SO, sin nube) y voces de proveedor
      opcionales con la clave del usuario; atajo "pulsar para hablar", velocidad/voz configurables, ES/EN
- [ ] Posicionamiento ampliado: memoria personal y multi-IA para cualquier persona (notas, estudio y
      desarrollo), con ahorro de tokens medible y cero telemetría

## Fase 5 — Expansión por módulos (post-v1, todo opcional y oculto si no se usa)
Orden sugerido; se prioriza según el uso real de los usuarios.
- [ ] Categorías y plantillas por perfil (Estudio, Personal, Trabajo); "activos reutilizables" generalizados a plantillas
- [ ] Extensión de navegador (guardar página/fragmento/resaltado + puente "Copiar contexto" para IAs web)
- [ ] Notas de voz con transcripción local; captura de pantalla con OCR por atajo
- [ ] Importadores: Notion, Evernote, Apple Notes, Google Keep, OneNote, Kindle, Zotero, correo (.mbox)
- [ ] Estudio avanzado: mapa de dominio, ruta de estudio por fecha de examen, modo "explícamelo", material de curso (PDF/diapositivas/YouTube), exportar a Anki
- [ ] Trabajo: reuniones (transcripción → decisiones/tareas/personas), pendientes derivados, diario + resumen semanal, calendario .ics (solo lectura)
- [ ] Investigación y escritura: fuentes con citas (BibTeX/Zotero), borradores citando nodos, vista de evolución de una idea
- [ ] Personal: Personas como mini-CRM; salud/finanzas/recetas solo en Bóveda cifrada
- [ ] Ahorro en lenguaje simple (tiempo y dinero), más idiomas (PT, FR), accesibilidad (lector de pantalla, alto contraste)
- [ ] Futuro lejano: app móvil compañera (sync cifrada) y cerebros compartidos familia/equipo con permisos

## Fase 4 — Auditoría, pulido y empaquetado [PARALELO]
- [ ] [CODEX] Benchmarks, RAM Eco, OCR/re-vectorización, precisión de ahorro, cobertura
- [ ] [GEMINI] Auditoría visual, FPS/fugas WebGL, traducciones 100 %
- [ ] [CLAUDE] **Limpieza total de datos de ejemplo (obligatorio antes de v1.0):** eliminar `src/lib/backendMock.ts`, el grafo simulado (~300 nodos), proyectos/telemetría/temas ficticios y el badge MOCK; verificar que una instalación nueva arranca con el cerebro vacío (0 memorias, 0 proyectos) y sin datos precargados
- [ ] [CLAUDE] E2E completo, empaquetado `.AppImage/.deb/.rpm`, `.msi/.exe`, `.dmg`, `README.md`, reporte v1.0

## Propuestas pendientes de decisión (auditoría de problemáticas, 2026-11-25)
- [ ] Búsqueda que sigue el grafo (vecinos a 1 salto) + arista `depends_on` (punto 5)
- [ ] Detector de contradicciones al guardar (`possible_conflicts`) y sección "Contradicciones" en Limpiar Cerebro (punto 6)
- [ ] Defensa contra inyección de instrucciones: memorias entregadas como datos + cuarentena heurística al guardar/importar (punto 8a)
- [ ] Permisos por agente (lectura / escritura / sin acceso) en Conectores (punto 8b)
- [ ] Ahorro en dinero (precio por modelo configurable) y tiempo estimado en el dashboard (punto 9)

## Mocks activos
- `src/lib/backendMock.ts` [GEMINI]: dentro de Tauri sirve solo comandos de Fases 2/3 aún no entregados (`get_graph`, `list_branches`, `list_library`, `get_telemetry_summary`, `list_connectors`, `list_installed_themes`, `get_theme_manifest`, `get_read_only`, `set_read_only`, `get_daemon_status`) con badge **MOCK** visible; fuera de Tauri sirve todo (vista previa en navegador). Se retira en Fases 2–3.

## Solicitudes de cambio de contrato
- [x] (Codex, Fase 1) Regla FTS + `rebuild` para memorias cifradas → incorporada en `docs/CONTRACTS.md` §2.

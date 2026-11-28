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
- [x] [CODEX] `cobalt-embeddings`: specs y archivos solo desde `cobalt_core::catalog`, sin `hf-hub`, `pooling` del spec (verificado 2026-11-28)
- [x] [CODEX] Unificar dependencias con el workspace (reqwest 0.13, sha2 0.11) — verificado 2026-11-28; los duplicados restantes son transitivos de terceros (p. ej. `lopdf` → sha2 0.10)
- [x] [CODEX] Calibrar umbrales por modelo (2026-11-27): medido con 60 pares ES/EN; calibración separada para búsqueda (100 % paráfrasis, 75-80 % mismo tema) y para escritura (35-50 % paráfrasis fusionadas, 0 falsos duplicados; antes 0 %). Límite conocido: el coseno de E5 no separa bien "misma idea" de "otra idea del mismo tema"

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
- [x] [GEMINI] Usar `get_source_document`/`verify_source_document` reales en el Inspector (verificado 2026-11-27: las 78 órdenes IPC son reales dentro de Tauri)
- [ ] [CODEX] `find_import_collision` para `.cobalt-backup`; adaptadores Qdrant sidecar / LanceDB / Chroma
- [x] [CLAUDE] `swap_engine` IPC al cambiar de modelo con memorias existentes (`update_settings` ya no lo permite sin re-vectorizar)

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
- [x] OCR local (2026-11-27, contratos v1.7.0–v1.8.0): imágenes y PDF escaneados; el usuario elige motor en Ajustes → PaddleOCR (recomendado, por defecto: tildes/ñ, 1 % de errores en español en un i3) u ocrs (solo letras básicas, 15 %); modelos fijados por SHA-256, aviso permanente de que el OCR puede equivocarse
- [ ] Credenciales para Qdrant remoto / Chroma con autenticación (hoy solo endpoint)
- [ ] Mover snapshots y memorias cifradas entre equipos (hoy los backups los excluyen y lo informan)
- [x] Calidad de búsqueda (2026-11-27): palabras vacías ES/EN fuera de la búsqueda de texto, respeto a `.gitignore` (+ poda de lo ya indexado), coincidencias exactas mostradas como `text`, y orden híbrido medido con 30 búsquedas sobre un cerebro real: fuera de tema sin resultados 20 → 100 %, identificadores en #1 67 → 100 %, preguntas naturales en top 3 55 → 91 %
- [ ] Botón "Borrar por origen" para limpiar datos de prueba
- [x] Ingesta de carpetas grandes (2026-11-26): exclusiones por defecto ampliadas, binarios detectados sin leerlos enteros, texto > 2 MiB omitido y reportado, progreso por fragmento, `cancel_ingest` y barra de progreso global con Cancelar

## Fase 3.1 — Captura automática desde la CLI ✅ (2026-11-26)
- [x] [CLAUDE] Contratos v1.4.0 (`cobalt://cli-activity`, `CaptureSettings`, `CaptureStatus`, `file_changed`) y `docs/CLI_CAPTURE.md`
- [x] [CLAUDE] `cobalt --hook <claude|codex|git>` por socket autenticado, cola si el daemon está cerrado; actividad en vivo, reindexado de archivos tocados, commits como memorias, handoff automático al terminar sesión
- [x] [CLAUDE] Instaladores reversibles con `.bak`: instrucciones globales (Claude Code, Codex, Gemini CLI), hooks de Claude Code, `notify` de Codex, `post-commit` de git encadenado
- [x] [CLAUDE] Proyectos indexados y vigilados al detectarse; memorias de IA marcadas "archivo cambiado" cuando su documento se actualizó después
- [x] [CODEX] Vigilante: reemplazo atómico de fragmentos al cambiar un archivo, archivado al borrarlo, archivos nuevos en carpetas vigiladas, nunca reescribe memorias de IA/usuario
- [x] [GEMINI] Panel "Captura automática", feed en vivo de la CLI con pulsos en el 3D, insignia "El archivo cambió desde que se guardó"
- [x] Hooks de Gemini CLI (`~/.gemini/settings.json`: SessionStart, AfterTool, AfterAgent, SessionEnd)
- [x] Indexación en segundo plano (2026-11-26, contratos v1.6.0): todo trabajo (UI, vigilante, hooks) termina con `completed`/`cancelled`/`failed` (arregla los 72 trabajos "atascados"); ráfagas del vigilante agrupadas en un trabajo por proyecto; archivos con mismo SHA-256 omitidos; documentación antes que código; ETA; guardado por lotes de 24 fragmentos
- [x] Pausa global de indexación (`capture.indexing_paused`, también detiene el vigilante), Pausar/Reanudar por trabajo, interruptor "Vigilar este proyecto"; trabajos de fondo agrupados en una fila por proyecto con tiempo restante
- [x] Grafo: sin líneas decorativas en `brain`/`project_clusters`, botón "Mostrar conexiones" (aristas reales); versión y contratos movidos a Ajustes → Acerca de
- [x] Bug (2026-11-26): el vigilante reescaneaba en bucle: los eventos `OPEN` de inotify (notify 8.2) generados por las propias lecturas de Cobalt desbordaban la cola → rescan completo infinito. Ahora se descartan eventos de acceso y rutas ignoradas antes de encolar, sin lecturas dobles, con test de regresión (1 101 archivos); la UI cuenta solo trabajos en curso
- [x] Progreso por fragmentos dentro del archivo actual (contratos v1.6.1, `file_chunks_done/total`): barra secundaria "fragmento X de Y" para que los archivos grandes no parezcan congelados
- [x] Bug (2026-11-26): `cobalt --mcp-stdio` no se reconectaba al reiniciarse el daemon ("Connection closed"). Ahora espera al daemon, reenvía en silencio el `initialize`/`initialized` guardado, responde con error las peticiones cortadas y encola las nuevas; en release relanza el daemon a los 10 s (en dev espera a `tauri dev`); test E2E con reinicio + prueba de mutación
- [x] Bug (2026-11-26): un worktree de git (`../cobalt-codex`) creaba un proyecto duplicado y reindexaba todo el repo; ahora se resuelve al proyecto del checkout principal (`.git` → `gitdir` → `commondir`). Duplicado existente borrado con copia de seguridad
- [x] Bug (2026-11-26): `update_settings` guardaba otro motor/modelo con memorias existentes sin re-vectorizar (quedaban sin vectores); ahora lo rechaza y solo `swap_engine` puede cambiarlo
- [x] Bug (2026-11-26): la indexación de fondo retenía el permiso de escritura durante todo el trabajo y congelaba la UI tras cualquier acción exclusiva; ahora cada escritura la protege el store, como el vigilante
- [x] [GEMINI] Bienvenida y "Guardar preferencias" cambian motor/modelo solo vía `swap_engine` y muestran el rechazo del backend
- [x] Cualquier IA puede usar Cobalt (2026-11-26): `docs/AI_GUIDE.md` + `llms.txt`, servida en `GET /api/v1/guide`; herramientas MCP por REST (`GET /api/v1/tools?format=openai`, `POST /api/v1/tools/{name}`, cabeceras `X-Cobalt-Client`/`X-Cobalt-Cwd`); formato genérico de hooks para cualquier herramienta (`cobalt --hook <nombre>` o `POST /api/v1/hooks/{nombre}`, CLI_CAPTURE v1.5.0)
- [x] Temas v1.1.0: shaders de tema (nodos, aristas, fondo) con respaldo si no compilan, vigilante de fotogramas e interruptor en Ajustes → Apariencia; nodos volumétricos (esfera/icosaedro/octaedro/caja/malla) en balanced/ultra; layout `custom_mesh` sobre un GLB propio
- [x] Pulido visual (2026-11-27): barra lateral plegable (Ctrl+B); panel de gráficos plegable a la derecha; transición "arena" al cambiar de gráfico; la cámara se queda donde la dejó el usuario; actividad de IA claramente visible (pulso con núcleo blanco y anillo, resto atenuado, aviso de nodos fuera de vista) y solo para peticiones de IAs; sin líneas decorativas en ningún gráfico; configuración manual de conectores con el bloque real
- [x] Estadísticas (2026-11-27, contratos v1.10.0, esquema v2): calendario anual tipo GitHub, Hoy/Semana/Año, IA que más usa Cobalt, hora y día favoritos, rachas, proyecto más usado; resumen por horas permanente (`usage_hourly`)
- [x] Temas para toda la app (2026-11-27, THEME_SPEC v1.2, contratos v1.11.0): Grafito, Porcelana, Abisal y Niebla incluidos en la tienda; tipografía Geist en toda la app; animaciones de nodos del laboratorio de estilo
- [x] Tema por defecto de una instalación nueva: `cobalt-minimal` (decidido por el usuario 2026-11-28)
- [x] [GEMINI] Botón visible para pausar/reanudar el giro automático del cerebro 3D en todos los gráficos (pedido 2026-11-27; recordar la elección)
- [x] [GEMINI] Cámara inicial un poco más lejos y mejor centrada en todos los gráficos (sin volver a moverla al cambiar de gráfico)
- [x] [GEMINI] Animaciones suaves al mostrar o cargar contenido (vistas, paneles, tarjetas, listas, estados de carga), respetando "Movimiento reducido"
- [x] Cobalt totalmente personalizable (2026-11-28, contratos v1.12.0): editor "Personalizar" con vista previa en vivo (modo, acento, base, contraste, densidad, esquinas, tamaño, colores del cerebro), "Mis temas" (aplicar, editar, exportar, eliminar), compartir = exportar `.cobalt-theme`, herramienta MCP `create_theme` para que cualquier IA diseñe un tema; explicación de bienvenida (Guarda · Conecta · Recuerda · Ahorra + principios)
- [x] Núcleo de Cobalt, etapas 1–3 (2026-11-28, contratos v1.13.0–v1.14.0, esquemas v3–v4): contexto automático al iniciar sesión (reglas + último traspaso en Claude Code y Gemini CLI); ahorro de tokens honesto (máx. 2.000 por archivo, una vez cada 30 min por IA, escrituras = 0; historial recalculado: 648.505 → 57.971); búsquedas con presupuesto de tokens, extractos, máx. 2 fragmentos por archivo y sin repetir en la sesión; bandeja de propuestas (decisiones, arreglos, preferencias detectadas en las sesiones, nada se guarda sin aprobación)
- [x] Núcleo, etapa 4 (contratos v1.15.0, esquema v5): búsqueda que sigue el grafo, detector de contradicciones (aviso al guardar + pestaña Contradicciones), defensa contra instrucciones ocultas (marcadas ⚠ al leer, retenidas en la bandeja al guardar), permisos por IA (sin acceso / solo lectura / lectura y escritura), ahorro en dinero y tiempo
- [x] Núcleo, etapa 5 (v1.16.0): aislamiento entre proyectos — lo guardado sin proyecto va a "Sin clasificar" (nunca global por accidente), proyecto > global y nuevo > antiguo con marca "posiblemente desactualizada"
- [x] Esquemas MCP ~60 % más ligeros (v1.17.0): 6 herramientas núcleo (~1.030 tokens) + 3 opcionales activables en Conectores; prueba que limita el tamaño
- [x] Pulido tras pruebas del usuario (2026-11-27): saludo sin línea de ahorro, pausa del giro con inercia, cambio de tema suave, botones de la tienda responsivos, nombres legibles de IAs (y borrado de clientes de prueba), "Ver más" en propuestas (contexto completo guardado), calendario columna a columna, textos "tus IAs", "Ahorro" opcional, ventanas que se cierran al hacer clic fuera, `find_conflicts` registrado y Limpiar cerebro sin congelar el grafo; duplicados y contradicciones en ~0,2 s con 5.000 memorias
- [x] Carpetas (contratos v1.18.0): carpeta = proyecto sin carpeta de código; al soltar archivos se elige carpeta; "Mover a carpeta…" (documento completo); herramienta MCP opcional `organize` (listar, crear, mover, importar; rechaza archivos ocultos y claves) con aviso "la IA puede equivocarse"; diálogo "¿Dónde guardarlo?", "Nueva carpeta", selección múltiple, lo que no tiene carpeta aparece como "General"
- [ ] Convivencia con skills y otras memorias (pedido 2026-11-27): aviso en el Doctor de MCP si hay otro sistema de memoria instalado junto a Cobalt (duplica gasto y contexto) con opción de desactivarlo; medidor del contexto fijo por sesión (herramientas + reglas + traspaso, en tokens); sección en `docs/AI_GUIDE.md` sobre skills (no duplicar memorias, las reglas de Cobalt mandan si chocan)
- [ ] Pendientes menores: `outranked_by` en `MatchedNode`/`ReusableAsset` (pedido de Gemini); ajustar las heurísticas de propuestas con casos reales; ¿caducar propuestas sin revisar tras 30 días? (por decidir)
- [ ] Pendiente: hooks de Antigravity (`agy`, vía plugin `hooks.json`; formato por verificar) y de Cursor/Windsurf/Cline (sin sistema de hooks: solo instrucciones); los hooks apuntan al binario actual (reinstalar al instalar la versión final)

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
- [ ] [CLAUDE+CODEX] **Motores totalmente personalizables**: (1) conectores incluidos pgvector, Weaviate, Milvus,
      Pinecone, Elasticsearch/OpenSearch y Redis con endpoint + credenciales cifradas (cierra "credenciales
      para Qdrant remoto / Chroma"); (2) **protocolo abierto de motores** (JSON-RPC stdio/HTTP: upsert, search,
      delete, count, health) documentado en `docs/ENGINE_PLUGIN_SPEC.md` para que cualquiera escriba un
      adaptador como plugin y lo registre en Ajustes; (3) embeddings a medida: cualquier ONNX de Hugging Face
      (SHA-256 fijado al añadirlo), Ollama y APIs compatibles con OpenAI. Todo usa el swap atómico con rollback
- [ ] Posicionamiento ampliado: memoria personal y multi-IA para cualquier persona (notas, estudio y
      desarrollo), con ahorro de tokens medible y cero telemetría

## Fase 4 — Auditoría, pulido y empaquetado [PARALELO]
- [ ] [CODEX] Benchmarks, RAM Eco, OCR/re-vectorización, precisión de ahorro, cobertura
- [ ] [GEMINI] Auditoría visual, FPS/fugas WebGL, traducciones 100 %
- [x] [GEMINI] **Limpieza total de datos de ejemplo (2026-11-27):** eliminar `src/lib/backendMock.ts`, el grafo simulado (~300 nodos), proyectos/telemetría/temas ficticios y el badge MOCK; verificar que una instalación nueva arranca con el cerebro vacío (0 memorias, 0 proyectos) y sin datos precargados
- [ ] [CLAUDE] E2E completo, empaquetado `.AppImage/.deb/.rpm`, `.msi/.exe`, `.dmg`, `README.md`, reporte v1.0
- [ ] [CLAUDE+GEMINI] **Desinstalar Cobalt por completo** (pedido 2026-11-27): opción en Ajustes que elimina todo lo de Cobalt del sistema — `~/.cobalt` (cerebro, índices, modelos, temas, backups), conectores MCP y bloques de instrucciones globales en los clientes de IA, hooks de sesión y de git, arranque automático, lanzador y el propio programa. Antes pregunta "¿Guardar tus memorias?": Sí → exporta un backup completo (`.cobalt-backup`, legible también como JSON/Markdown) a una carpeta elegida y luego borra; No → se borra todo, también las memorias. Confirmación clara e irreversible; informe final de lo eliminado
- [ ] [CLAUDE] App instalada sin terminal: lanzador en el menú del sistema, arranque automático al iniciar sesión (minimizada en bandeja, desactivable), actualizaciones automáticas firmadas (`tauri-plugin-updater` + `latest.json` en GitHub Releases + clave de firma del dueño guardada como secret; GitHub Action que compila y firma Linux/Windows/macOS por tag; AppImage/msi/macOS se actualizan en 1 clic, rpm/deb solo avisan; comprobación sin datos personales y desactivable); reinstalar conectores/hooks apuntando al ejecutable instalado

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

## Propuestas pendientes de decisión (auditoría de problemáticas, 2026-11-25)
- [ ] Búsqueda que sigue el grafo (vecinos a 1 salto) + arista `depends_on` (punto 5)
- [ ] Detector de contradicciones al guardar (`possible_conflicts`) y sección "Contradicciones" en Limpiar Cerebro (punto 6)
- [ ] Defensa contra inyección de instrucciones: memorias entregadas como datos + cuarentena heurística al guardar/importar (punto 8a)
- [ ] Permisos por agente (lectura / escritura / sin acceso) en Conectores (punto 8b)
- [ ] Ahorro en dinero (precio por modelo configurable) y tiempo estimado en el dashboard (punto 9)

## Mocks activos
- Ninguno en la app (2026-11-27: `backendMock.ts` eliminado; fuera de Tauri se muestra un aviso).
- Tests: `IngestEmbedderMock`, `RestTransportMock` (Codex), `BagOfWords` (E2E MCP) — solo en `cfg(test)`.

## Solicitudes de cambio de contrato
- [x] (Codex, Fase 1) Regla FTS + `rebuild` para memorias cifradas → incorporada en `docs/CONTRACTS.md` §2.

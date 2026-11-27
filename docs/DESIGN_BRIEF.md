# Cobalt — Design brief (current app structure)

Use this to redesign Cobalt in Figma. It describes every screen, component and state that
exists today, so the new style can be applied consistently across the whole app. The visual
style will be given separately; keep the structure and content unless told otherwise.

## 1. What Cobalt is

A desktop app (Linux, Windows, macOS) that is the user's **private, local memory shared by all
their AI assistants** (Claude, Codex, Gemini, local models…). AIs save short "memories"
(decisions, notes, code snippets, documents) and search them later. Everything stays on the
computer. The centerpiece is a **3D "brain"** where every memory is a glowing point (node).

- Audience: anyone (students, writers, developers), not only programmers. Plain language.
- UI language: Spanish (default) and English. All text comes from translation files, so leave
  room for ~30 % longer strings.
- Must run smoothly on modest laptops (Intel i3, 8 GB RAM, integrated GPU, "Eco" profile).
- Dark interface today. A theme system already changes the 3D brain's colors; the app chrome
  uses the design tokens below.

## 2. App shell (every screen)

- **Window**: desktop app, minimum ~1024×640, typical 1366×768 and 1920×1080.
- **Left sidebar**, collapsible (Ctrl+B):
  - Expanded (~240 px): logo "Cobalt" + version badge, tagline "Tu memoria privada para notas,
    estudio y trabajo, compartida con todas tus IAs", then the nav list.
  - Collapsed: icon-only rail (~48 px) with tooltips.
  - Nav items in order: Cerebro 3D · Biblioteca · Telemetría · Estadísticas · Conectores ·
    Herramientas · Tienda de temas · Ajustes.
  - Footer: hardware profile badge (ECO / BALANCEADO / ULTRA) and language selector (ES/EN).
- **Top status bars** (full width, above the content, each can be dismissed):
  - *Indexing bar*: "Manteniendo al día · <proyecto> · N archivos · <archivo> · fragmento X de Y ·
    quedan ~1 min" with a pause button, an expandable list of background jobs, and progress.
  - *Live AI bar*: "EN VIVO · claude-code · Cobalt · terminó un paso" with a time and an
    expandable feed of recent AI actions (file edited, command run, turn finished).
- **Global states**: read-only mode banner, vault locked/unlocked, daemon offline, toast
  notifications (success/error), drag-and-drop overlay "Suelta archivos o carpetas en tu cerebro".
- **Quick note**: a separate small floating window (global shortcut) with one text box to save a
  memory instantly.
- **Outside the desktop app** (plain browser): a single full-screen notice "Cobalt funciona como
  aplicación de escritorio".

## 3. Screens

### 3.1 Onboarding (first run, also re-openable from Settings)
Steps: welcome + your name → hardware detection (CPU, RAM, GPU; recommended profile Eco /
Balanced / Ultra with explanation) → engine and embedding model choice (cards with size,
language support, "recommended" badge) → download with progress bar, cancel, errors.

### 3.2 Cerebro 3D (home)
- Full-bleed 3D canvas (WebGL) with thousands of nodes on a near-black background.
- **Toolbar** (top-left over the canvas): branch selector ("main"), counters "1905 nodos ·
  2 proyectos", profile chip "Eco · 30 FPS máx.", mode chip "ESCRITURA / SOLO LECTURA",
  daemon chip "Daemon · 1 IA", toggle "Mostrar conexiones", zoom / time-travel / reset-camera
  icon buttons, "Centrar vista" when needed.
- **Layouts panel** (right edge, collapsible to an icon rail): Galaxia, Cerebro, Red Neuronal,
  Árbol, Proyectos (esferas), Islas por proyecto (+ custom 3D model from themes). Each item: icon,
  name, one-line description, active state.
- **Live AI card** (bottom-left, appears when an AI reads/writes): operation tag (LECTURA,
  ESCRITURA, ACTUALIZACIÓN, REÚSO, BLOQUEADO — each has a color), AI name, the query, the first
  3 memories used (title + % match, clickable), "5 nodos iluminados · 14.896 tokens ahorrados ·
  1433 ms", expandable history of 12, close button. Nodes used by the AI pulse brightly and the
  rest dims.
- **Off-screen indicator**: pill "47 nodos fuera de vista".
- **Legend** (bottom-right): Ley Nuclear (gold), Reutilizable (violet), Decisión (blue)…
- **Filter dock** (bottom): "Filtros" button, text filter, "Solo reutilizables" toggle, file-type
  chips with counts (RS 867 · TS 747 · MD 113 · JSON 111 · NOTE 47 · OTHER 19), "1905 / 1905
  visibles".
- **Node tooltip** on hover; **empty state** for a new brain (shortcuts to import, connect AIs,
  projects); WebGL-unavailable fallback.
- **Node Inspector** (right side panel when a node is selected): content (editable), category,
  confidence, project, file link with status (available / modified / missing) and "relink",
  tokens · hits · reuses, "Agentes que usan este nodo", version history, reusable snippet,
  encrypt (vault), archive / delete with an impact dialog. OCR memories show an "OCR" badge and
  "verify in the original" note.
- **Time-travel bar** (bottom, when opened): timeline of snapshots, restore.

### 3.3 Biblioteca (reusable library)
Header + subtitle; search and filters; list/grid of reusable assets (name, origin project, file
type, disk status badge, reuse count); actions: add file, relink, retire; drag-and-drop overlay;
empty states (new library vs. no results).

### 3.4 Telemetría ("Ahorro y actividad")
KPI cards (tokens saved total / session, compression ratio), chart "Lecturas vs Reúso" over
time, per-AI breakdown table, top memories, "Historial de consultas" (searchable table: time,
AI, query, results, tokens, latency; each row can be replayed in 3D), empty state.

### 3.5 Estadísticas (new)
- Three cards: Hoy · Esta semana · Este año (number of AI requests).
- **Yearly heatmap** like GitHub contributions: rows Mon…Sun, one column per week, month labels,
  one rounded square per day, 5 intensity levels of the accent color, tooltip with the day's
  numbers, year selector, legend "Menos ▢▢▢▢▢ Más".
- **Fun facts grid**: tokens saved (year / all time), AI that uses Cobalt most, busiest hour
  (mini bar chart of 24 hours), favorite weekday, current and best streak, busiest day, most used
  project, using Cobalt since, split by request type.
- States: loading, "Disponible pronto", empty.

### 3.6 Conectores ("Conectores de IA")
- **01 Asistentes compatibles (1 clic)**: one card per AI (Claude Desktop, Claude Code, Cursor,
  Windsurf, Cline, Gemini CLI, Codex CLI): status (Detectado / No detectado / Conectado /
  Necesita reparación), on/off switch, "Configuración manual" link, last backup path.
- **02 Captura automática**: toggles (watch projects, session summaries, git commits, global
  instructions, session hooks) with explanations and a live feed.
- **03 Configuración manual**: AI selector, code block to copy, "Pégalo en: <file path>" with
  copy-path button, hint text.
- **MCP Doctor**: list of health checks (ok / warning / error) with one-click fixes.
- **Modo Pro panel** (when enabled): local REST API + Swagger, hot engine/model swap with
  progress, search ranking sliders, MCP tool descriptions editor.

### 3.7 Herramientas ("Herramientas y mudanza")
Sections as cards: Proyectos (list, color, watch toggle, archive), web-AI bridge (copy context
for ChatGPT/Claude web), Importador (files, folders, past AI chats; report with counts), Cápsulas
(export/import a topic), Copias de seguridad (export/import), Ramas de memoria (create, switch,
merge, discard), Snapshots / time-travel, Limpiar Cerebro (duplicate clusters to merge), Depurador
RAG (query → table of vector/keyword scores and token cost).

### 3.8 Tienda de temas
Search; theme cards (preview image, name, author, version, exact download size, unpacked size,
compatibility badge compatible / degradado / incompatible); install, uninstall, apply; install
from file (drag-and-drop .cobalt-theme); compile warnings for theme shaders; empty and error
states.

### 3.9 Ajustes
Sections: General (name, language), Hardware & onboarding (summary, re-run), Motor y modelo
(engine, embedding model, "Guardar preferencias", "Cambiar motor y re-indexar" with progress),
**Texto en imágenes (OCR)** (two engine cards: PaddleOCR "Recomendado" and ocrs; install /
use / remove, progress, comparison table, always-visible amber accuracy warning), Apariencia
(disable theme shaders), Captura automática (pause indexing, auto-watch, session summaries,
git commits), Modo Solo Lectura, Modo Pro, Acerca de (app and contract versions).

## 4. Shared components to design once

Buttons (primary, secondary, ghost, danger, icon), toggles, selects/dropdowns, text inputs,
search field, chips/badges (status, category, operation, file type), cards and section headers
(numbered "01 —"), tables, progress bars (determinate / indeterminate, with cancel), toasts,
banners (info / warning / error), modal dialogs (confirm, destructive with impact list), side
panel (inspector), tooltips, empty states (icon + title + text + action), code block with copy
button, KPI card, heatmap cell, mini bar chart, collapsible rail (sidebar and layouts panel).

## 5. Current design tokens (to be replaced by the new style)

- Background `#0B0C0E`; surfaces `#111317`, `#171A21`, `#1F232C`; borders `#23262F`, `#363C4A`.
- Text `#ECE9E1`, muted `#A4A096`, subtle `#6F6C65`.
- Accent cobalt `#0047AB` / bright `#1C5ED6` / ink `#79A8FF` / wash `#0F1C35`.
- Semantic: ochre (warning) `#D4A359`, verdigris (success) `#34B37E`, cinnabar (error)
  `#E05252`.
- Live AI pulses: read `#60A5FA`, reuse `#A78BFA`, write `#34D399`, update `#FBBF24`,
  blocked `#F87171`.
- Fonts: IBM Plex Serif (display), IBM Plex Sans (UI), IBM Plex Mono (data, labels, code).
  Bundled locally (no web fonts at runtime).
- Shape: small radius (2 px), thin 1 px borders, dense information, monospace uppercase labels.

## 6. Constraints for the new design

- Keep the 3D brain as the hero: chrome must not cover the center of the canvas; overlays stay
  on the edges and are collapsible.
- Everything must work at 1366×768 without horizontal scrolling; panels collapse on narrow
  windows.
- Accessible contrast (WCAG AA) on dark backgrounds; status never by color alone (icon + text).
- Long Spanish strings, numbers with thousands separators ("14.896"), dates "12 mar".
- Deliver: color, type, spacing and radius tokens; light and dark variants if the style allows;
  the component set above; and key screens (Cerebro 3D with live card + inspector, Estadísticas,
  Conectores, Ajustes, Onboarding).

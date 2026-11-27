# Cobalt Themes — `.cobalt-theme` Specification (v1.1.0)

Owner: **[CLAUDE]** (Theme Store Manager in `src-tauri`, Rust DTOs in `cobalt_core::theme`).
Consumers: **[GEMINI]** (`src/components/store/`, `src/components/canvas3d/`).

## 1. Principles

1. The base app bundles **only one** theme: `cobalt-minimal` (`src/themes/minimal/manifest.json`).
2. **No hidden downloads.** Searching the store fetches a small `registry.json` **into memory**
   (never written to disk). Packages are downloaded only after an explicit "Install" click.
3. A theme is **data only**: JSON + WebP + GLSL + GLB. No code is ever executed from a theme.
4. Install = verify + extract to `~/.cobalt/themes/<id>/`; uninstall = delete that folder
   immediately and remove the `installed_themes` row.

## 2. Package format

`.cobalt-theme` = ZIP archive (deflate or zstd entries) with this exact whitelist:

```
manifest.json            (required, ≤ 64 KiB)
preview.webp             (required, ≤ 1 MiB)
shaders/<name>.glsl      (optional, each ≤ 256 KiB, UTF-8 text)
meshes/<name>.glb        (optional, binary glTF only)
```

`<name>` matches `^[a-z0-9][a-z0-9_-]{0,63}$`. Nothing else is accepted.

### Sandbox rules (enforced in Rust before anything touches the final folder)

| Rule | Limit |
|---|---|
| Whitelist | Only the paths above. Directories other than `shaders/` and `meshes/` are rejected. |
| Forbidden | Any `.js .mjs .cjs .ts .tsx .jsx .wasm .html .htm .svg .exe .dll .so .dylib .sh .bat .cmd .ps1 .app .bin .py` (`THEME_FORBIDDEN_EXTENSIONS`), even inside allowed dirs. |
| Path traversal | Reject absolute paths, `..` components, backslashes, drive letters, symlinks, NUL bytes. |
| Size | Total uncompressed ≤ **25 MiB** (`THEME_MAX_UNPACKED_BYTES`), counted while streaming (never trusting headers). |
| Entries | ≤ 128 (`THEME_MAX_ENTRIES`). |
| Zip bomb | Per-entry compression ratio ≤ 100 (`THEME_MAX_COMPRESSION_RATIO`); abort on first violation. |
| Magic bytes | `preview.webp` must start with `RIFF....WEBP`; `.glb` with `glTF` v2. |
| Integrity | Registry downloads must match `sha256`; size must equal `size_bytes`. |
| Atomicity | Extract into `~/.cobalt/themes/.staging-<uuid>/`, validate, then rename to `<id>/`. |

Shaders are loaded as strings by the frontend and compiled by WebGL only; they cannot access
the filesystem or network. Assets are served through Tauri's asset protocol scoped to
`$HOME/.cobalt/themes/**`.

## 3. `manifest.json`

```json
{
  "id": "nebula-dream",
  "name": "Nebula Dream",
  "author": "Jane Doe",
  "version": "1.2.0",
  "description": "Soft volumetric nebula with bloom.",
  "hardware_tier": "balanced",
  "layout_type": "galaxy",
  "layout_params": {
    "level_spacing": 18,
    "radial_spread": 40,
    "show_virtual_anchors": true,
    "semantic_edges_mode": "hover_only"
  },
  "palette": {
    "background": "#05070D",
    "node": "#3B82F6",
    "core_pin": "#FACC15",
    "reusable": "#A78BFA",
    "edge": "#1E3A8A",
    "text": "#E2E8F0",
    "pulse_read": "#60A5FA",
    "pulse_reuse": "#A78BFA",
    "pulse_write": "#34D399",
    "pulse_update": "#FBBF24",
    "pulse_blocked": "#F87171",
    "category_colors": { "decision": "#60A5FA", "code": "#34D399" }
  },
  "node_geometry": { "shape": "icosahedron", "base_size": 0.6, "scale_by_hits": true, "detail": 1 },
  "camera": { "position": [0, 40, 160], "target": [0, 0, 0], "fov": 55, "auto_rotate": true, "auto_rotate_speed": 0.3 },
  "shaders": {
    "node_vertex": "shaders/node.vert.glsl",
    "node_fragment": "shaders/node.frag.glsl",
    "edge_vertex": null,
    "edge_fragment": null,
    "background_fragment": "shaders/nebula.glsl"
  },
  "mesh_path": null
}
```

| Field | Rule |
|---|---|
| `id` | `^[a-z0-9][a-z0-9-]{1,63}$`; folder name; must not be `cobalt-minimal` for third parties. |
| `version` | SemVer. |
| `hardware_tier` | `eco` \| `balanced` \| `ultra` — minimum recommended tier. |
| `layout_type` | `galaxy` \| `brain` \| `neural_net` \| `knowledge_tree` \| `project_clusters` \| `custom_mesh`. |
| `layout_params` | Optional; defaults `level_spacing 18`, `radial_spread 40`, `show_virtual_anchors true`, `semantic_edges_mode "hover_only"`. |
| `palette` | Optional; every color `#RRGGBB`; defaults shown above. |
| `node_geometry.shape` | `sphere` \| `icosahedron` \| `octahedron` \| `box` \| `point` \| `mesh`. |
| `shaders.*` | Optional; each path must be `shaders/<name>.glsl` and exist in the package. |
| `mesh_path` | Required iff `layout_type = custom_mesh`; must be `meshes/<name>.glb`. |

Unknown fields are ignored (forward compatible).

## 4. Remote registry (`registry.json`)

Hosted on a static CDN (GitHub Raw / Cloudflare, $0). A bundled fallback catalog is used in
development. Fetched with `reqwest` into memory only.

```json
{
  "schema_version": 1,
  "updated_at": "2026-11-25T00:00:00Z",
  "themes": [
    {
      "id": "nebula-dream", "name": "Nebula Dream", "author": "Jane Doe", "version": "1.2.0",
      "description": "Soft volumetric nebula with bloom.",
      "size_bytes": 1843200, "unpacked_size_bytes": 4200000,
      "hardware_tier": "balanced", "layout_type": "galaxy",
      "preview_url": "https://…/nebula-dream/preview.webp",
      "download_url": "https://…/nebula-dream-1.2.0.cobalt-theme",
      "sha256": "<64 hex chars>"
    }
  ]
}
```

Only `https://` URLs are accepted. Preview images are displayed from their URL (CSP allows
`https:` images); nothing is cached to disk.

## 5. Transparency card & compatibility

Each card shows preview, author, **exact download size** (`size_bytes`), unpacked size and a
compatibility badge computed against the detected profile (`ThemeCompatibility`):

| Theme tier \ User tier | eco | balanced | ultra |
|---|---|---|---|
| eco | compatible | compatible | compatible |
| balanced | degraded | compatible | compatible |
| ultra | incompatible | degraded | compatible |

`degraded` themes install but the renderer disables post-processing and complex shaders.

## 6. Rendering rules (frontend)

- `@react-three/postprocessing` (bloom) is loaded lazily **only** on the Ultra profile.
- Eco: `InstancedMesh`, no shadows, no post-processing, FPS cap 30/60, `semantic_edges_mode`
  forced to `hover_only` when it is `always`.
- On theme or layout change, dispose every geometry, material, texture and render target
  created for the previous theme (no WebGL leaks).

- Live AI activity must be noticeable (v1.1.1): pulse colors are rendered luminous (lightened, white
  core), halo 3–4× node size, ~6 s with fade, other nodes dimmed while pulses are active, and an
  off-screen indicator when matched nodes are not visible. Dark pulse colors are discouraged.

## 6.1 Node rendering & scalability (decision, Phase 2)

Nodes are **flat, camera-facing sprites inside a 3D space** (billboards), not volumetric meshes:
- Default `node_geometry.shape = "point"`: one `THREE.Points` (or one instanced quad) draw call with
  a small fragment shader for the round disc, halo (Nuclear Laws) and pulse glow. No lighting.
- Volumetric shapes (`sphere`, `icosahedron`, ...) are opt-in for themes on `balanced`/`ultra`
  and must automatically fall back to points above 5,000 visible nodes.
- Must stay fluid as the DB grows: GPU buffers updated in place (positions/colors/sizes as
  attributes, filters = size 0), no per-node React components, labels only for hovered/selected
  nodes, edges only on hover/selection in Eco, picking via a spatial index (not per-node raycasts).
- Target: 50,000 nodes at 30 FPS in Eco on integrated GPUs.

## 6.2 Theme shaders, node shapes and custom meshes (v1.1.0)

Custom GLSL replaces the built-in program of one layer. It is compiled by WebGL only (WebGL1/GLSL ES
1.00 syntax; three.js prepends its usual `modelViewMatrix`, `projectionMatrix`, `position`, `uv`
declarations). A shader that fails to compile or link falls back to the built-in one for that layer
and the Store/brain shows a non-blocking warning with the compiler log (first 20 lines).

| Layer (manifest key) | Inputs provided by Cobalt | Must write |
|---|---|---|
| `node_vertex` / `node_fragment` (points) | attributes `aColor` (vec3), `aSize` (float, 0 = hidden), `aMeta` (vec4: x isCorePin, y isReusable, z focus 0 none/1 hover/2 selected/3 RAG hit, w opacity scale), `aPulse` (vec4: rgb operation color, a intensity 0..1); uniforms `uTime` (s), `uPixelRatio`, `uScaleFactor`, `uMinPointSize`, `uMaxPointSize`, `uCorePinColor` (vec3) | vertex: `gl_Position`, `gl_PointSize`; fragment: `gl_FragColor` |
| `edge_vertex` / `edge_fragment` | attribute `color` (vec3); uniforms `uTime`, `uOpacity` | `gl_Position` / `gl_FragColor` |
| `background_fragment` | full-screen quad behind the scene; varying `vUv` (vec2 0..1); uniforms `uTime`, `uResolution` (vec2, px), `uBackground` (vec3 = `palette.background`) | `gl_FragColor` |

A vertex shader may be given without its fragment (or vice versa); the other half stays built-in
and must use the same varyings (`vColor`, `vMeta`, `vPulse` for nodes).

**Safety & performance (renderer-enforced):**
- Custom shaders are disabled in Eco and for `degraded` themes (same as post-processing).
- Watchdog: if the average frame time stays above 100 ms for 3 s while custom shaders are active,
  they are switched off for the session and the user is told (protects against GPU-hanging loops).
- Settings → Appearance offers "Disable theme shaders" (persisted per device, local only).

**Node shapes.** `node_geometry.shape = point` uses the point program above. Volumetric shapes
(`sphere`, `icosahedron`, `octahedron`, `box`) render as one `InstancedMesh` (unlit, per-instance
color/scale, `detail` = subdivision level ≤ 3) on `balanced`/`ultra` only, and fall back to points in
Eco or above 5,000 visible nodes. `mesh` uses the first mesh of `mesh_path` as the instance
geometry (≤ 2,000 triangles, else points). Custom node shaders apply only to points.

**`custom_mesh` layout.** The GLB at `mesh_path` is loaded (first scene, transforms applied,
normalized to a 100-unit bounding sphere) and drawn as a faint wireframe/solid backdrop using
`palette.edge` at 15 % opacity. Each memory is placed on the mesh surface at a deterministic point:
vertex index = FNV-1a(memory id) mod vertex count, offset along the vertex normal by
`layout_params.level_spacing × 0.05`. Nuclear Laws use the vertices closest to the mesh centroid.
Load failure falls back to `galaxy` with a warning. Mesh limits: ≤ 200,000 vertices.

## 7. Built-in theme

`cobalt-minimal` (`src/themes/minimal/manifest.json`): `eco` tier, `galaxy` layout, default
palette, point-sprite nodes, no custom shaders, no meshes. It cannot be uninstalled.

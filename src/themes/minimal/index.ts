import rawManifest from "./manifest.json";
import type {
  HardwareTier,
  LayoutType,
  MemoryCategory,
  NodeShape,
  SemanticEdgesMode,
  ThemeManifest,
  Vec3,
} from "@/types/contracts";

function asVec3(coords: readonly number[]): Vec3 {
  return [coords[0] ?? 0, coords[1] ?? 0, coords[2] ?? 0];
}

/**
 * Built-in `cobalt-minimal` theme manifest loaded from `src/themes/minimal/manifest.json`.
 * Typed strictly against `ThemeManifest` from `src/types/contracts.ts`.
 */
export const MINIMAL_THEME_MANIFEST: ThemeManifest = {
  id: rawManifest.id,
  name: rawManifest.name,
  author: rawManifest.author,
  version: rawManifest.version,
  description: rawManifest.description,
  hardware_tier: rawManifest.hardware_tier as HardwareTier,
  layout_type: rawManifest.layout_type as LayoutType,
  layout_params: {
    level_spacing: rawManifest.layout_params.level_spacing,
    radial_spread: rawManifest.layout_params.radial_spread,
    show_virtual_anchors: rawManifest.layout_params.show_virtual_anchors,
    semantic_edges_mode: rawManifest.layout_params.semantic_edges_mode as SemanticEdgesMode,
  },
  palette: {
    ...rawManifest.palette,
    category_colors: rawManifest.palette.category_colors as Partial<
      Record<MemoryCategory, string>
    >,
  },
  node_geometry: {
    shape: rawManifest.node_geometry.shape as NodeShape,
    base_size: rawManifest.node_geometry.base_size,
    scale_by_hits: rawManifest.node_geometry.scale_by_hits,
    detail: rawManifest.node_geometry.detail,
  },
  camera: {
    position: asVec3(rawManifest.camera.position),
    target: asVec3(rawManifest.camera.target),
    fov: rawManifest.camera.fov,
    auto_rotate: rawManifest.camera.auto_rotate,
    auto_rotate_speed: rawManifest.camera.auto_rotate_speed,
  },
  shaders: { ...rawManifest.shaders },
  mesh_path: rawManifest.mesh_path,
};

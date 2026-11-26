import type {
  LayoutFn,
  LayoutResult,
  MemoryCategory,
  Vec3,
  VirtualAnchor,
} from "@/types/contracts";

/** Fast deterministic 32-bit FNV-1a hash returning [0, 1). */
function hash01(input: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

const REGION_BY_CATEGORY: Record<
  MemoryCategory,
  { hemi: -1 | 0 | 1; zBias: number; yBias: number; label: string }
> = {
  decision: { hemi: 0, zBias: 0.55, yBias: 0.15, label: "Prefrontal" },
  preference: { hemi: 0, zBias: 0.42, yBias: -0.15, label: "Prefrontal" },
  code: { hemi: -1, zBias: 0.02, yBias: 0.12, label: "Left Cortex" },
  doc: { hemi: 1, zBias: 0.02, yBias: 0.12, label: "Right Cortex" },
  note: { hemi: 0, zBias: -0.58, yBias: 0.04, label: "Occipital" },
  ocr: { hemi: 0, zBias: -0.15, yBias: -0.5, label: "Temporal" },
};

/**
 * Pure deterministic `brain` layout (`LayoutFn`).
 * Maps nodes onto two anatomical cerebral hemispheres separated by a longitudinal
 * fissure, with subtle gyri surface modulation and Nuclear Laws anchored in the
 * central corpus callosum core.
 */
export const brainLayout: LayoutFn = ({ nodes, params }) => {
  const nodePositions: Record<string, Vec3> = {};
  const scale = Math.max(24, params.radial_spread * 1.45);
  const rx = scale * 0.52; // width of each hemisphere
  const ry = scale * 0.68; // vertical height
  const rz = scale * 0.96; // front-to-back depth
  const fissureGap = scale * 0.14;

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!node) continue;

    const u1 = hash01(node.id, 17);
    const u2 = hash01(node.id, 43);
    const u3 = hash01(node.id, 97);

    // Nuclear Laws sit in the luminous central corpus callosum bridge
    if (node.is_core_pin) {
      const angle = u1 * Math.PI * 2;
      const r = scale * (0.08 + u2 * 0.18);
      const cx = (u3 - 0.5) * fissureGap * 1.6;
      const cy = Math.cos(angle) * r * 0.7;
      const cz = Math.sin(angle) * r * 1.5;
      nodePositions[node.id] = [cx, cy, cz];
      continue;
    }

    const region = REGION_BY_CATEGORY[node.category] ?? REGION_BY_CATEGORY.note;
    const hemiSign = region.hemi !== 0 ? region.hemi : u1 < 0.5 ? -1 : 1;

    // Sample unit sphere biased toward the category's cortical lobe
    const theta = u1 * Math.PI * 2;
    const rawZ = Math.max(-0.98, Math.min(0.98, (u2 * 2 - 1) * 0.72 + region.zBias * 0.55));
    const ring = Math.sqrt(Math.max(0.001, 1 - rawZ * rawZ));
    let sx = Math.abs(Math.cos(theta) * ring);
    let sy = Math.sin(theta) * ring + region.yBias * 0.32;
    let sz = rawZ;

    // Normalize onto ellipsoid shell with cortical thickness + gentle gyri folds
    const mag = Math.hypot(sx, sy, sz) || 1;
    sx /= mag;
    sy /= mag;
    sz /= mag;

    const gyri = 1 + 0.065 * Math.sin(sz * 11 + sy * 7) * Math.cos(sx * 9);
    const shellDepth = 0.74 + Math.pow(u3, 0.55) * 0.26;
    const factor = gyri * shellDepth;

    // Slight downward tuck in occipital/temporal base for realistic silhouette
    const temporalDip = sy < -0.2 ? (sy + 0.2) * 0.18 : 0;
    const x = hemiSign * (fissureGap + sx * rx * factor);
    const y = (sy + temporalDip) * ry * factor;
    const z = sz * rz * factor;

    nodePositions[node.id] = [x, y, z];
  }

  const virtualAnchors: VirtualAnchor[] | undefined = params.show_virtual_anchors
    ? [
        {
          id: "anchor:brain:prefrontal",
          label: "Prefrontal",
          position: [0, ry * 0.18, rz * 0.88],
          kind: "region",
          color: "#60A5FA",
        },
        {
          id: "anchor:brain:left",
          label: "Left Cortex",
          position: [-(fissureGap + rx * 0.85), ry * 0.12, 0],
          kind: "region",
          color: "#34D399",
        },
        {
          id: "anchor:brain:right",
          label: "Right Cortex",
          position: [fissureGap + rx * 0.85, ry * 0.12, 0],
          kind: "region",
          color: "#FBBF24",
        },
        {
          id: "anchor:brain:occipital",
          label: "Occipital",
          position: [0, ry * 0.05, -rz * 0.88],
          kind: "region",
          color: "#94A3B8",
        },
        {
          id: "anchor:brain:core",
          label: "Corpus Callosum",
          position: [0, 0, 0],
          kind: "region",
          color: "#FACC15",
        },
      ]
    : undefined;

  const structuralEdges: Array<[string, string]> | undefined = params.show_virtual_anchors
    ? [
        ["anchor:brain:core", "anchor:brain:prefrontal"],
        ["anchor:brain:core", "anchor:brain:left"],
        ["anchor:brain:core", "anchor:brain:right"],
        ["anchor:brain:core", "anchor:brain:occipital"],
      ]
    : undefined;

  const result: LayoutResult = { nodePositions, virtualAnchors, structuralEdges };
  return result;
};

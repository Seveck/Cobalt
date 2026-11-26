import type {
  GraphNode,
  LayoutFn,
  LayoutResult,
  Vec3,
  VirtualAnchor,
} from "@/types/contracts";

interface LayerSpec {
  id: string;
  label: string;
  color: string;
}

const LAYERS: readonly LayerSpec[] = [
  { id: "anchor:nn:layer0", label: "Input · Notes & OCR", color: "#94A3B8" },
  { id: "anchor:nn:layer1", label: "Context · Docs & Prefs", color: "#FBBF24" },
  { id: "anchor:nn:layer2", label: "Patterns · Code & Assets", color: "#34D399" },
  { id: "anchor:nn:layer3", label: "Synthesis · Decisions", color: "#60A5FA" },
  { id: "anchor:nn:layer4", label: "Core · Nuclear Laws", color: "#FACC15" },
];

function classifyLayer(node: GraphNode): number {
  if (node.is_core_pin) return 4;
  if (node.category === "decision") return 3;
  if (node.category === "code" || node.is_reusable) return 2;
  if (node.category === "doc" || node.category === "preference") return 1;
  return 0;
}

/**
 * Pure deterministic `neural_net` layout (`LayoutFn`).
 * Arranges memories in 5 parallel feed-forward layers along the X axis,
 * spaced by `params.level_spacing`, with each layer organized as a clean
 * golden-ratio lattice plane.
 */
export const neuralNetLayout: LayoutFn = ({ nodes, params }) => {
  const nodePositions: Record<string, Vec3> = {};
  const spacing = Math.max(14, params.level_spacing * 1.65);
  const spread = Math.max(20, params.radial_spread * 1.25);

  const buckets: GraphNode[][] = LAYERS.map(() => []);
  for (const node of nodes) {
    const layerIdx = classifyLayer(node);
    buckets[layerIdx]?.push(node);
  }

  const halfSpan = ((LAYERS.length - 1) * spacing) / 2;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let layerIdx = 0; layerIdx < buckets.length; layerIdx += 1) {
    const bucket = buckets[layerIdx];
    if (!bucket) continue;
    // Stable deterministic ordering within each layer
    bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const layerX = layerIdx * spacing - halfSpan;
    const count = Math.max(1, bucket.length);
    const layerRadius = Math.min(spread, 14 + Math.sqrt(count) * 4.2);

    for (let i = 0; i < bucket.length; i += 1) {
      const node = bucket[i];
      if (!node) continue;

      const t = (i + 0.5) / count;
      const r = Math.sqrt(t) * layerRadius;
      const theta = i * goldenAngle;
      const y = Math.cos(theta) * r;
      const z = Math.sin(theta) * r;
      const depthJitter = ((i % 5) - 2) * 0.7;

      nodePositions[node.id] = [layerX + depthJitter, y, z];
    }
  }

  const virtualAnchors: VirtualAnchor[] | undefined = params.show_virtual_anchors
    ? LAYERS.map((layer, idx) => ({
        id: layer.id,
        label: layer.label,
        position: [idx * spacing - halfSpan, spread * 0.92, 0] as Vec3,
        kind: "layer",
        color: layer.color,
      }))
    : undefined;

  const structuralEdges: Array<[string, string]> | undefined = params.show_virtual_anchors
    ? [
        ["anchor:nn:layer0", "anchor:nn:layer1"],
        ["anchor:nn:layer1", "anchor:nn:layer2"],
        ["anchor:nn:layer2", "anchor:nn:layer3"],
        ["anchor:nn:layer3", "anchor:nn:layer4"],
      ]
    : undefined;

  const result: LayoutResult = { nodePositions, virtualAnchors, structuralEdges };
  return result;
};

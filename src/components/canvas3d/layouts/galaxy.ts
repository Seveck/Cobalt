import type { LayoutFn, LayoutResult, Vec3 } from "@/types/contracts";

/**
 * Pure deterministic `galaxy` layout (`LayoutFn`).
 * Uses cached backend 3D coordinates when present (`node.position`), and falls back
 * to a deterministic golden-angle spiral inside the radius-100 sphere otherwise.
 */
export const galaxyLayout: LayoutFn = ({ nodes, params }) => {
  const nodePositions: Record<string, Vec3> = {};
  const spread = Math.max(12, params.radial_spread);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const count = Math.max(1, nodes.length);

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!node) continue;

    if (node.position) {
      nodePositions[node.id] = node.position;
      continue;
    }

    const t = (i + 0.5) / count;
    const radius = Math.sqrt(t) * spread * 1.9;
    const theta = i * goldenAngle;
    const y = (Math.sin(i * 0.37) * 0.5 + (t - 0.5) * 0.4) * params.level_spacing;
    nodePositions[node.id] = [
      Math.cos(theta) * radius,
      y,
      Math.sin(theta) * radius,
    ];
  }

  const result: LayoutResult = { nodePositions };
  return result;
};

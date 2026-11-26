import type {
  GraphNode,
  LayoutFn,
  LayoutResult,
  ProjectContainer,
  Vec3,
  VirtualAnchor,
} from "@/types/contracts";

const GLOBAL_KEY = "__global__";
const GLOBAL_COLOR = "#94A3B8";

/**
 * Pure deterministic `project_clusters` layout (`LayoutFn`).
 * Groups nodes into spherical project containers colored by `projects.color_hex`
 * (plus a Global container for `project_id === null`). Container radii scale
 * dynamically with `sizeMetric` (`"vectors"` vs `"tokens"`).
 */
export const projectClustersLayout: LayoutFn = ({ nodes, projects, params, sizeMetric }) => {
  const nodePositions: Record<string, Vec3> = {};
  const projectContainers: ProjectContainer[] = [];
  const virtualAnchors: VirtualAnchor[] = [];

  const projectMeta = new Map(
    projects.map((stat) => [
      stat.project.id,
      {
        label: stat.project.name,
        color: stat.project.color_hex,
      },
    ]),
  );

  // Bucket nodes by project_id (or global)
  const buckets = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = node.project_id ?? GLOBAL_KEY;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(node);
  }

  // Ensure even empty projects from stats are represented if nodes exist, or only populated ones
  const entries = [...buckets.entries()].map(([key, bucket]) => {
    const vectorCount = bucket.length;
    const totalTokens = bucket.reduce((sum, n) => sum + n.chunk_tokens, 0);
    const metricVal = sizeMetric === "tokens" ? Math.max(1, totalTokens) : Math.max(1, vectorCount);
    const meta =
      key === GLOBAL_KEY
        ? { label: "Global", color: GLOBAL_COLOR }
        : (projectMeta.get(key) ?? { label: key.slice(0, 8), color: "#3B82F6" });
    return {
      key,
      projectId: key === GLOBAL_KEY ? null : key,
      label: meta.label,
      color: meta.color,
      bucket,
      vectorCount,
      totalTokens,
      metricVal,
    };
  });

  // Sort deterministically: largest metric first, global last
  entries.sort((a, b) => {
    if (a.projectId === null && b.projectId !== null) return 1;
    if (b.projectId === null && a.projectId !== null) return -1;
    if (b.metricVal !== a.metricVal) return b.metricVal - a.metricVal;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const maxMetric = entries.reduce((m, e) => Math.max(m, e.metricVal), 1);
  const spread = Math.max(30, params.radial_spread * 1.45);
  const minR = 11;
  const maxR = Math.min(34, spread * 0.56);

  // Compute radii first so centers are cleanly separated without overlap
  const radii = entries.map((e) => {
    const normalized = Math.cbrt(e.metricVal / maxMetric);
    return minR + normalized * (maxR - minR);
  });

  const count = entries.length;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let cIdx = 0; cIdx < count; cIdx += 1) {
    const entry = entries[cIdx]!;
    const radius = radii[cIdx] ?? minR;

    let center: Vec3;
    if (count === 1) {
      center = [0, 0, 0];
    } else if (count <= 5) {
      const angle = (cIdx / count) * Math.PI * 2;
      const ringR = Math.max(spread * 0.85, maxR * 1.85);
      const yOffset = cIdx % 2 === 0 ? params.level_spacing * 0.35 : -params.level_spacing * 0.35;
      center = [Math.cos(angle) * ringR, yOffset, Math.sin(angle) * ringR];
    } else {
      const angle = cIdx * goldenAngle;
      const ringR = Math.sqrt(cIdx + 0.6) * (maxR * 1.45);
      const yOffset = Math.sin(cIdx * 1.7) * params.level_spacing * 0.8;
      center = [Math.cos(angle) * ringR, yOffset, Math.sin(angle) * ringR];
    }

    const containerId = `container:${entry.key}`;
    projectContainers.push({
      id: containerId,
      projectId: entry.projectId,
      label: entry.label,
      center,
      radius,
      vectorCount: entry.vectorCount,
      totalTokens: entry.totalTokens,
      color: entry.color,
    });

    virtualAnchors.push({
      id: `anchor:cluster:${entry.key}`,
      label: entry.label,
      position: [center[0], center[1] + radius + 3.5, center[2]],
      kind: "project",
      color: entry.color,
    });

    // Distribute nodes inside the container via deterministic Fibonacci sphere volume
    const bucket = [...entry.bucket].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const nCount = Math.max(1, bucket.length);

    for (let i = 0; i < bucket.length; i += 1) {
      const node = bucket[i];
      if (!node) continue;

      const t = (i + 0.5) / nCount;
      const phi = Math.acos(1 - 2 * t);
      const theta = i * goldenAngle;
      // Nuclear Laws sit prominently near the core; other nodes fill the shell cleanly
      const rFactor = node.is_core_pin ? 0.24 + (i % 4) * 0.07 : 0.35 + Math.cbrt(t) * 0.54;
      const r = radius * rFactor;

      const sinPhi = Math.sin(phi);
      nodePositions[node.id] = [
        center[0] + r * sinPhi * Math.cos(theta),
        center[1] + r * Math.cos(phi),
        center[2] + r * sinPhi * Math.sin(theta),
      ];
    }
  }

  const result: LayoutResult = {
    nodePositions,
    projectContainers,
    virtualAnchors: params.show_virtual_anchors ? virtualAnchors : undefined,
  };
  return result;
};

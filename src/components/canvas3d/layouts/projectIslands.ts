import { GENERAL_FOLDER_COLOR, resolveProjectColor } from "@/lib/projects";
import {
  MEMORY_CATEGORIES,
  type GraphNode,
  type LayoutFn,
  type LayoutResult,
  type MemoryCategory,
  type ProjectContainer,
  type Vec3,
  type VirtualAnchor,
} from "@/types/contracts";

const GLOBAL_KEY = "__global__";
const GLOBAL_COLOR = GENERAL_FOLDER_COLOR;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

interface IslandBucket {
  key: string;
  projectId: string | null;
  label: string;
  color: string;
  nodes: GraphNode[];
  vectorCount: number;
  totalTokens: number;
  radius: number;
}

/**
 * Pure deterministic `project_islands` layout (`LayoutFn`).
 *
 * Each project (plus Global for `project_id === null`) is a separate flat disc
 * island on the XZ plane with thin vertical height, laid out on a readable grid
 * with clear gaps. Island radius scales with node count, and nodes spread
 * deterministically inside their island by category rings and a golden-angle spiral.
 */
export const projectIslandsLayout: LayoutFn = ({ nodes, projects, params }) => {
  const nodePositions: Record<string, Vec3> = {};
  const projectContainers: ProjectContainer[] = [];
  const virtualAnchors: VirtualAnchor[] = [];

  const projectMeta = new Map(
    projects.map((stat) => [
      stat.project.id,
      {
        label: stat.project.name,
        color: resolveProjectColor(stat.project),
      },
    ]),
  );

  // Bucket nodes by project_id (or Global)
  const buckets = new Map<string, GraphNode[]>();
  for (const stat of projects) {
    if (!stat.project.is_archived && !buckets.has(stat.project.id)) {
      buckets.set(stat.project.id, []);
    }
  }
  for (const node of nodes) {
    const key = node.project_id ?? GLOBAL_KEY;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(node);
  }
  // Ensure at least a Global island exists if the brain is completely empty
  if (buckets.size === 0) {
    buckets.set(GLOBAL_KEY, []);
  }

  const minR = 14;
  const maxR = 44;

  const entries: IslandBucket[] = [...buckets.entries()].map(([key, bucket]) => {
    const vectorCount = bucket.length;
    const totalTokens = bucket.reduce((sum, n) => sum + n.chunk_tokens, 0);
    const meta =
      key === GLOBAL_KEY
        ? { label: "General", color: GLOBAL_COLOR }
        : (projectMeta.get(key) ?? { label: key.slice(0, 8), color: "#3B82F6" });
    // Area scales linearly with node count => radius scales with sqrt(nodeCount)
    const radius = Math.min(maxR, Math.max(minR, 13 + Math.sqrt(vectorCount) * 2.5));
    return {
      key,
      projectId: key === GLOBAL_KEY ? null : key,
      label: meta.label,
      color: meta.color,
      nodes: bucket,
      vectorCount,
      totalTokens,
      radius,
    };
  });

  // Sort deterministically: largest node count first, tie-break by label/key, Global last
  entries.sort((a, b) => {
    if (a.projectId === null && b.projectId !== null) return 1;
    if (b.projectId === null && a.projectId !== null) return -1;
    if (b.vectorCount !== a.vectorCount) return b.vectorCount - a.vectorCount;
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  // Lay islands out on a readable centered XZ grid with guaranteed gaps
  const count = entries.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const gap = Math.max(22, params.radial_spread * 0.6);

  const rows: IslandBucket[][] = [];
  for (let i = 0; i < count; i += cols) {
    rows.push(entries.slice(i, i + cols));
  }

  const rowDepths = rows.map((row) =>
    row.reduce((maxD, item) => Math.max(maxD, item.radius * 2), minR * 2),
  );
  const totalDepth =
    rowDepths.reduce((sum, d) => sum + d, 0) + Math.max(0, rows.length - 1) * gap;

  let zCursor = -totalDepth / 2;

  for (let rIdx = 0; rIdx < rows.length; rIdx += 1) {
    const row = rows[rIdx]!;
    const rowDepth = rowDepths[rIdx] ?? minR * 2;
    const cz = zCursor + rowDepth / 2;

    const rowWidth =
      row.reduce((sum, item) => sum + item.radius * 2, 0) + Math.max(0, row.length - 1) * gap;
    let xCursor = -rowWidth / 2;

    for (let cIdx = 0; cIdx < row.length; cIdx += 1) {
      const entry = row[cIdx]!;
      const cx = xCursor + entry.radius;
      xCursor += entry.radius * 2 + gap;

      const center: Vec3 = [cx, 0, cz];

      projectContainers.push({
        id: `island:${entry.key}`,
        projectId: entry.projectId,
        label: entry.label,
        center,
        radius: entry.radius,
        vectorCount: entry.vectorCount,
        totalTokens: entry.totalTokens,
        color: entry.color,
      });

      virtualAnchors.push({
        id: `anchor:island:${entry.key}`,
        label: entry.label,
        position: [cx, 10 + Math.min(5, entry.radius * 0.12), cz],
        kind: "project",
        color: entry.color,
      });

      placeNodesOnIsland(entry.nodes, cx, cz, entry.radius, nodePositions);
    }

    zCursor += rowDepth + gap;
  }

  const result: LayoutResult = {
    nodePositions,
    projectContainers,
    virtualAnchors: params.show_virtual_anchors ? virtualAnchors : undefined,
  };
  return result;
};

/**
 * Deterministically spread nodes on a flat disc island on the XZ plane:
 * - Nuclear Laws (`is_core_pin`) form a calm inner core spiral slightly elevated.
 * - Remaining nodes occupy concentric category rings sized by area proportion,
 *   filled via a deterministic golden-angle (Vogel) spiral with thin vertical height.
 */
function placeNodesOnIsland(
  bucket: readonly GraphNode[],
  cx: number,
  cz: number,
  islandRadius: number,
  out: Record<string, Vec3>,
): void {
  if (bucket.length === 0) return;

  const usableR = islandRadius * 0.88;
  const corePins: GraphNode[] = [];
  const byCategory = new Map<MemoryCategory, GraphNode[]>();

  for (const node of bucket) {
    if (node.is_core_pin) {
      corePins.push(node);
    } else {
      let list = byCategory.get(node.category);
      if (!list) {
        list = [];
        byCategory.set(node.category, list);
      }
      list.push(node);
    }
  }

  const cmpId = (a: GraphNode, b: GraphNode) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  corePins.sort(cmpId);

  const nonPinTotal = bucket.length - corePins.length;
  const hasCore = corePins.length > 0;
  const coreOuterR = hasCore
    ? nonPinTotal === 0
      ? usableR * 0.72
      : Math.min(usableR * 0.3, Math.max(3.2, usableR * Math.sqrt(corePins.length / bucket.length) * 1.15))
    : 0;

  // Place Nuclear Laws in the inner core spiral
  for (let i = 0; i < corePins.length; i += 1) {
    const node = corePins[i]!;
    const frac = corePins.length === 1 ? 0 : Math.sqrt((i + 0.5) / corePins.length);
    const r = frac * coreOuterR;
    const theta = i * GOLDEN_ANGLE;
    const y = 1.9 + (i % 3) * 0.38;
    out[node.id] = [cx + Math.cos(theta) * r, y, cz + Math.sin(theta) * r];
  }

  if (nonPinTotal === 0) return;

  // Ordered non-empty category groups for concentric rings
  const activeCategories: Array<{ category: MemoryCategory; nodes: GraphNode[]; catIdx: number }> = [];
  for (let catIdx = 0; catIdx < MEMORY_CATEGORIES.length; catIdx += 1) {
    const cat = MEMORY_CATEGORIES[catIdx]!;
    const list = byCategory.get(cat);
    if (list && list.length > 0) {
      list.sort(cmpId);
      activeCategories.push({ category: cat, nodes: list, catIdx });
    }
  }

  const ringStartR = hasCore ? coreOuterR + 1.8 : 1.4;
  const minArea = ringStartR * ringStartR;
  const maxArea = Math.max(minArea + 4, usableR * usableR);
  const totalArea = maxArea - minArea;

  let areaCursor = minArea;

  for (let groupIdx = 0; groupIdx < activeCategories.length; groupIdx += 1) {
    const group = activeCategories[groupIdx]!;
    const share = group.nodes.length / nonPinTotal;
    const nextArea =
      groupIdx === activeCategories.length - 1 ? maxArea : areaCursor + share * totalArea;

    const rInnerRaw = Math.sqrt(areaCursor);
    const rOuterRaw = Math.sqrt(nextArea);
    const bandWidth = rOuterRaw - rInnerRaw;
    const pad = activeCategories.length > 1 ? Math.min(0.45, bandWidth * 0.14) : 0;
    const rInner = rInnerRaw + pad;
    const rOuter = Math.max(rInner + 0.15, rOuterRaw - pad);
    const rInnerSq = rInner * rInner;
    const rOuterSq = rOuter * rOuter;

    const m = group.nodes.length;
    const phase = group.catIdx * 1.04719755; // 60 deg phase offset per category

    for (let i = 0; i < m; i += 1) {
      const node = group.nodes[i]!;
      const t = (i + 0.5) / m;
      const r = Math.sqrt(rInnerSq + t * (rOuterSq - rInnerSq));
      const theta = phase + i * GOLDEN_ANGLE;
      // Thin vertical height above the flat island slab (0.75 .. 2.35)
      const y = 0.75 + ((i * 5 + group.catIdx * 3) % 8) * 0.22;
      out[node.id] = [cx + Math.cos(theta) * r, y, cz + Math.sin(theta) * r];
    }

    areaCursor = nextArea;
  }
}

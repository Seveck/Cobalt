import type {
  GraphNode,
  LayoutFn,
  LayoutResult,
  Vec3,
  VirtualAnchor,
} from "@/types/contracts";

const GLOBAL_PROJECT_KEY = "__global__";
const MAX_LEAF_STRUCTURAL_EDGES = 1500;

/**
 * Pure deterministic `knowledge_tree` layout (`LayoutFn`).
 * Hierarchical 3D canopy:
 *   Level 0: Root anchor
 *   Level 1: Project hubs (radial ring)
 *   Level 2: Category sub-branches per project
 *   Level 3: Memory leaf nodes fanned around each category branch tip
 */
export const knowledgeTreeLayout: LayoutFn = ({ nodes, projects, params }) => {
  const nodePositions: Record<string, Vec3> = {};
  const virtualAnchors: VirtualAnchor[] = [];
  const structuralEdges: Array<[string, string]> = [];

  const levelSpacing = Math.max(14, params.level_spacing * 1.45);
  const spread = Math.max(24, params.radial_spread * 1.25);

  const rootId = "anchor:tree:root";
  const rootPos: Vec3 = [0, -levelSpacing * 1.4, 0];
  virtualAnchors.push({
    id: rootId,
    label: "Cobalt Root",
    position: rootPos,
    kind: "root",
    color: "#79A8FF",
  });

  const projectInfoMap = new Map(
    projects.map((p) => [
      p.project.id,
      { label: p.project.name, color: p.project.color_hex },
    ]),
  );

  // Group nodes: projectKey -> category -> GraphNode[]
  const byProject = new Map<string, Map<string, GraphNode[]>>();
  for (const node of nodes) {
    const pKey = node.project_id ?? GLOBAL_PROJECT_KEY;
    let catMap = byProject.get(pKey);
    if (!catMap) {
      catMap = new Map<string, GraphNode[]>();
      byProject.set(pKey, catMap);
    }
    let list = catMap.get(node.category);
    if (!list) {
      list = [];
      catMap.set(node.category, list);
    }
    list.push(node);
  }

  const projectKeys = [...byProject.keys()].sort();
  const projectCount = Math.max(1, projectKeys.length);
  const projectRingRadius = projectCount === 1 ? 0 : spread * 0.95;
  const includeLeafEdges = nodes.length <= MAX_LEAF_STRUCTURAL_EDGES;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let pIdx = 0; pIdx < projectKeys.length; pIdx += 1) {
    const pKey = projectKeys[pIdx]!;
    const catMap = byProject.get(pKey)!;
    const pAngle = (pIdx / projectCount) * Math.PI * 2;
    const px = Math.cos(pAngle) * projectRingRadius;
    const py = -levelSpacing * 0.2;
    const pz = Math.sin(pAngle) * projectRingRadius;

    const info =
      pKey === GLOBAL_PROJECT_KEY
        ? { label: "General", color: "#94A3B8" }
        : (projectInfoMap.get(pKey) ?? { label: pKey.slice(0, 8), color: "#3B82F6" });

    const projAnchorId = `anchor:tree:proj:${pKey}`;
    virtualAnchors.push({
      id: projAnchorId,
      label: info.label,
      position: [px, py, pz],
      kind: "project",
      color: info.color,
    });
    structuralEdges.push([rootId, projAnchorId]);

    const categories = [...catMap.keys()].sort();
    const catCount = Math.max(1, categories.length);
    const catOrbit = Math.max(14, spread * 0.45);

    for (let cIdx = 0; cIdx < categories.length; cIdx += 1) {
      const cat = categories[cIdx]!;
      const leafNodes = catMap.get(cat)!;
      leafNodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      const cAngle = pAngle + ((cIdx - (catCount - 1) / 2) / Math.max(1, catCount)) * Math.PI * 1.45;
      const cx = px + Math.cos(cAngle) * catOrbit;
      const cy = py + levelSpacing * 1.05;
      const cz = pz + Math.sin(cAngle) * catOrbit;

      const catAnchorId = `anchor:tree:cat:${pKey}:${cat}`;
      virtualAnchors.push({
        id: catAnchorId,
        label: cat,
        position: [cx, cy, cz],
        kind: "category",
        color: info.color,
      });
      structuralEdges.push([projAnchorId, catAnchorId]);

      const leafCount = Math.max(1, leafNodes.length);
      const canopyRadius = Math.min(24, 5 + Math.sqrt(leafCount) * 2.4);

      for (let i = 0; i < leafNodes.length; i += 1) {
        const node = leafNodes[i];
        if (!node) continue;

        const t = (i + 0.5) / leafCount;
        const r = Math.sqrt(t) * canopyRadius;
        const theta = i * goldenAngle;
        const crownLift = levelSpacing * (0.45 + (node.is_core_pin ? 0.55 : (1 - t) * 0.42));

        nodePositions[node.id] = [
          cx + Math.cos(theta) * r,
          cy + crownLift,
          cz + Math.sin(theta) * r,
        ];

        if (includeLeafEdges) {
          structuralEdges.push([catAnchorId, node.id]);
        }
      }
    }
  }

  const result: LayoutResult = {
    nodePositions,
    virtualAnchors: params.show_virtual_anchors ? virtualAnchors : undefined,
    structuralEdges: params.show_virtual_anchors ? structuralEdges : undefined,
  };
  return result;
};

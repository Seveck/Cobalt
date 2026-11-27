import type { LayoutFn, LayoutType } from "@/types/contracts";
import { brainLayout } from "./brain";
import {
  createCustomMeshLayout,
  customMeshFallbackLayout,
  type CustomMeshData,
} from "./customMesh";
import { galaxyLayout } from "./galaxy";
import { knowledgeTreeLayout } from "./knowledgeTree";
import { neuralNetLayout } from "./neuralNet";
import { projectClustersLayout } from "./projectClusters";
import { projectIslandsLayout } from "./projectIslands";

export const BUILTIN_LAYOUT_TYPES = [
  "galaxy",
  "brain",
  "neural_net",
  "knowledge_tree",
  "project_clusters",
  "project_islands",
] as const;

export type BuiltinLayoutType = (typeof BUILTIN_LAYOUT_TYPES)[number];

/** Registry mapping every `LayoutType` to a pure deterministic `LayoutFn`. */
export const LAYOUT_REGISTRY: Record<LayoutType, LayoutFn> = {
  galaxy: galaxyLayout,
  brain: brainLayout,
  neural_net: neuralNetLayout,
  knowledge_tree: knowledgeTreeLayout,
  project_clusters: projectClustersLayout,
  project_islands: projectIslandsLayout,
  custom_mesh: customMeshFallbackLayout,
};

export function resolveLayoutFn(
  layoutType: LayoutType,
  customMeshData: CustomMeshData | null = null,
): LayoutFn {
  if (layoutType === "custom_mesh") {
    return createCustomMeshLayout(customMeshData);
  }
  return LAYOUT_REGISTRY[layoutType] ?? galaxyLayout;
}

export {
  galaxyLayout,
  brainLayout,
  neuralNetLayout,
  knowledgeTreeLayout,
  projectClustersLayout,
  projectIslandsLayout,
  createCustomMeshLayout,
  type CustomMeshData,
};

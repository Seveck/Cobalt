import type * as THREE from "three";
import type {
  GraphNode,
  LayoutFn,
  LayoutResult,
  Vec3,
  VirtualAnchor,
} from "@/types/contracts";
import { galaxyLayout } from "./galaxy";

export const CUSTOM_MESH_MAX_VERTICES = 200_000;
export const CUSTOM_MESH_BOUNDING_RADIUS = 50; // 100-unit diameter bounding sphere

export interface CustomMeshData {
  /** Normalized world-space vertices (flat xyz, length = vertexCount * 3). */
  vertices: Float32Array;
  /** Unit vertex normals matching `vertices` (flat xyz, length = vertexCount * 3). */
  normals: Float32Array;
  vertexCount: number;
  centroid: Vec3;
  /** Precomputed vertex indices sorted closest-first to `centroid` for Nuclear Laws. */
  closestCentroidIndices: Uint32Array;
  /** Normalized merged geometry for the faint backdrop mesh (caller disposes). */
  backdropGeometry: THREE.BufferGeometry;
}

/** Standard deterministic 32-bit FNV-1a hash (unsigned). */
export function fnv1a32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Pure deterministic `custom_mesh` layout (`LayoutFn`) per THEME_SPEC §6.2:
 * - Each memory is placed at vertex `FNV-1a(id) mod vertexCount`, offset along
 *   the vertex normal by `layout_params.level_spacing * 0.05`.
 * - Nuclear Laws (`is_core_pin`) occupy the vertices closest to the mesh centroid.
 */
export function createCustomMeshLayout(meshData: CustomMeshData | null): LayoutFn {
  if (!meshData || meshData.vertexCount <= 0) {
    return galaxyLayout;
  }

  return ({ nodes, params }) => {
    const nodePositions: Record<string, Vec3> = {};
    const { vertices, normals, vertexCount, closestCentroidIndices, centroid } = meshData;
    const normalOffset = params.level_spacing * 0.05;

    const corePins: GraphNode[] = [];
    const regularNodes: GraphNode[] = [];

    for (const node of nodes) {
      if (node.is_core_pin) {
        corePins.push(node);
      } else {
        regularNodes.push(node);
      }
    }

    // Deterministic ordering for Nuclear Laws nearest the centroid
    corePins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const closestLen = Math.max(1, closestCentroidIndices.length);
    for (let i = 0; i < corePins.length; i += 1) {
      const node = corePins[i];
      if (!node) continue;
      const vIdx = closestCentroidIndices[i % closestLen] ?? 0;
      const i3 = vIdx * 3;
      const vx = vertices[i3] ?? 0;
      const vy = vertices[i3 + 1] ?? 0;
      const vz = vertices[i3 + 2] ?? 0;
      const nx = normals[i3] ?? 0;
      const ny = normals[i3 + 1] ?? 1;
      const nz = normals[i3 + 2] ?? 0;
      nodePositions[node.id] = [
        vx + nx * normalOffset,
        vy + ny * normalOffset,
        vz + nz * normalOffset,
      ];
    }

    for (let i = 0; i < regularNodes.length; i += 1) {
      const node = regularNodes[i];
      if (!node) continue;
      const vIdx = fnv1a32(node.id) % vertexCount;
      const i3 = vIdx * 3;
      const vx = vertices[i3] ?? 0;
      const vy = vertices[i3 + 1] ?? 0;
      const vz = vertices[i3 + 2] ?? 0;
      const nx = normals[i3] ?? 0;
      const ny = normals[i3 + 1] ?? 1;
      const nz = normals[i3 + 2] ?? 0;
      nodePositions[node.id] = [
        vx + nx * normalOffset,
        vy + ny * normalOffset,
        vz + nz * normalOffset,
      ];
    }

    const virtualAnchors: VirtualAnchor[] | undefined = params.show_virtual_anchors
      ? [
          {
            id: "anchor:custom_mesh:centroid",
            label: "Mesh Core",
            position: centroid,
            kind: "root",
          },
        ]
      : undefined;

    const result: LayoutResult = { nodePositions, virtualAnchors };
    return result;
  };
}

/** Fallback `LayoutFn` used when `custom_mesh` is selected without a loaded GLB. */
export const customMeshFallbackLayout: LayoutFn = galaxyLayout;

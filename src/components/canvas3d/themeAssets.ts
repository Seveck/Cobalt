import { convertFileSrc } from "@tauri-apps/api/core";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { isTauri } from "@/lib/ipc";
import type {
  HardwareTier,
  ShaderSpec,
  ThemeCompatibility,
  ThemeManifest,
  Vec3,
} from "@/types/contracts";
import {
  CUSTOM_MESH_BOUNDING_RADIUS,
  CUSTOM_MESH_MAX_VERTICES,
  type CustomMeshData,
} from "./layouts/customMesh";

const MAX_SHADER_BYTES = 256 * 1024;
const MAX_GLB_BYTES = 25 * 1024 * 1024;
const NODE_MESH_MAX_TRIANGLES = 2_000;
const GLB_MAGIC_UINT32 = 0x46546c67; // "glTF" little-endian

export interface LoadedThemeShaders {
  nodeVertex: string | null;
  nodeFragment: string | null;
  edgeVertex: string | null;
  edgeFragment: string | null;
  backgroundFragment: string | null;
}

export interface ThemeAssetLoadError {
  layer: "node" | "edge" | "background" | "mesh";
  path: string;
  message: string;
}

export interface ParsedThemeGlb {
  customMeshData: CustomMeshData | null;
  customMeshError: string | null;
  nodeMeshGeometry: THREE.BufferGeometry | null;
  nodeMeshError: string | null;
}

/**
 * Compute compatibility matrix per THEME_SPEC §5.
 */
export function computeThemeCompatibility(
  themeTier: HardwareTier,
  userTier: HardwareTier,
): ThemeCompatibility {
  if (userTier === "ultra") return "compatible";
  if (userTier === "balanced") {
    return themeTier === "ultra" ? "degraded" : "compatible";
  }
  // userTier === "eco"
  if (themeTier === "eco") return "compatible";
  if (themeTier === "balanced") return "degraded";
  return "incompatible";
}

/**
 * Whether custom GLSL theme shaders may run per THEME_SPEC §6.2:
 * disabled in Eco, for degraded/incompatible themes, when user toggled
 * "Disable theme shaders", or when the frame-time watchdog tripped for the session.
 */
export function areCustomShadersAllowed(params: {
  manifest: ThemeManifest;
  hardwareTier: HardwareTier;
  disableThemeShaders: boolean;
  shadersDisabledForSession: boolean;
}): boolean {
  if (params.hardwareTier === "eco") return false;
  if (params.disableThemeShaders) return false;
  if (params.shadersDisabledForSession) return false;
  const compat = computeThemeCompatibility(params.manifest.hardware_tier, params.hardwareTier);
  return compat === "compatible";
}

export function hasAnyCustomShader(shaders: ShaderSpec): boolean {
  return Boolean(
    shaders.node_vertex ||
      shaders.node_fragment ||
      shaders.edge_vertex ||
      shaders.edge_fragment ||
      shaders.background_fragment,
  );
}

/**
 * Defensively validate a theme-relative asset path (mirrors Rust sandbox rules).
 */
export function isSafeThemeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.length > 256) return false;
  if (relativePath.includes("\0") || relativePath.includes("\\")) return false;
  if (relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) return false;
  const parts = relativePath.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  return relativePath.startsWith("shaders/") || relativePath.startsWith("meshes/");
}

function joinThemePath(baseDir: string, relativePath: string): string {
  const cleanBase = baseDir.replace(/[\\/]+$/, "");
  const sep = cleanBase.includes("\\") && !cleanBase.includes("/") ? "\\" : "/";
  const normalizedRel = sep === "\\" ? relativePath.replace(/\//g, "\\") : relativePath;
  return `${cleanBase}${sep}${normalizedRel}`;
}

/**
 * Convert an installed theme's relative file path into a fetchable URL
 * via Tauri's scoped asset protocol (`$HOME/.cobalt/themes/**`).
 */
export function resolveThemeAssetUrl(
  themeBasePath: string | null,
  relativePath: string | null,
): string | null {
  if (!themeBasePath || !relativePath) return null;
  if (!isSafeThemeRelativePath(relativePath)) return null;
  if (themeBasePath.startsWith("builtin://")) return null;

  if (isTauri()) {
    if (themeBasePath.startsWith("~")) return null;
    const fullPath = joinThemePath(themeBasePath, relativePath);
    return convertFileSrc(fullPath);
  }

  // Non-Tauri browser preview: allow direct http(s) or root-relative dev paths
  if (/^https?:\/\//i.test(themeBasePath) || themeBasePath.startsWith("/")) {
    const cleanBase = themeBasePath.replace(/\/+$/, "");
    return `${cleanBase}/${relativePath}`;
  }

  return null;
}

async function fetchShaderText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > MAX_SHADER_BYTES) {
    throw new Error(`Shader exceeds 256 KiB limit (${text.length} bytes).`);
  }
  return text;
}

/**
 * Load all declared custom GLSL shader sources for a theme in parallel.
 * Individual layer failures are returned as non-blocking errors without failing other layers.
 */
export async function loadThemeShaderSources(
  themeBasePath: string | null,
  shaders: ShaderSpec,
  signal: AbortSignal,
): Promise<{ sources: LoadedThemeShaders; errors: ThemeAssetLoadError[] }> {
  const sources: LoadedThemeShaders = {
    nodeVertex: null,
    nodeFragment: null,
    edgeVertex: null,
    edgeFragment: null,
    backgroundFragment: null,
  };
  const errors: ThemeAssetLoadError[] = [];

  const entries: Array<{
    key: keyof LoadedThemeShaders;
    layer: "node" | "edge" | "background";
    relPath: string | null;
  }> = [
    { key: "nodeVertex", layer: "node", relPath: shaders.node_vertex },
    { key: "nodeFragment", layer: "node", relPath: shaders.node_fragment },
    { key: "edgeVertex", layer: "edge", relPath: shaders.edge_vertex },
    { key: "edgeFragment", layer: "edge", relPath: shaders.edge_fragment },
    { key: "backgroundFragment", layer: "background", relPath: shaders.background_fragment },
  ];

  await Promise.all(
    entries.map(async ({ key, layer, relPath }) => {
      if (!relPath) return;
      const url = resolveThemeAssetUrl(themeBasePath, relPath);
      if (!url) {
        errors.push({
          layer,
          path: relPath,
          message: `Cannot resolve theme asset path "${relPath}".`,
        });
        return;
      }
      try {
        sources[key] = await fetchShaderText(url, signal);
      } catch (err: unknown) {
        if (signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ layer, path: relPath, message: `${relPath}: ${msg}` });
      }
    }),
  );

  return { sources, errors };
}

function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat) continue;
        for (const value of Object.values(mat)) {
          if (value instanceof THREE.Texture) {
            value.dispose();
          }
        }
        mat.dispose();
      }
    }
  });
}

function countGeometryTriangles(geometry: THREE.BufferGeometry): number {
  if (geometry.index) {
    return Math.floor(geometry.index.count / 3);
  }
  const pos = geometry.getAttribute("position");
  return pos ? Math.floor(pos.count / 3) : 0;
}

/**
 * Extract the first mesh from a parsed GLTF scene for `node_geometry.shape === "mesh"`,
 * enforcing ≤ 2,000 triangles and normalizing it to unit bounding radius at the origin.
 */
function extractFirstNodeMesh(scene: THREE.Object3D): {
  geometry: THREE.BufferGeometry | null;
  error: string | null;
} {
  let firstMesh: THREE.Mesh | null = null;
  scene.traverse((obj) => {
    if (!firstMesh && obj instanceof THREE.Mesh && obj.geometry) {
      firstMesh = obj;
    }
  });

  if (!firstMesh) {
    return { geometry: null, error: "GLB contains no mesh for node geometry." };
  }

  const mesh = firstMesh as THREE.Mesh;
  const tris = countGeometryTriangles(mesh.geometry);
  if (tris <= 0) {
    return { geometry: null, error: "First mesh in GLB has zero triangles." };
  }
  if (tris > NODE_MESH_MAX_TRIANGLES) {
    return {
      geometry: null,
      error: `Node mesh has ${tris.toLocaleString()} triangles (limit: ${NODE_MESH_MAX_TRIANGLES.toLocaleString()}).`,
    };
  }

  const cloned = mesh.geometry.clone();
  // Remove vertex colors if present so unlit InstancedMesh uses instanceColor cleanly
  if (cloned.getAttribute("color")) {
    cloned.deleteAttribute("color");
  }
  cloned.computeBoundingBox();
  const box = cloned.boundingBox;
  if (box) {
    const center = new THREE.Vector3();
    box.getCenter(center);
    cloned.translate(-center.x, -center.y, -center.z);
  }
  cloned.computeBoundingSphere();
  const radius = cloned.boundingSphere?.radius ?? 1;
  if (radius > 1e-6) {
    const inv = 1 / radius;
    cloned.scale(inv, inv, inv);
  }
  cloned.computeBoundingSphere();
  return { geometry: cloned, error: null };
}

/**
 * Select the `limit` vertex indices closest to `centroid` without sorting all 200k vertices
 * when the mesh is large.
 */
function computeClosestCentroidIndices(
  vertices: Float32Array,
  vertexCount: number,
  centroid: Vec3,
  maxCount = 2048,
): Uint32Array {
  const k = Math.min(vertexCount, maxCount);
  const cx = centroid[0];
  const cy = centroid[1];
  const cz = centroid[2];

  if (vertexCount <= 24_000) {
    const dists = new Float32Array(vertexCount);
    const indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i += 1) {
      const i3 = i * 3;
      const dx = (vertices[i3] ?? 0) - cx;
      const dy = (vertices[i3 + 1] ?? 0) - cy;
      const dz = (vertices[i3 + 2] ?? 0) - cz;
      dists[i] = dx * dx + dy * dy + dz * dz;
      indices[i] = i;
    }
    indices.sort((a, b) => (dists[a] ?? 0) - (dists[b] ?? 0) || a - b);
    return indices.slice(0, k);
  }

  // Max-heap of size k for O(N log k) on large meshes (up to 200k vertices)
  const heapIdx = new Uint32Array(k);
  const heapDist = new Float32Array(k);
  let heapSize = 0;

  const swap = (a: number, b: number) => {
    const ti = heapIdx[a]!;
    heapIdx[a] = heapIdx[b]!;
    heapIdx[b] = ti;
    const td = heapDist[a]!;
    heapDist[a] = heapDist[b]!;
    heapDist[b] = td;
  };

  const siftUp = (pos: number) => {
    let i = pos;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((heapDist[parent] ?? 0) >= (heapDist[i] ?? 0)) break;
      swap(parent, i);
      i = parent;
    }
  };

  const siftDown = (pos: number) => {
    let i = pos;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let largest = i;
      if (left < heapSize && (heapDist[left] ?? 0) > (heapDist[largest] ?? 0)) {
        largest = left;
      }
      if (right < heapSize && (heapDist[right] ?? 0) > (heapDist[largest] ?? 0)) {
        largest = right;
      }
      if (largest === i) break;
      swap(i, largest);
      i = largest;
    }
  };

  for (let i = 0; i < vertexCount; i += 1) {
    const i3 = i * 3;
    const dx = (vertices[i3] ?? 0) - cx;
    const dy = (vertices[i3 + 1] ?? 0) - cy;
    const dz = (vertices[i3 + 2] ?? 0) - cz;
    const d2 = dx * dx + dy * dy + dz * dz;

    if (heapSize < k) {
      heapIdx[heapSize] = i;
      heapDist[heapSize] = d2;
      siftUp(heapSize);
      heapSize += 1;
    } else if (d2 < (heapDist[0] ?? Infinity)) {
      heapIdx[0] = i;
      heapDist[0] = d2;
      siftDown(0);
    }
  }

  // Sort the k closest indices ascending by distance (tie-break by vertex index)
  const order = Array.from({ length: heapSize }, (_, idx) => ({
    vIdx: heapIdx[idx] ?? 0,
    d2: heapDist[idx] ?? 0,
  }));
  order.sort((a, b) => a.d2 - b.d2 || a.vIdx - b.vIdx);
  const result = new Uint32Array(order.length);
  for (let i = 0; i < order.length; i += 1) {
    result[i] = order[i]?.vIdx ?? 0;
  }
  return result;
}

/**
 * Extract merged, world-transformed, 100-unit-sphere-normalized layout + backdrop data
 * from the first scene of a GLB per THEME_SPEC §6.2.
 */
function extractCustomMeshLayoutData(scene: THREE.Object3D): {
  data: CustomMeshData | null;
  error: string | null;
} {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry) {
      const posAttr = obj.geometry.getAttribute("position");
      if (posAttr && posAttr.count > 0) {
        meshes.push(obj);
      }
    }
  });

  if (meshes.length === 0) {
    return { data: null, error: "GLB scene contains no renderable mesh geometry." };
  }

  let totalVertices = 0;
  let totalIndexEntries = 0;
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute("position");
    if (!pos) continue;
    totalVertices += pos.count;
    totalIndexEntries += mesh.geometry.index ? mesh.geometry.index.count : pos.count;
  }

  if (totalVertices <= 0) {
    return { data: null, error: "GLB mesh contains zero vertices." };
  }
  if (totalVertices > CUSTOM_MESH_MAX_VERTICES) {
    return {
      data: null,
      error: `GLB has ${totalVertices.toLocaleString()} vertices (limit: ${CUSTOM_MESH_MAX_VERTICES.toLocaleString()}).`,
    };
  }

  const vertices = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const backdropIndices = new Uint32Array(totalIndexEntries);

  const tmpPos = new THREE.Vector3();
  const tmpNorm = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  let vOffset = 0;
  let idxOffset = 0;

  for (const mesh of meshes) {
    const srcGeo = mesh.geometry;
    const posAttr = srcGeo.getAttribute("position");
    if (!posAttr) continue;

    let normAttr = srcGeo.getAttribute("normal");
    let tempGeo: THREE.BufferGeometry | null = null;
    if (!normAttr) {
      tempGeo = srcGeo.clone();
      tempGeo.computeVertexNormals();
      normAttr = tempGeo.getAttribute("normal");
    }

    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    const count = posAttr.count;

    for (let i = 0; i < count; i += 1) {
      tmpPos.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      const out3 = (vOffset + i) * 3;
      vertices[out3] = tmpPos.x;
      vertices[out3 + 1] = tmpPos.y;
      vertices[out3 + 2] = tmpPos.z;

      if (tmpPos.x < minX) minX = tmpPos.x;
      if (tmpPos.y < minY) minY = tmpPos.y;
      if (tmpPos.z < minZ) minZ = tmpPos.z;
      if (tmpPos.x > maxX) maxX = tmpPos.x;
      if (tmpPos.y > maxY) maxY = tmpPos.y;
      if (tmpPos.z > maxZ) maxZ = tmpPos.z;

      if (normAttr) {
        tmpNorm.fromBufferAttribute(normAttr, i).applyMatrix3(normalMatrix).normalize();
      } else {
        tmpNorm.set(0, 1, 0);
      }
      if (!Number.isFinite(tmpNorm.x) || tmpNorm.lengthSq() < 1e-6) {
        tmpNorm.set(0, 1, 0);
      }
      normals[out3] = tmpNorm.x;
      normals[out3 + 1] = tmpNorm.y;
      normals[out3 + 2] = tmpNorm.z;
    }

    if (srcGeo.index) {
      const idxAttr = srcGeo.index;
      for (let i = 0; i < idxAttr.count; i += 1) {
        backdropIndices[idxOffset + i] = idxAttr.getX(i) + vOffset;
      }
      idxOffset += idxAttr.count;
    } else {
      for (let i = 0; i < count; i += 1) {
        backdropIndices[idxOffset + i] = vOffset + i;
      }
      idxOffset += count;
    }

    vOffset += count;
    tempGeo?.dispose();
  }

  // Normalize to a 100-unit bounding sphere (radius = 50) centered at origin
  const boxCenterX = (minX + maxX) * 0.5;
  const boxCenterY = (minY + maxY) * 0.5;
  const boxCenterZ = (minZ + maxZ) * 0.5;

  let maxDistSq = 0;
  for (let i = 0; i < totalVertices; i += 1) {
    const i3 = i * 3;
    const dx = (vertices[i3] ?? 0) - boxCenterX;
    const dy = (vertices[i3 + 1] ?? 0) - boxCenterY;
    const dz = (vertices[i3 + 2] ?? 0) - boxCenterZ;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > maxDistSq) maxDistSq = d2;
  }

  const maxDist = Math.sqrt(maxDistSq);
  const scale = maxDist > 1e-6 ? CUSTOM_MESH_BOUNDING_RADIUS / maxDist : 1;

  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (let i = 0; i < totalVertices; i += 1) {
    const i3 = i * 3;
    const nx = ((vertices[i3] ?? 0) - boxCenterX) * scale;
    const ny = ((vertices[i3 + 1] ?? 0) - boxCenterY) * scale;
    const nz = ((vertices[i3 + 2] ?? 0) - boxCenterZ) * scale;
    vertices[i3] = nx;
    vertices[i3 + 1] = ny;
    vertices[i3 + 2] = nz;
    sumX += nx;
    sumY += ny;
    sumZ += nz;
  }

  const centroid: Vec3 = [
    sumX / totalVertices,
    sumY / totalVertices,
    sumZ / totalVertices,
  ];

  const closestCentroidIndices = computeClosestCentroidIndices(
    vertices,
    totalVertices,
    centroid,
  );

  const backdropGeometry = new THREE.BufferGeometry();
  backdropGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(vertices), 3),
  );
  backdropGeometry.setIndex(new THREE.BufferAttribute(backdropIndices, 1));
  backdropGeometry.computeBoundingSphere();

  return {
    data: {
      vertices,
      normals,
      vertexCount: totalVertices,
      centroid,
      closestCentroidIndices,
      backdropGeometry,
    },
    error: null,
  };
}

/**
 * Load and parse a theme's GLB file (`mesh_path`) via Tauri asset protocol,
 * extracting both `custom_mesh` layout data (if needed) and `node_geometry.shape === "mesh"`
 * instance geometry (if needed), while disposing all intermediate GLTF resources.
 */
export async function loadThemeGlb(
  themeBasePath: string | null,
  meshPath: string | null,
  options: { needLayout: boolean; needNodeMesh: boolean },
  signal: AbortSignal,
): Promise<ParsedThemeGlb> {
  const url = resolveThemeAssetUrl(themeBasePath, meshPath);
  if (!url) {
    const err = meshPath
      ? `Cannot resolve GLB asset path "${meshPath}".`
      : "Theme manifest does not specify mesh_path.";
    return {
      customMeshData: null,
      customMeshError: options.needLayout ? err : null,
      nodeMeshGeometry: null,
      nodeMeshError: options.needNodeMesh ? err : null,
    };
  }

  let buffer: ArrayBuffer;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    buffer = await res.arrayBuffer();
  } catch (err: unknown) {
    if (signal.aborted) {
      return {
        customMeshData: null,
        customMeshError: null,
        nodeMeshGeometry: null,
        nodeMeshError: null,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      customMeshData: null,
      customMeshError: options.needLayout ? msg : null,
      nodeMeshGeometry: null,
      nodeMeshError: options.needNodeMesh ? msg : null,
    };
  }

  if (buffer.byteLength > MAX_GLB_BYTES) {
    const msg = `GLB exceeds 25 MiB limit (${buffer.byteLength} bytes).`;
    return {
      customMeshData: null,
      customMeshError: options.needLayout ? msg : null,
      nodeMeshGeometry: null,
      nodeMeshError: options.needNodeMesh ? msg : null,
    };
  }

  if (buffer.byteLength < 12) {
    const msg = "GLB file is truncated.";
    return {
      customMeshData: null,
      customMeshError: options.needLayout ? msg : null,
      nodeMeshGeometry: null,
      nodeMeshError: options.needNodeMesh ? msg : null,
    };
  }

  const header = new DataView(buffer, 0, 12);
  if (header.getUint32(0, true) !== GLB_MAGIC_UINT32) {
    const msg = "Invalid GLB header (expected binary glTF v2).";
    return {
      customMeshData: null,
      customMeshError: options.needLayout ? msg : null,
      nodeMeshGeometry: null,
      nodeMeshError: options.needNodeMesh ? msg : null,
    };
  }

  const loader = new GLTFLoader();
  let gltf: GLTF;
  try {
    gltf = await new Promise<GLTF>((resolve, reject) => {
      loader.parse(buffer, "", resolve, (err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      customMeshData: null,
      customMeshError: options.needLayout ? msg : null,
      nodeMeshGeometry: null,
      nodeMeshError: options.needNodeMesh ? msg : null,
    };
  }

  const firstScene = gltf.scene ?? gltf.scenes[0];
  try {
    if (!firstScene) {
      const msg = "GLB contains no scene.";
      return {
        customMeshData: null,
        customMeshError: options.needLayout ? msg : null,
        nodeMeshGeometry: null,
        nodeMeshError: options.needNodeMesh ? msg : null,
      };
    }

    firstScene.updateMatrixWorld(true);

    const layoutExtracted = options.needLayout
      ? extractCustomMeshLayoutData(firstScene)
      : { data: null, error: null };

    const nodeExtracted = options.needNodeMesh
      ? extractFirstNodeMesh(firstScene)
      : { geometry: null, error: null };

    if (signal.aborted) {
      layoutExtracted.data?.backdropGeometry.dispose();
      nodeExtracted.geometry?.dispose();
      return {
        customMeshData: null,
        customMeshError: null,
        nodeMeshGeometry: null,
        nodeMeshError: null,
      };
    }

    return {
      customMeshData: layoutExtracted.data,
      customMeshError: layoutExtracted.error,
      nodeMeshGeometry: nodeExtracted.geometry,
      nodeMeshError: nodeExtracted.error,
    };
  } finally {
    if (firstScene) {
      disposeObjectTree(firstScene);
    }
    for (const s of gltf.scenes) {
      if (s && s !== firstScene) {
        disposeObjectTree(s);
      }
    }
  }
}

export function disposeParsedThemeGlb(parsed: ParsedThemeGlb | null): void {
  if (!parsed) return;
  parsed.customMeshData?.backdropGeometry.dispose();
  parsed.nodeMeshGeometry?.dispose();
}

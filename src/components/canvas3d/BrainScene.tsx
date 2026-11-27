import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { isTauri } from "@/lib/ipc";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import {
  matchesVisualFilters,
  useMemoryStore,
  useSynapticStore,
  useThemeStore,
} from "@/stores";
import type {
  ClusterSizeMetric,
  GraphData,
  GraphNode,
  HardwareTier,
  LayoutType,
  ProjectContainer,
  ThemeManifest,
  Uuid,
  Vec3,
  VisualFilters,
} from "@/types/contracts";
import { createNodeGeometry } from "./geometry";
import {
  buildIslandRimsGeometry,
  buildIslandSlabsGeometry,
  computeIslandsCameraFraming,
  createIslandLabelSprite,
} from "./islandVisuals";
import { resolveLayoutFn } from "./layouts";
import {
  createNodePointMaterial,
  NODE_POINT_FRAGMENT_SHADER,
  NODE_POINT_VERTEX_SHADER,
} from "./pointShader";
import {
  prepareSandTransition,
  REDUCED_MOTION_FADE_SEC,
  smoothstep,
  stepSandTransition,
} from "./sandTransition";
import { SpatialHashGrid } from "./spatialIndex";
import {
  areCustomShadersAllowed,
  disposeParsedThemeGlb,
  hasAnyCustomShader,
  loadThemeGlb,
  loadThemeShaderSources,
  type LoadedThemeShaders,
  type ParsedThemeGlb,
} from "./themeAssets";
import {
  BACKGROUND_VERTEX_SHADER,
  createBackgroundShaderMaterial,
  createEdgeShaderMaterial,
  declaresColorAttribute,
  EDGE_FRAGMENT_SHADER,
  EDGE_VERTEX_SHADER,
  validateShaderProgram,
} from "./themeShaders";

const CAMERA_FOCUS_DURATION_SEC = 0.65;
const CAMERA_TRANSITION_DURATION_SEC = 0.8;
const FRUSTUM_CHECK_INTERVAL_MS = 160;
const PULSE_DIM_OPACITY = 0.3;
const PULSE_VISIBILITY_REPORT_MS = 100;
const INITIAL_CAPACITY = 1024;
const VOLUMETRIC_MAX_VISIBLE_NODES = 5_000;
const VOLUMETRIC_SCALE_MULTIPLIER = 0.45;
const WATCHDOG_FRAME_MS_THRESHOLD = 100;
const WATCHDOG_SUSTAINED_MS = 3_000;
const WATCHDOG_WINDOW_MS = 1_000;
const STRUCTURAL_EDGE_BASE_OPACITY = 0.36;
const CUSTOM_MESH_BACKDROP_BASE_OPACITY = 0.15;
const ISLAND_SLABS_BASE_OPACITY = 0.78;
const ISLAND_RIMS_BASE_OPACITY = 0.86;

export type ViewportEdge = "top" | "bottom" | "left" | "right";

export interface PulseVisibilitySummary {
  totalActive: number;
  onScreenCount: number;
  offScreenCount: number;
  filteredOutCount: number;
  missingFromGraphCount: number;
  edge: ViewportEdge | null;
  /** Fraction [0.18 .. 0.82] along the active viewport edge. */
  edgeOffset: number;
  colorHex: string;
  offScreenIds: Uuid[];
  filteredOutIds: Uuid[];
}

interface FrameRateControllerProps {
  maxFps: number | null;
}

/**
 * Drives the R3F render loop at a capped frame rate (30 FPS in Eco, 60 FPS in Balanced)
 * when `<Canvas frameloop="never" />` is active, pausing automatically while the tab is hidden.
 */
function FrameRateController({ maxFps }: FrameRateControllerProps) {
  const advance = useThree((state) => state.advance);

  useEffect(() => {
    if (maxFps === null) return;

    const minFrameMs = 1000 / maxFps;
    let rafId = 0;
    let lastRender = 0;

    const tick = (now: number) => {
      rafId = window.requestAnimationFrame(tick);
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      if (now - lastRender >= minFrameMs) {
        lastRender = now;
        advance(now);
      }
    };

    advance(performance.now());
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [advance, maxFps]);

  return null;
}

/**
 * Synchronizes WebGL viewport & camera aspect synchronously on container resize
 * (e.g. during smooth sidebar width transitions) so frames never stretch or flash blank.
 */
function CanvasResizeSync({ manualFrameloop }: { manualFrameloop: boolean }) {
  const gl = useThree((state) => state.gl);
  const get = useThree((state) => state.get);

  useEffect(() => {
    const parent = gl.domElement.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;

    const sync = () => {
      const rect = parent.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width <= 0 || height <= 0) return;

      const state = get();
      if (
        Math.abs(state.size.width - width) < 0.5 &&
        Math.abs(state.size.height - height) < 0.5
      ) {
        return;
      }

      state.setSize(width, height, rect.top, rect.left);
      if (manualFrameloop) {
        state.advance(performance.now());
      } else {
        state.gl.render(state.scene, state.camera);
      }
    };

    const observer = new ResizeObserver(sync);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [get, gl, manualFrameloop]);

  return null;
}

export interface BrainSceneProps {
  graph: GraphData;
  manifest: ThemeManifest;
  themeBasePath: string | null;
  activeLayout: LayoutType;
  clusterSizeMetric: ClusterSizeMetric;
  showConnections: boolean;
  hardwareTier: HardwareTier;
  filters: VisualFilters;
  searchQuery: string;
  hoveredNodeId: Uuid | null;
  selectedNodeId: Uuid | null;
  highlightedNodeIds: ReadonlySet<Uuid>;
  resetSignal: number;
  centerViewSignal: number;
  onHoverNode: (node: GraphNode | null) => void;
  onSelectNode: (node: GraphNode | null) => void;
  onContainersChange?: (containers: readonly ProjectContainer[]) => void;
  onPulseVisibilityChange?: (summary: PulseVisibilitySummary | null) => void;
  onNodesInViewChange?: (anyInView: boolean) => void;
}

function resolveNodeColorHex(
  node: GraphNode,
  manifest: ThemeManifest,
  activeLayout: LayoutType,
  projectColors: ReadonlyMap<string, string>,
): string {
  if (node.is_core_pin) return manifest.palette.core_pin;
  if (activeLayout === "project_clusters" && node.project_id) {
    const projHex = projectColors.get(node.project_id);
    if (projHex) return projHex;
  }
  if (node.is_reusable) return manifest.palette.reusable;
  return manifest.palette.category_colors[node.category] ?? manifest.palette.node;
}

interface PointBuffers {
  capacity: number;
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  prevPositions: Float32Array;
  targetPositions: Float32Array;
  arcOffsets: Float32Array;
  nodeDelays: Float32Array;
  nodeDurations: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  baseOpacities: Float32Array;
  meta: Float32Array;
  pulse: Float32Array;
  posAttr: THREE.BufferAttribute;
  colorAttr: THREE.BufferAttribute;
  sizeAttr: THREE.BufferAttribute;
  metaAttr: THREE.BufferAttribute;
  pulseAttr: THREE.BufferAttribute;
}

interface SemanticEdgeBundle {
  geometry: THREE.BufferGeometry;
  posArray: Float32Array;
  posAttr: THREE.BufferAttribute;
  pairs: Int32Array;
}

type LayoutTransitionMode = "none" | "sand" | "fade";

interface LayoutTransitionState {
  initialized: boolean;
  mode: LayoutTransitionMode;
  elapsedSec: number;
  maxEndTimeSec: number;
  fadeHalfSec: number;
  fadeSwapped: boolean;
  fadeOpacity: number;
  nodeIds: Uuid[];
}

function setMaterialOpacity(mat: THREE.Material, opacity: number): void {
  if (mat instanceof THREE.ShaderMaterial && mat.uniforms.uOpacity) {
    mat.uniforms.uOpacity.value = opacity;
  } else {
    mat.opacity = opacity;
  }
}

function syncSemanticEdgesFromPositions(
  bundle: SemanticEdgeBundle | null,
  positions: Float32Array,
): void {
  if (!bundle) return;
  const { pairs, posArray, posAttr } = bundle;
  const edgeCount = pairs.length >>> 1;
  for (let e = 0; e < edgeCount; e += 1) {
    const src3 = (pairs[e * 2] ?? 0) * 3;
    const dst3 = (pairs[e * 2 + 1] ?? 0) * 3;
    const e6 = e * 6;
    posArray[e6] = positions[src3] ?? 0;
    posArray[e6 + 1] = positions[src3 + 1] ?? 0;
    posArray[e6 + 2] = positions[src3 + 2] ?? 0;
    posArray[e6 + 3] = positions[dst3] ?? 0;
    posArray[e6 + 4] = positions[dst3 + 1] ?? 0;
    posArray[e6 + 5] = positions[dst3 + 2] ?? 0;
  }
  posAttr.needsUpdate = true;
}

function createPointBuffers(capacity: number): PointBuffers {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 3);
  const prevPositions = new Float32Array(capacity * 3);
  const targetPositions = new Float32Array(capacity * 3);
  const arcOffsets = new Float32Array(capacity * 3);
  const nodeDelays = new Float32Array(capacity);
  const nodeDurations = new Float32Array(capacity);
  const colors = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  const baseOpacities = new Float32Array(capacity);
  baseOpacities.fill(1);
  const meta = new Float32Array(capacity * 4);
  const pulse = new Float32Array(capacity * 4);

  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  const sizeAttr = new THREE.BufferAttribute(sizes, 1);
  sizeAttr.setUsage(THREE.DynamicDrawUsage);
  const metaAttr = new THREE.BufferAttribute(meta, 4);
  metaAttr.setUsage(THREE.DynamicDrawUsage);
  const pulseAttr = new THREE.BufferAttribute(pulse, 4);
  pulseAttr.setUsage(THREE.DynamicDrawUsage);

  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("aColor", colorAttr);
  geometry.setAttribute("aSize", sizeAttr);
  geometry.setAttribute("aMeta", metaAttr);
  geometry.setAttribute("aPulse", pulseAttr);

  return {
    capacity,
    geometry,
    positions,
    prevPositions,
    targetPositions,
    arcOffsets,
    nodeDelays,
    nodeDurations,
    colors,
    sizes,
    baseOpacities,
    meta,
    pulse,
    posAttr,
    colorAttr,
    sizeAttr,
    metaAttr,
    pulseAttr,
  };
}

function nextCapacity(needed: number): number {
  let cap = INITIAL_CAPACITY;
  while (cap < needed) {
    cap *= 2;
  }
  return cap;
}

function attachUniformEdgeColorAttribute(geometry: THREE.BufferGeometry, colorHex: string): void {
  const posAttr = geometry.getAttribute("position");
  if (!posAttr) return;
  const col = new THREE.Color(colorHex);
  const count = posAttr.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    colors[i3] = col.r;
    colors[i3 + 1] = col.g;
    colors[i3 + 2] = col.b;
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
}

export function BrainScene({
  graph,
  manifest,
  themeBasePath,
  activeLayout,
  clusterSizeMetric,
  showConnections,
  hardwareTier,
  filters,
  searchQuery,
  hoveredNodeId,
  selectedNodeId,
  highlightedNodeIds,
  resetSignal,
  centerViewSignal,
  onHoverNode,
  onSelectNode,
  onContainersChange,
  onPulseVisibilityChange,
  onNodesInViewChange,
}: BrainSceneProps) {
  const { t, i18n } = useTranslation();
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);

  const disableThemeShaders = useThemeStore((s) => s.disableThemeShaders);
  const shadersDisabledForSession = useThemeStore((s) => s.shadersDisabledForSession);
  const pushThemeWarning = useThemeStore((s) => s.pushThemeWarning);
  const dismissThemeWarning = useThemeStore((s) => s.dismissThemeWarning);

  const isProjectIslands = activeLayout === "project_islands";
  const maxFps = hardwareTier === "eco" ? 30 : hardwareTier === "balanced" ? 60 : null;

  const shadersAllowed = useMemo(
    () =>
      areCustomShadersAllowed({
        manifest,
        hardwareTier,
        disableThemeShaders,
        shadersDisabledForSession,
      }),
    [disableThemeShaders, hardwareTier, manifest, shadersDisabledForSession],
  );

  // ---------------------------------------------------------------------------
  // 1. Load custom GLSL shader sources from installed theme folder
  // ---------------------------------------------------------------------------
  const [loadedShaders, setLoadedShaders] = useState<LoadedThemeShaders | null>(null);

  useEffect(() => {
    if (!shadersAllowed || !hasAnyCustomShader(manifest.shaders)) {
      setLoadedShaders(null);
      return;
    }

    // Wait for installedThemes / appInfo to provide the theme directory inside Tauri
    if (!themeBasePath && isTauri()) {
      setLoadedShaders(null);
      return;
    }

    const controller = new AbortController();
    void loadThemeShaderSources(themeBasePath, manifest.shaders, controller.signal).then(
      ({ sources, errors }) => {
        if (controller.signal.aborted) return;
        for (const err of errors) {
          pushThemeWarning({
            id: `shader-load:${manifest.id}:${err.layer}:${err.path}`,
            themeId: manifest.id,
            kind: "shader_load",
            layer: err.layer,
            summaryKey: "themes.warnings.shaderLoadFailed",
            summaryParams: { path: err.path },
            detail: err.message,
          });
        }
        setLoadedShaders(sources);
      },
    );

    return () => {
      controller.abort();
    };
  }, [
    manifest.id,
    manifest.shaders,
    pushThemeWarning,
    shadersAllowed,
    themeBasePath,
  ]);

  // ---------------------------------------------------------------------------
  // 2. Load GLB asset for `custom_mesh` layout and/or `node_geometry.shape === "mesh"`
  // ---------------------------------------------------------------------------
  const needCustomMeshLayout = activeLayout === "custom_mesh";
  const needNodeMesh = manifest.node_geometry.shape === "mesh" && hardwareTier !== "eco";
  const [loadedGlb, setLoadedGlb] = useState<ParsedThemeGlb | null>(null);

  useEffect(() => {
    if (!needCustomMeshLayout && !needNodeMesh) {
      setLoadedGlb(null);
      return;
    }

    if (!manifest.mesh_path) {
      setLoadedGlb(null);
      if (needCustomMeshLayout) {
        pushThemeWarning({
          id: `mesh-missing:${manifest.id}`,
          themeId: manifest.id,
          kind: "mesh_load",
          layer: "mesh",
          summaryKey: "themes.warnings.customMeshFailed",
          detail: "Theme manifest does not specify mesh_path.",
        });
      }
      if (needNodeMesh) {
        pushThemeWarning({
          id: `node-mesh-missing:${manifest.id}`,
          themeId: manifest.id,
          kind: "node_mesh_fallback",
          layer: "mesh",
          summaryKey: "themes.warnings.nodeMeshFallback",
          detail: "Theme manifest does not specify mesh_path.",
        });
      }
      return;
    }

    if (!themeBasePath && isTauri()) {
      setLoadedGlb(null);
      return;
    }

    const controller = new AbortController();
    void loadThemeGlb(
      themeBasePath,
      manifest.mesh_path,
      { needLayout: needCustomMeshLayout, needNodeMesh },
      controller.signal,
    ).then((parsed) => {
      if (controller.signal.aborted) {
        disposeParsedThemeGlb(parsed);
        return;
      }
      if (parsed.customMeshData) {
        dismissThemeWarning(`mesh-load:${manifest.id}:${manifest.mesh_path}`);
        dismissThemeWarning(`mesh-missing:${manifest.id}`);
      } else if (parsed.customMeshError) {
        pushThemeWarning({
          id: `mesh-load:${manifest.id}:${manifest.mesh_path}`,
          themeId: manifest.id,
          kind: "mesh_load",
          layer: "mesh",
          summaryKey: "themes.warnings.customMeshFailed",
          detail: parsed.customMeshError,
        });
      }
      if (parsed.nodeMeshGeometry) {
        dismissThemeWarning(`node-mesh:${manifest.id}:${manifest.mesh_path}`);
        dismissThemeWarning(`node-mesh-missing:${manifest.id}`);
      } else if (parsed.nodeMeshError) {
        pushThemeWarning({
          id: `node-mesh:${manifest.id}:${manifest.mesh_path}`,
          themeId: manifest.id,
          kind: "node_mesh_fallback",
          layer: "mesh",
          summaryKey: "themes.warnings.nodeMeshFallback",
          detail: parsed.nodeMeshError,
        });
      }
      setLoadedGlb(parsed);
    });

    return () => {
      controller.abort();
    };
  }, [
    dismissThemeWarning,
    manifest.id,
    manifest.mesh_path,
    needCustomMeshLayout,
    needNodeMesh,
    pushThemeWarning,
    themeBasePath,
  ]);

  useEffect(() => {
    return () => {
      disposeParsedThemeGlb(loadedGlb);
    };
  }, [loadedGlb]);

  // Fast O(1) lookup from memory_id -> project_id for cross-island edge filtering
  const nodeProjectMap = useMemo(() => {
    const map = new Map<Uuid, Uuid | null>();
    for (const node of graph.nodes) {
      map.set(node.id, node.project_id);
    }
    return map;
  }, [graph.nodes]);

  // Map project_id -> color_hex for project_clusters coloring
  const projectColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of graph.projects) {
      map.set(p.project.id, p.project.color_hex);
    }
    return map;
  }, [graph.projects]);

  // Fast O(1) lookup from memory_id -> index in `graph.nodes`
  const nodeIndexMap = useMemo(() => {
    const map = new Map<Uuid, number>();
    for (let i = 0; i < graph.nodes.length; i += 1) {
      const node = graph.nodes[i];
      if (node) map.set(node.id, i);
    }
    return map;
  }, [graph.nodes]);

  const activeCustomMeshData =
    activeLayout === "custom_mesh" ? (loadedGlb?.customMeshData ?? null) : null;

  // Compute deterministic target coordinates via pure LayoutFn (falls back to galaxy on failure)
  const layoutResult = useMemo(() => {
    const layoutFn = resolveLayoutFn(activeLayout, activeCustomMeshData);
    return layoutFn({
      nodes: graph.nodes,
      edges: graph.edges,
      projects: graph.projects,
      params: manifest.layout_params,
      sizeMetric: clusterSizeMetric,
    });
  }, [
    activeCustomMeshData,
    activeLayout,
    clusterSizeMetric,
    graph.edges,
    graph.nodes,
    graph.projects,
    manifest.layout_params,
  ]);

  useEffect(() => {
    onContainersChange?.(layoutResult.projectContainers ?? []);
  }, [layoutResult.projectContainers, onContainersChange]);

  // Persistent GPU buffers (reused in place; only grown if node count exceeds capacity)
  const requiredCapacity = nextCapacity(Math.max(1, graph.nodes.length));
  const buffersRef = useRef<PointBuffers | null>(null);
  if (!buffersRef.current || buffersRef.current.capacity < requiredCapacity) {
    const prevBuffers = buffersRef.current;
    const nextBuffers = createPointBuffers(requiredCapacity);
    if (prevBuffers) {
      nextBuffers.positions.set(prevBuffers.positions);
      nextBuffers.prevPositions.set(prevBuffers.prevPositions);
      prevBuffers.geometry.dispose();
    }
    buffersRef.current = nextBuffers;
  }
  const buffers = buffersRef.current;

  useEffect(() => {
    return () => {
      buffersRef.current?.geometry.dispose();
      buffersRef.current = null;
    };
  }, []);

  const sizeRef = useRef(size);
  sizeRef.current = size;

  // ---------------------------------------------------------------------------
  // 3. Validated shader materials (node points, edges, full-screen background)
  // ---------------------------------------------------------------------------
  const nodeShaderBundle = useMemo(() => {
    const customVertex = shadersAllowed ? (loadedShaders?.nodeVertex ?? null) : null;
    const customFragment = shadersAllowed ? (loadedShaders?.nodeFragment ?? null) : null;

    if (customVertex || customFragment) {
      const vs = customVertex ?? NODE_POINT_VERTEX_SHADER;
      const fs = customFragment ?? NODE_POINT_FRAGMENT_SHADER;
      const validation = validateShaderProgram(gl.getContext(), vs, fs);
      if (validation.ok) {
        return {
          material: createNodePointMaterial(manifest.palette.core_pin, {
            vertex: vs,
            fragment: fs,
          }),
          isCustom: true,
          errorLog: null as string | null,
        };
      }
      return {
        material: createNodePointMaterial(manifest.palette.core_pin),
        isCustom: false,
        errorLog: validation.log,
      };
    }

    return {
      material: createNodePointMaterial(manifest.palette.core_pin),
      isCustom: false,
      errorLog: null as string | null,
    };
  }, [
    gl,
    loadedShaders?.nodeFragment,
    loadedShaders?.nodeVertex,
    manifest.id,
    manifest.palette.core_pin,
    shadersAllowed,
  ]);

  const pointMaterial = nodeShaderBundle.material;

  useEffect(() => {
    if (nodeShaderBundle.errorLog) {
      pushThemeWarning({
        id: `shader-compile:${manifest.id}:node`,
        themeId: manifest.id,
        kind: "shader_compile",
        layer: "node",
        summaryKey: "themes.warnings.shaderCompileFailed",
        detail: nodeShaderBundle.errorLog,
      });
    }
  }, [manifest.id, nodeShaderBundle.errorLog, pushThemeWarning]);

  useEffect(() => {
    return () => {
      pointMaterial.dispose();
    };
  }, [pointMaterial]);

  const edgeShaderConfig = useMemo(() => {
    const customVertex = shadersAllowed ? (loadedShaders?.edgeVertex ?? null) : null;
    const customFragment = shadersAllowed ? (loadedShaders?.edgeFragment ?? null) : null;
    if (!customVertex && !customFragment) {
      return {
        isCustom: false,
        vertex: null as string | null,
        fragment: null as string | null,
        errorLog: null as string | null,
      };
    }

    const vs = customVertex ?? EDGE_VERTEX_SHADER;
    const fs = customFragment ?? EDGE_FRAGMENT_SHADER;
    const validation = validateShaderProgram(gl.getContext(), vs, fs, {
      vertexColors: !declaresColorAttribute(vs),
    });

    if (validation.ok) {
      return {
        isCustom: true,
        vertex: vs,
        fragment: fs,
        errorLog: null as string | null,
      };
    }
    return {
      isCustom: false,
      vertex: null as string | null,
      fragment: null as string | null,
      errorLog: validation.log,
    };
  }, [gl, loadedShaders?.edgeFragment, loadedShaders?.edgeVertex, shadersAllowed]);

  useEffect(() => {
    if (edgeShaderConfig.errorLog) {
      pushThemeWarning({
        id: `shader-compile:${manifest.id}:edge`,
        themeId: manifest.id,
        kind: "shader_compile",
        layer: "edge",
        summaryKey: "themes.warnings.shaderCompileFailed",
        detail: edgeShaderConfig.errorLog,
      });
    }
  }, [edgeShaderConfig.errorLog, manifest.id, pushThemeWarning]);

  const backgroundBundle = useMemo(() => {
    const customFragment = shadersAllowed ? (loadedShaders?.backgroundFragment ?? null) : null;
    if (!customFragment) {
      return { material: null as THREE.ShaderMaterial | null, errorLog: null as string | null };
    }

    const validation = validateShaderProgram(
      gl.getContext(),
      BACKGROUND_VERTEX_SHADER,
      customFragment,
    );
    if (!validation.ok) {
      return { material: null as THREE.ShaderMaterial | null, errorLog: validation.log };
    }

    return {
      material: createBackgroundShaderMaterial(
        manifest.palette.background,
        customFragment,
        sizeRef.current.width,
        sizeRef.current.height,
        gl.getPixelRatio(),
      ),
      errorLog: null as string | null,
    };
  }, [gl, loadedShaders?.backgroundFragment, manifest.palette.background, shadersAllowed]);

  useEffect(() => {
    if (backgroundBundle.errorLog) {
      pushThemeWarning({
        id: `shader-compile:${manifest.id}:background`,
        themeId: manifest.id,
        kind: "shader_compile",
        layer: "background",
        summaryKey: "themes.warnings.shaderCompileFailed",
        detail: backgroundBundle.errorLog,
      });
    }
  }, [backgroundBundle.errorLog, manifest.id, pushThemeWarning]);

  const backgroundQuadGeometry = useMemo(() => new THREE.PlaneGeometry(2, 2), []);

  useEffect(() => {
    return () => {
      backgroundQuadGeometry.dispose();
    };
  }, [backgroundQuadGeometry]);

  useEffect(() => {
    return () => {
      backgroundBundle.material?.dispose();
    };
  }, [backgroundBundle.material]);

  // ---------------------------------------------------------------------------
  // 4. Visible node set & Volumetric InstancedMesh (balanced/ultra, ≤ 5,000 visible)
  // ---------------------------------------------------------------------------
  const visibleNodeIds = useMemo(() => {
    const visible = new Set<Uuid>();
    for (const node of graph.nodes) {
      if (matchesVisualFilters(node, filters, searchQuery)) {
        visible.add(node.id);
      }
    }
    return visible;
  }, [filters, graph.nodes, searchQuery]);

  const requestedShape = manifest.node_geometry.shape;
  const volumetricEligible =
    requestedShape !== "point" &&
    hardwareTier !== "eco" &&
    visibleNodeIds.size <= VOLUMETRIC_MAX_VISIBLE_NODES;

  const volumetricGeoSpec = useMemo(() => {
    if (!volumetricEligible) {
      return { geometry: null as THREE.BufferGeometry | null, owned: false };
    }
    if (requestedShape === "mesh") {
      return {
        geometry: loadedGlb?.nodeMeshGeometry ?? null,
        owned: false,
      };
    }
    return {
      geometry: createNodeGeometry(manifest.node_geometry),
      owned: true,
    };
  }, [
    loadedGlb?.nodeMeshGeometry,
    manifest.node_geometry,
    requestedShape,
    volumetricEligible,
  ]);

  useEffect(() => {
    return () => {
      if (volumetricGeoSpec.owned) {
        volumetricGeoSpec.geometry?.dispose();
      }
    };
  }, [volumetricGeoSpec]);

  const volumetricMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        toneMapped: false,
      }),
    [],
  );

  useEffect(() => {
    return () => {
      volumetricMaterial.dispose();
    };
  }, [volumetricMaterial]);

  const instancedMesh = useMemo(() => {
    const geo = volumetricGeoSpec.geometry;
    if (!geo) return null;
    const mesh = new THREE.InstancedMesh(geo, volumetricMaterial, requiredCapacity);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const colorAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(requiredCapacity * 3),
      3,
    );
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = colorAttr;
    mesh.count = graph.nodes.length;
    return mesh;
  }, [graph.nodes.length, requiredCapacity, volumetricGeoSpec.geometry, volumetricMaterial]);

  useEffect(() => {
    return () => {
      instancedMesh?.dispose();
    };
  }, [instancedMesh]);

  const useVolumetricMesh = instancedMesh !== null;

  // Scratch math objects for zero-allocation InstancedMesh updates
  const scratchMatrixRef = useRef(new THREE.Matrix4());
  const scratchPosRef = useRef(new THREE.Vector3());
  const scratchQuatRef = useRef(new THREE.Quaternion());
  const scratchScaleRef = useRef(new THREE.Vector3());
  const scratchColorRef = useRef(new THREE.Color());
  const scratchPulseColorRef = useRef(new THREE.Color());
  const scratchWhiteColorRef = useRef(new THREE.Color("#FFFFFF"));
  const scratchRagColorRef = useRef(new THREE.Color("#78A8FF"));
  const bgColorRef = useRef(new THREE.Color(manifest.palette.background));
  bgColorRef.current.set(manifest.palette.background);

  // Smooth dimming, fade, & pulse tracking refs (zero-allocation per-frame updates)
  const dimFactorRef = useRef(1.0);
  const appliedDimFactorRef = useRef(1.0);
  const appliedFadeOpacityRef = useRef(1.0);
  const appliedChromeOpacityRef = useRef(1.0);
  const appliedSemanticFadeRef = useRef(1.0);
  const activePulsedIndicesRef = useRef<Set<number>>(new Set());
  const activeVisualPulseIndicesRef = useRef<Set<number>>(new Set());

  const prefersReducedMotion = usePrefersReducedMotion();
  const prefersReducedMotionRef = useRef(prefersReducedMotion);
  prefersReducedMotionRef.current = prefersReducedMotion;

  const writeVolumetricInstance = useCallback(
    (mesh: THREE.InstancedMesh, idx: number, updateColor: boolean) => {
      const i3 = idx * 3;
      const i4 = idx * 4;
      const sizeVal = buffers.sizes[idx] ?? 0;
      const rawPulse = buffers.pulse[i4 + 3] ?? 0;
      const aiPulse = rawPulse > 0 ? rawPulse : 0;
      const flickerPulse = rawPulse < 0 ? -rawPulse : 0;

      const mat = scratchMatrixRef.current;
      const pos = scratchPosRef.current;
      const quat = scratchQuatRef.current;
      const scl = scratchScaleRef.current;

      pos.set(
        buffers.positions[i3] ?? 0,
        buffers.positions[i3 + 1] ?? 0,
        buffers.positions[i3 + 2] ?? 0,
      );

      if (sizeVal <= 0.0001) {
        scl.set(0, 0, 0);
      } else {
        const s = sizeVal * VOLUMETRIC_SCALE_MULTIPLIER * (1 + aiPulse * 1.9);
        scl.set(s, s, s);
      }

      mat.compose(pos, quat, scl);
      mesh.setMatrixAt(idx, mat);

      if (updateColor) {
        const col = scratchColorRef.current;
        col.setRGB(
          buffers.colors[i3] ?? 1,
          buffers.colors[i3 + 1] ?? 1,
          buffers.colors[i3 + 2] ?? 1,
        );
        const opacityScale = buffers.meta[i4 + 3] ?? 1;
        if (opacityScale < 0.99) {
          col.lerp(bgColorRef.current, 1 - opacityScale);
        }
        const focus = buffers.meta[i4 + 2] ?? 0;
        if (focus > 2.5) {
          col.lerp(scratchRagColorRef.current, 0.45);
        }
        if (aiPulse > 0.01) {
          const pCol = scratchPulseColorRef.current;
          pCol.setRGB(
            buffers.pulse[i4] ?? 1,
            buffers.pulse[i4 + 1] ?? 1,
            buffers.pulse[i4 + 2] ?? 1,
          );
          col.lerp(pCol, Math.min(1, aiPulse * 0.95));
          col.lerp(scratchWhiteColorRef.current, Math.min(0.65, aiPulse * 0.45));
        } else if (flickerPulse > 0.01) {
          const pCol = scratchPulseColorRef.current;
          pCol.setRGB(
            buffers.pulse[i4] ?? 1,
            buffers.pulse[i4 + 1] ?? 1,
            buffers.pulse[i4 + 2] ?? 1,
          );
          col.lerp(pCol, Math.min(0.35, flickerPulse * 0.45));
        }
        mesh.setColorAt(idx, col);
      }
    },
    [buffers],
  );

  // Spatial index for fast picking at 50k+ nodes
  const spatialGridRef = useRef<SpatialHashGrid>(new SpatialHashGrid(14));
  const spatialDirtyRef = useRef(true);

  // Organic sand / reduced-motion fade layout transition state (all per-node data lives in GPU buffers)
  const transitionRef = useRef<LayoutTransitionState>({
    initialized: false,
    mode: "none",
    elapsedSec: 0,
    maxEndTimeSec: 0,
    fadeHalfSec: REDUCED_MOTION_FADE_SEC * 0.5,
    fadeSwapped: false,
    fadeOpacity: 1,
    nodeIds: [],
  });

  // Update target positions whenever layout or node set changes, triggering sand or reduced-motion transition
  useEffect(() => {
    const count = graph.nodes.length;
    const {
      positions,
      prevPositions,
      targetPositions,
      arcOffsets,
      nodeDelays,
      nodeDurations,
      geometry,
      posAttr,
    } = buffers;
    const state = transitionRef.current;

    if (!state.initialized) {
      for (let i = 0; i < count; i += 1) {
        const node = graph.nodes[i];
        if (!node) continue;
        const target = layoutResult.nodePositions[node.id] ?? [0, 0, 0];
        const i3 = i * 3;
        positions[i3] = target[0];
        positions[i3 + 1] = target[1];
        positions[i3 + 2] = target[2];
        prevPositions[i3] = target[0];
        prevPositions[i3 + 1] = target[1];
        prevPositions[i3 + 2] = target[2];
        targetPositions[i3] = target[0];
        targetPositions[i3 + 1] = target[1];
        targetPositions[i3 + 2] = target[2];
      }

      geometry.setDrawRange(0, count);
      state.initialized = true;
      state.mode = "none";
      state.elapsedSec = 0;
      state.maxEndTimeSec = 0;
      state.fadeSwapped = false;
      state.fadeOpacity = 1;
      state.nodeIds = graph.nodes.map((n) => n.id);
      posAttr.needsUpdate = true;
      spatialDirtyRef.current = true;
      return;
    }

    // Check whether node list order is unchanged (common layout-switch path, zero allocations)
    const prevIds = state.nodeIds;
    let sameNodeOrder = prevIds.length === count;
    if (sameNodeOrder) {
      for (let i = 0; i < count; i += 1) {
        if (prevIds[i] !== graph.nodes[i]?.id) {
          sameNodeOrder = false;
          break;
        }
      }
    }

    if (sameNodeOrder) {
      for (let i = 0; i < count; i += 1) {
        const node = graph.nodes[i];
        if (!node) continue;
        const target = layoutResult.nodePositions[node.id] ?? [0, 0, 0];
        const i3 = i * 3;
        // Continue seamlessly from current GPU positions (handles mid-flight interruptions)
        prevPositions[i3] = positions[i3] ?? target[0];
        prevPositions[i3 + 1] = positions[i3 + 1] ?? target[1];
        prevPositions[i3 + 2] = positions[i3 + 2] ?? target[2];
        targetPositions[i3] = target[0];
        targetPositions[i3 + 1] = target[1];
        targetPositions[i3 + 2] = target[2];
      }
    } else {
      const prevIdxById = new Map<Uuid, number>();
      for (let i = 0; i < prevIds.length; i += 1) {
        const id = prevIds[i];
        if (id) prevIdxById.set(id, i);
      }
      const oldSnapshot = positions.slice(0, prevIds.length * 3);

      for (let i = 0; i < count; i += 1) {
        const node = graph.nodes[i];
        if (!node) continue;
        const target = layoutResult.nodePositions[node.id] ?? [0, 0, 0];
        const i3 = i * 3;
        const oldIdx = prevIdxById.get(node.id);

        if (oldIdx !== undefined) {
          const o3 = oldIdx * 3;
          const ox = oldSnapshot[o3] ?? target[0];
          const oy = oldSnapshot[o3 + 1] ?? target[1];
          const oz = oldSnapshot[o3 + 2] ?? target[2];
          prevPositions[i3] = ox;
          prevPositions[i3 + 1] = oy;
          prevPositions[i3 + 2] = oz;
          positions[i3] = ox;
          positions[i3 + 1] = oy;
          positions[i3 + 2] = oz;
        } else {
          // Brand-new node spawns directly at its destination
          prevPositions[i3] = target[0];
          prevPositions[i3 + 1] = target[1];
          prevPositions[i3 + 2] = target[2];
          positions[i3] = target[0];
          positions[i3 + 1] = target[1];
          positions[i3 + 2] = target[2];
        }

        targetPositions[i3] = target[0];
        targetPositions[i3 + 1] = target[1];
        targetPositions[i3 + 2] = target[2];
      }
      state.nodeIds = graph.nodes.map((n) => n.id);
    }

    geometry.setDrawRange(0, count);

    if (prefersReducedMotionRef.current) {
      const halfSec = REDUCED_MOTION_FADE_SEC * 0.5;
      state.fadeHalfSec = halfSec;
      if (state.mode === "fade" && !state.fadeSwapped) {
        // Already fading out: keep current fade progress toward the newest target
      } else if (state.mode === "fade" && state.fadeSwapped) {
        // Interrupted while fading in: reverse smoothly from current opacity without popping
        state.elapsedSec = halfSec * (1 - state.fadeOpacity);
        state.fadeSwapped = false;
      } else {
        state.mode = "fade";
        state.elapsedSec = 0;
        state.fadeSwapped = false;
        state.fadeOpacity = 1;
      }
      if (!sameNodeOrder) {
        posAttr.needsUpdate = true;
      }
    } else {
      const maxEndTimeSec = prepareSandTransition({
        nodes: graph.nodes,
        prevPositions,
        targetPositions,
        arcOffsets,
        nodeDelays,
        nodeDurations,
      });
      state.mode = maxEndTimeSec > 0 ? "sand" : "none";
      state.elapsedSec = 0;
      state.maxEndTimeSec = maxEndTimeSec;
      state.fadeSwapped = false;
      state.fadeOpacity = 1;
      if (!sameNodeOrder || maxEndTimeSec === 0) {
        posAttr.needsUpdate = true;
      }
    }

    // Force layout chrome opacity resync on the next frame
    appliedChromeOpacityRef.current = -1;
    spatialDirtyRef.current = true;
  }, [buffers, graph.nodes, layoutResult]);

  // Update colors, sizes (filters = size 0), and meta attributes IN PLACE (zero geometry rebuild)
  useEffect(() => {
    const count = graph.nodes.length;
    const { colors, sizes, baseOpacities, meta, colorAttr, sizeAttr, metaAttr } = buffers;
    const tmpColor = new THREE.Color();
    const baseSize = Math.max(0.4, manifest.node_geometry.base_size) * 2.4;
    const scaleByHits = manifest.node_geometry.scale_by_hits;
    const activePulses = activePulsedIndicesRef.current;
    const currentDim = dimFactorRef.current;
    const currentFade = transitionRef.current.fadeOpacity;

    for (let i = 0; i < count; i += 1) {
      const node = graph.nodes[i];
      if (!node) continue;

      const visible = matchesVisualFilters(node, filters, searchQuery);
      const isHovered = node.id === hoveredNodeId;
      const isSelected = node.id === selectedNodeId;
      const isHighlighted = highlightedNodeIds.has(node.id);

      if (!visible) {
        sizes[i] = 0;
      } else {
        const hitBoost = scaleByHits ? 1 + Math.min(Math.log1p(node.hit_count) * 0.28, 1.15) : 1;
        const pinBoost = node.is_core_pin ? 1.35 : 1;
        const focusBoost = isSelected ? 1.45 : isHovered ? 1.35 : isHighlighted ? 1.28 : 1;
        sizes[i] = baseSize * hitBoost * pinBoost * focusBoost;
      }

      tmpColor.set(resolveNodeColorHex(node, manifest, activeLayout, projectColorMap));
      if (node.is_encrypted) {
        tmpColor.lerp(new THREE.Color("#64748B"), 0.55);
      } else if (isHovered || isSelected) {
        tmpColor.lerp(new THREE.Color("#FFFFFF"), 0.3);
      }

      const i3 = i * 3;
      colors[i3] = tmpColor.r;
      colors[i3 + 1] = tmpColor.g;
      colors[i3 + 2] = tmpColor.b;

      const baseOpacity = node.status === "active" ? 1.0 : 0.45;
      baseOpacities[i] = baseOpacity;

      const i4 = i * 4;
      meta[i4] = node.is_core_pin ? 1 : 0;
      meta[i4 + 1] = node.is_reusable ? 1 : 0;
      meta[i4 + 2] = isSelected ? 2 : isHovered ? 1 : isHighlighted ? 3 : 0;
      const rawOpacity = activePulses.has(i)
        ? 1.0
        : isSelected || isHovered
          ? Math.max(baseOpacity * currentDim, 0.85)
          : baseOpacity * currentDim;
      meta[i4 + 3] = rawOpacity * currentFade;
    }

    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    metaAttr.needsUpdate = true;
    appliedDimFactorRef.current = currentDim;
    appliedFadeOpacityRef.current = currentFade;
    spatialDirtyRef.current = true;
  }, [
    activeLayout,
    buffers,
    filters,
    graph.nodes,
    highlightedNodeIds,
    hoveredNodeId,
    manifest,
    projectColorMap,
    searchQuery,
    selectedNodeId,
  ]);

  // Synchronize volumetric InstancedMesh buffers whenever nodes/filters/focus/layout/shape change
  useEffect(() => {
    if (!instancedMesh) return;
    const count = graph.nodes.length;
    instancedMesh.count = count;
    for (let i = 0; i < count; i += 1) {
      writeVolumetricInstance(instancedMesh, i, true);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;
    if (instancedMesh.instanceColor) {
      instancedMesh.instanceColor.needsUpdate = true;
    }
  }, [
    activeLayout,
    buffers,
    filters,
    graph.nodes,
    highlightedNodeIds,
    hoveredNodeId,
    instancedMesh,
    layoutResult,
    manifest,
    searchQuery,
    selectedNodeId,
    writeVolumetricInstance,
  ]);

  const islandFraming = useMemo(() => {
    if (!isProjectIslands) return null;
    const containers = layoutResult.projectContainers ?? [];
    const aspect = sizeRef.current.width / Math.max(1, sizeRef.current.height);
    return computeIslandsCameraFraming(containers, manifest.camera.fov, aspect);
  }, [isProjectIslands, layoutResult.projectContainers, manifest.camera.fov]);

  // Keep OrbitControls maxDistance monotonic so switching layouts never pulls a zoomed-out camera inward
  const maxOrbitDistanceRef = useRef(480);
  const desiredMaxOrbitDistance = Math.max(480, islandFraming?.maxDistance ?? 480);
  if (desiredMaxOrbitDistance > maxOrbitDistanceRef.current) {
    maxOrbitDistanceRef.current = desiredMaxOrbitDistance;
  }

  // Latest layout/theme/node data in refs so camera actions never re-trigger on layout switches
  const manifestCameraRef = useRef(manifest.camera);
  manifestCameraRef.current = manifest.camera;
  const isProjectIslandsRef = useRef(isProjectIslands);
  isProjectIslandsRef.current = isProjectIslands;
  const islandFramingRef = useRef(islandFraming);
  islandFramingRef.current = islandFraming;
  const layoutPositionsRef = useRef(layoutResult.nodePositions);
  layoutPositionsRef.current = layoutResult.nodePositions;
  const nodeIndexMapRef = useRef(nodeIndexMap);
  nodeIndexMapRef.current = nodeIndexMap;
  const visibleNodeIdsRef = useRef(visibleNodeIds);
  visibleNodeIdsRef.current = visibleNodeIds;
  const buffersPositionsRef = useRef(buffers.positions);
  buffersPositionsRef.current = buffers.positions;

  // Unified smooth camera transition state (node focus, reset camera, center view, theme change)
  const focusRequest = useMemoryStore((s) => s.focusRequest);
  const cameraAnimRef = useRef<{
    startPos: THREE.Vector3;
    endPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    endTarget: THREE.Vector3;
    startFov: number;
    endFov: number;
    startZoom: number;
    endZoom: number;
    progress: number;
    durationSec: number;
    easeMode: "out" | "inOut";
  } | null>(null);

  const startCameraAnimation = useCallback(
    (
      endPosTuple: Vec3,
      endTargetTuple: Vec3,
      endFov: number,
      durationSec: number,
      easeMode: "out" | "inOut",
      resetZoom = false,
    ) => {
      const startPos = camera.position.clone();
      const endPos = new THREE.Vector3(endPosTuple[0], endPosTuple[1], endPosTuple[2]);
      const startTarget = controlsRef.current
        ? controlsRef.current.target.clone()
        : new THREE.Vector3(0, 0, 0);
      const endTarget = new THREE.Vector3(endTargetTuple[0], endTargetTuple[1], endTargetTuple[2]);
      const startFov = camera instanceof THREE.PerspectiveCamera ? camera.fov : endFov;
      const startZoom = camera instanceof THREE.PerspectiveCamera ? camera.zoom : 1;
      const endZoom = resetZoom ? 1 : startZoom;

      const desiredDist = endPos.distanceTo(endTarget);
      if (desiredDist * 1.6 > maxOrbitDistanceRef.current) {
        maxOrbitDistanceRef.current = Math.ceil(desiredDist * 1.6);
        if (controlsRef.current) {
          controlsRef.current.maxDistance = maxOrbitDistanceRef.current;
        }
      }

      if (
        startPos.distanceTo(endPos) < 0.02 &&
        startTarget.distanceTo(endTarget) < 0.02 &&
        Math.abs(startFov - endFov) < 0.05 &&
        Math.abs(startZoom - endZoom) < 0.005
      ) {
        cameraAnimRef.current = null;
        return;
      }

      cameraAnimRef.current = {
        startPos,
        endPos,
        startTarget,
        endTarget,
        startFov,
        endFov,
        startZoom,
        endZoom,
        progress: 0,
        durationSec,
        easeMode,
      };
    },
    [camera],
  );

  // Cancel any camera transition immediately when the user grabs OrbitControls
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const cancelAnim = () => {
      cameraAnimRef.current = null;
    };
    controls.addEventListener("start", cancelAnim);
    return () => {
      controls.removeEventListener("start", cancelAnim);
    };
  }, []);

  // Apply theme camera ONLY on first load (immediate) and theme switch (smooth ~0.8 s ease).
  // Switching layouts NEVER touches camera position, target, zoom, FOV, or auto-rotate state.
  const cameraInitializedRef = useRef(false);
  const lastThemeIdRef = useRef<string | null>(null);

  useEffect(() => {
    const cam = manifest.camera;
    const controls = controlsRef.current;

    if (!cameraInitializedRef.current) {
      cameraAnimRef.current = null;
      const [px, py, pz] = cam.position;
      const [tx, ty, tz] = cam.target;
      camera.position.set(px, py, pz);
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.fov = cam.fov;
        camera.updateProjectionMatrix();
      }
      if (controls) {
        controls.target.set(tx, ty, tz);
        controls.autoRotate = cam.auto_rotate;
        controls.autoRotateSpeed = cam.auto_rotate_speed;
        controls.update();
      }
      cameraInitializedRef.current = true;
      lastThemeIdRef.current = manifest.id;
      return;
    }

    if (lastThemeIdRef.current !== manifest.id) {
      lastThemeIdRef.current = manifest.id;
      if (controls) {
        controls.autoRotate = cam.auto_rotate;
        controls.autoRotateSpeed = cam.auto_rotate_speed;
      }
      startCameraAnimation(
        cam.position,
        cam.target,
        cam.fov,
        CAMERA_TRANSITION_DURATION_SEC,
        "inOut",
        true,
      );
    }
  }, [camera, manifest.camera, manifest.id, startCameraAnimation]);

  // Explicit reset-camera button: smoothly (~0.8 s) ease back to the active theme's camera
  const lastResetSignalRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === lastResetSignalRef.current) return;
    lastResetSignalRef.current = resetSignal;

    const cam = manifestCameraRef.current;
    if (controlsRef.current) {
      controlsRef.current.autoRotate = cam.auto_rotate;
      controlsRef.current.autoRotateSpeed = cam.auto_rotate_speed;
    }
    startCameraAnimation(
      cam.position,
      cam.target,
      cam.fov,
      CAMERA_TRANSITION_DURATION_SEC,
      "inOut",
      true,
    );
  }, [resetSignal, startCameraAnimation]);

  // Explicit "Center view" action: island overview for project_islands, or smooth visible-nodes framing
  const lastCenterViewSignalRef = useRef(centerViewSignal);
  useEffect(() => {
    if (centerViewSignal === lastCenterViewSignalRef.current) return;
    lastCenterViewSignalRef.current = centerViewSignal;

    const cam = manifestCameraRef.current;
    if (isProjectIslandsRef.current && islandFramingRef.current) {
      const framing = islandFramingRef.current;
      if (framing.maxDistance > maxOrbitDistanceRef.current) {
        maxOrbitDistanceRef.current = framing.maxDistance;
        if (controlsRef.current) {
          controlsRef.current.maxDistance = framing.maxDistance;
        }
      }
      startCameraAnimation(
        framing.position,
        framing.target,
        cam.fov,
        CAMERA_TRANSITION_DURATION_SEC,
        "inOut",
        true,
      );
      return;
    }

    const visibleIds = visibleNodeIdsRef.current;
    const nodePositions = layoutPositionsRef.current;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let count = 0;

    for (const id of visibleIds) {
      const pos = nodePositions[id];
      if (!pos) continue;
      if (pos[0] < minX) minX = pos[0];
      if (pos[0] > maxX) maxX = pos[0];
      if (pos[1] < minY) minY = pos[1];
      if (pos[1] > maxY) maxY = pos[1];
      if (pos[2] < minZ) minZ = pos[2];
      if (pos[2] > maxZ) maxZ = pos[2];
      count += 1;
    }

    if (count === 0) {
      startCameraAnimation(
        cam.position,
        cam.target,
        cam.fov,
        CAMERA_TRANSITION_DURATION_SEC,
        "inOut",
        true,
      );
      return;
    }

    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;

    let radiusSq = 0;
    for (const id of visibleIds) {
      const pos = nodePositions[id];
      if (!pos) continue;
      const dx = pos[0] - cx;
      const dy = pos[1] - cy;
      const dz = pos[2] - cz;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > radiusSq) radiusSq = dSq;
    }
    const radius = Math.sqrt(radiusSq);

    const dir = new THREE.Vector3(
      cam.position[0] - cam.target[0],
      cam.position[1] - cam.target[1],
      cam.position[2] - cam.target[2],
    );
    if (dir.lengthSq() < 1e-4) {
      dir.set(0, 0.25, 1);
    }
    dir.normalize();

    const aspect = Math.max(0.5, sizeRef.current.width / Math.max(1, sizeRef.current.height));
    const vFov = THREE.MathUtils.degToRad(Math.max(25, Math.min(90, cam.fov)));
    const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * aspect);
    const limitingHalfFov = Math.min(vFov, hFov) * 0.5;
    const fitDist = Math.max(42, (radius / Math.tan(limitingHalfFov)) * 1.18 + 18);

    const targetPos: Vec3 = [cx + dir.x * fitDist, cy + dir.y * fitDist, cz + dir.z * fitDist];
    const targetLookAt: Vec3 = [cx, cy, cz];
    startCameraAnimation(
      targetPos,
      targetLookAt,
      cam.fov,
      CAMERA_TRANSITION_DURATION_SEC,
      "inOut",
      true,
    );
  }, [centerViewSignal, startCameraAnimation]);

  // Smoothly focus camera on requested memory node(s) (consumed once per nonce; never re-triggers on layout change)
  const lastHandledFocusNonceRef = useRef(0);
  useEffect(() => {
    if (!focusRequest || focusRequest.nodeIds.length === 0) return;
    if (focusRequest.nonce === lastHandledFocusNonceRef.current) return;
    lastHandledFocusNonceRef.current = focusRequest.nonce;

    const indexMap = nodeIndexMapRef.current;
    const livePositions = buffersPositionsRef.current;
    const targetLayoutPositions = layoutPositionsRef.current;
    const points: THREE.Vector3[] = [];
    for (const id of focusRequest.nodeIds) {
      const idx = indexMap.get(id);
      if (idx !== undefined) {
        const i3 = idx * 3;
        points.push(
          new THREE.Vector3(
            livePositions[i3] ?? 0,
            livePositions[i3 + 1] ?? 0,
            livePositions[i3 + 2] ?? 0,
          ),
        );
      } else {
        const pos = targetLayoutPositions[id];
        if (pos) {
          points.push(new THREE.Vector3(pos[0], pos[1], pos[2]));
        }
      }
    }

    useMemoryStore.getState().clearFocusRequest();
    if (points.length === 0) return;

    const centroid = new THREE.Vector3();
    for (const pt of points) {
      centroid.add(pt);
    }
    centroid.divideScalar(points.length);

    let radius = 0;
    for (const pt of points) {
      radius = Math.max(radius, pt.distanceTo(centroid));
    }

    const currentTarget = controlsRef.current
      ? controlsRef.current.target.clone()
      : new THREE.Vector3(0, 0, 0);
    const viewDir = camera.position.clone().sub(currentTarget);
    const currentDist = viewDir.length();
    if (currentDist < 0.001) {
      viewDir.set(0, 0.28, 1).normalize();
    } else {
      viewDir.normalize();
    }

    const fovRad =
      camera instanceof THREE.PerspectiveCamera
        ? THREE.MathUtils.degToRad(camera.fov)
        : THREE.MathUtils.degToRad(55);
    const desiredDist =
      points.length === 1
        ? Math.max(26, Math.min(46, currentDist > 26 ? Math.min(currentDist, 40) : 34))
        : Math.max(36, Math.min(240, (radius / Math.tan(fovRad * 0.5)) * 1.45 + 26));

    const endPos = centroid.clone().addScaledVector(viewDir, desiredDist);
    const currentFov =
      camera instanceof THREE.PerspectiveCamera ? camera.fov : manifestCameraRef.current.fov;
    startCameraAnimation(
      [endPos.x, endPos.y, endPos.z],
      [centroid.x, centroid.y, centroid.z],
      currentFov,
      CAMERA_FOCUS_DURATION_SEC,
      "out",
      false,
    );
  }, [camera, focusRequest, startCameraAnimation]);

  // Keep latest callbacks/nodes in refs for zero-rebind DOM pointer listeners
  const latestNodesRef = useRef(graph.nodes);
  latestNodesRef.current = graph.nodes;
  const onHoverRef = useRef(onHoverNode);
  onHoverRef.current = onHoverNode;
  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;
  const lastHoveredIdxRef = useRef(-1);

  // Spatial-index DOM picking (works identically for points and volumetric InstancedMesh)
  useEffect(() => {
    const dom = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let pointerDownPos: { x: number; y: number } | null = null;
    let lastMoveTs = 0;

    const pickAtEvent = (e: PointerEvent | MouseEvent): GraphNode | null => {
      const rect = dom.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      if (spatialDirtyRef.current) {
        spatialGridRef.current.rebuild(
          buffers.positions,
          buffers.sizes,
          latestNodesRef.current.length,
        );
        spatialDirtyRef.current = false;
      }

      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);

      const fovRad =
        camera instanceof THREE.PerspectiveCamera
          ? THREE.MathUtils.degToRad(camera.fov)
          : THREE.MathUtils.degToRad(55);

      const hitIdx = spatialGridRef.current.pickRay(
        raycaster.ray,
        buffers.positions,
        buffers.sizes,
        fovRad,
        rect.height,
      );
      if (hitIdx < 0) return null;
      return latestNodesRef.current[hitIdx] ?? null;
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (e.buttons !== 0) return;
      const now = performance.now();
      if (now - lastMoveTs < 28) return;
      lastMoveTs = now;

      const node = pickAtEvent(e);
      const nextIdx = node ? (nodeIndexMap.get(node.id) ?? -1) : -1;
      if (nextIdx !== lastHoveredIdxRef.current) {
        lastHoveredIdxRef.current = nextIdx;
        dom.style.cursor = node ? "pointer" : "grab";
        onHoverRef.current(node);
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pointerDownPos = { x: e.clientX, y: e.clientY };
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (e.button !== 0 || !pointerDownPos) return;
      const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      pointerDownPos = null;
      if (dist > 5) return;

      const node = pickAtEvent(e);
      onSelectRef.current(node);
    };

    const handlePointerLeave = () => {
      if (lastHoveredIdxRef.current !== -1) {
        lastHoveredIdxRef.current = -1;
        onHoverRef.current(null);
      }
    };

    dom.addEventListener("pointermove", handlePointerMove);
    dom.addEventListener("pointerdown", handlePointerDown);
    dom.addEventListener("pointerup", handlePointerUp);
    dom.addEventListener("pointerleave", handlePointerLeave);
    return () => {
      dom.removeEventListener("pointermove", handlePointerMove);
      dom.removeEventListener("pointerdown", handlePointerDown);
      dom.removeEventListener("pointerup", handlePointerUp);
      dom.removeEventListener("pointerleave", handlePointerLeave);
      dom.style.cursor = "";
    };
  }, [buffers, camera, gl.domElement, nodeIndexMap]);

  // ---------------------------------------------------------------------------
  // 5. Real memory edges & structural layout edges (LineBasicMaterial -> ShaderMaterial only on custom edge shader)
  // ---------------------------------------------------------------------------
  const semanticEdgeBundle = useMemo<SemanticEdgeBundle | null>(() => {
    const focusId = hoveredNodeId ?? selectedNodeId;
    if (!showConnections && !focusId) return null;

    const useLivePositions = transitionRef.current.initialized;
    const coords: number[] = [];
    const pairs: number[] = [];
    for (const edge of graph.edges) {
      if (!visibleNodeIds.has(edge.source_id) || !visibleNodeIds.has(edge.target_id)) {
        continue;
      }

      const touchesFocus =
        focusId !== null && (edge.source_id === focusId || edge.target_id === focusId);

      if (!showConnections && !touchesFocus) {
        continue;
      }

      if (isProjectIslands && !showConnections) {
        const srcProj = nodeProjectMap.get(edge.source_id) ?? null;
        const dstProj = nodeProjectMap.get(edge.target_id) ?? null;
        if (srcProj !== dstProj && !touchesFocus) {
          continue;
        }
      }

      const srcIdx = nodeIndexMap.get(edge.source_id);
      const dstIdx = nodeIndexMap.get(edge.target_id);
      if (srcIdx === undefined || dstIdx === undefined) continue;

      if (useLivePositions) {
        const s3 = srcIdx * 3;
        const d3 = dstIdx * 3;
        coords.push(
          buffers.positions[s3] ?? 0,
          buffers.positions[s3 + 1] ?? 0,
          buffers.positions[s3 + 2] ?? 0,
          buffers.positions[d3] ?? 0,
          buffers.positions[d3 + 1] ?? 0,
          buffers.positions[d3 + 2] ?? 0,
        );
      } else {
        const from = layoutResult.nodePositions[edge.source_id];
        const to = layoutResult.nodePositions[edge.target_id];
        if (!from || !to) continue;
        coords.push(from[0], from[1], from[2], to[0], to[1], to[2]);
      }
      pairs.push(srcIdx, dstIdx);
    }

    if (coords.length === 0) return null;
    const posArray = new Float32Array(coords);
    const posAttr = new THREE.BufferAttribute(posArray, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", posAttr);
    if (edgeShaderConfig.isCustom) {
      attachUniformEdgeColorAttribute(geometry, manifest.palette.edge);
    }
    return {
      geometry,
      posArray,
      posAttr,
      pairs: new Int32Array(pairs),
    };
  }, [
    buffers.positions,
    edgeShaderConfig.isCustom,
    graph.edges,
    hoveredNodeId,
    isProjectIslands,
    layoutResult.nodePositions,
    manifest.palette.edge,
    nodeIndexMap,
    nodeProjectMap,
    selectedNodeId,
    showConnections,
    visibleNodeIds,
  ]);

  const semanticEdgeGeometry = semanticEdgeBundle?.geometry ?? null;
  const semanticEdgeBaseOpacity = showConnections ? 0.45 : 0.72;

  const semanticEdgeMaterial = useMemo<THREE.Material>(() => {
    if (edgeShaderConfig.isCustom) {
      return createEdgeShaderMaterial(semanticEdgeBaseOpacity, {
        vertex: edgeShaderConfig.vertex,
        fragment: edgeShaderConfig.fragment,
      });
    }
    return new THREE.LineBasicMaterial({
      color: manifest.palette.edge,
      transparent: true,
      opacity: semanticEdgeBaseOpacity,
    });
  }, [
    edgeShaderConfig.fragment,
    edgeShaderConfig.isCustom,
    edgeShaderConfig.vertex,
    manifest.palette.edge,
    semanticEdgeBaseOpacity,
  ]);

  useEffect(() => {
    appliedSemanticFadeRef.current = -1;
  }, [semanticEdgeMaterial]);

  useEffect(() => {
    return () => {
      semanticEdgeGeometry?.dispose();
    };
  }, [semanticEdgeGeometry]);

  useEffect(() => {
    return () => {
      semanticEdgeMaterial.dispose();
    };
  }, [semanticEdgeMaterial]);

  // Structural layout edges (knowledge_tree branches, neural_net rails)
  const structuralEdgeGeometry = useMemo(() => {
    const pairs = layoutResult.structuralEdges;
    if (!pairs || pairs.length === 0) return null;

    const anchorPos = new Map<string, [number, number, number]>();
    for (const anchor of layoutResult.virtualAnchors ?? []) {
      anchorPos.set(anchor.id, anchor.position);
    }

    const coords: number[] = [];
    for (const [src, dst] of pairs) {
      const from = anchorPos.get(src) ?? layoutResult.nodePositions[src];
      const to = anchorPos.get(dst) ?? layoutResult.nodePositions[dst];
      if (!from || !to) continue;
      coords.push(from[0], from[1], from[2], to[0], to[1], to[2]);
    }

    if (coords.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(coords, 3));
    if (edgeShaderConfig.isCustom) {
      attachUniformEdgeColorAttribute(geometry, "#2b3a55");
    }
    return geometry;
  }, [edgeShaderConfig.isCustom, layoutResult]);

  const structuralEdgeMaterial = useMemo<THREE.Material>(() => {
    if (edgeShaderConfig.isCustom) {
      return createEdgeShaderMaterial(0.36, {
        vertex: edgeShaderConfig.vertex,
        fragment: edgeShaderConfig.fragment,
      });
    }
    return new THREE.LineBasicMaterial({
      color: "#2b3a55",
      transparent: true,
      opacity: 0.36,
    });
  }, [edgeShaderConfig.fragment, edgeShaderConfig.isCustom, edgeShaderConfig.vertex]);

  useEffect(() => {
    return () => {
      structuralEdgeGeometry?.dispose();
    };
  }, [structuralEdgeGeometry]);

  useEffect(() => {
    return () => {
      structuralEdgeMaterial.dispose();
    };
  }, [structuralEdgeMaterial]);

  // Faint backdrop material for `custom_mesh` layout (`palette.edge` at 15% opacity)
  const customMeshBackdropMaterial = useMemo(() => {
    if (!activeCustomMeshData) return null;
    return new THREE.MeshBasicMaterial({
      color: manifest.palette.edge,
      transparent: true,
      opacity: 0.15,
      wireframe: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }, [activeCustomMeshData, manifest.palette.edge]);

  useEffect(() => {
    return () => {
      customMeshBackdropMaterial?.dispose();
    };
  }, [customMeshBackdropMaterial]);

  // Flat island slabs, rims, and big floating project labels (`project_islands` layout)
  const islandSlabsGeometry = useMemo(
    () =>
      isProjectIslands
        ? buildIslandSlabsGeometry(layoutResult.projectContainers ?? [])
        : null,
    [isProjectIslands, layoutResult.projectContainers],
  );

  const islandSlabsMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  useEffect(() => {
    return () => {
      islandSlabsGeometry?.dispose();
    };
  }, [islandSlabsGeometry]);

  useEffect(() => {
    return () => {
      islandSlabsMaterial.dispose();
    };
  }, [islandSlabsMaterial]);

  const islandRimsGeometry = useMemo(
    () =>
      isProjectIslands
        ? buildIslandRimsGeometry(layoutResult.projectContainers ?? [])
        : null,
    [isProjectIslands, layoutResult.projectContainers],
  );

  const islandRimsMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.86,
      }),
    [],
  );

  useEffect(() => {
    return () => {
      islandRimsGeometry?.dispose();
    };
  }, [islandRimsGeometry]);

  useEffect(() => {
    return () => {
      islandRimsMaterial.dispose();
    };
  }, [islandRimsMaterial]);

  const islandLabels = useMemo(() => {
    if (!isProjectIslands) return [];
    const containers = layoutResult.projectContainers ?? [];
    return containers.map((container) => {
      const displayName =
        container.projectId === null ? t("brain.globalScope") : container.label;
      const countText = t("brain.nodesCount", { count: container.vectorCount });
      return createIslandLabelSprite(container, displayName, countText);
    });
  }, [i18n.resolvedLanguage, isProjectIslands, layoutResult.projectContainers, t]);

  useEffect(() => {
    appliedChromeOpacityRef.current = -1;
    return () => {
      for (const lbl of islandLabels) {
        lbl.material.dispose();
        lbl.texture.dispose();
      }
    };
  }, [islandLabels]);

  useEffect(() => {
    const t = transitionRef.current;
    const initialChromeOpacity =
      t.mode === "sand" && t.maxEndTimeSec > 0
        ? smoothstep(0.38, 0.9, Math.min(1, t.elapsedSec / t.maxEndTimeSec))
        : t.mode === "fade"
          ? t.fadeOpacity
          : 1.0;
    setMaterialOpacity(structuralEdgeMaterial, STRUCTURAL_EDGE_BASE_OPACITY * initialChromeOpacity);
    if (customMeshBackdropMaterial) {
      customMeshBackdropMaterial.opacity =
        CUSTOM_MESH_BACKDROP_BASE_OPACITY * initialChromeOpacity;
    }
    islandSlabsMaterial.opacity = ISLAND_SLABS_BASE_OPACITY * initialChromeOpacity;
    islandRimsMaterial.opacity = ISLAND_RIMS_BASE_OPACITY * initialChromeOpacity;
    for (const lbl of islandLabels) {
      lbl.material.opacity = initialChromeOpacity;
    }
    appliedChromeOpacityRef.current = initialChromeOpacity;
  }, [
    customMeshBackdropMaterial,
    islandLabels,
    islandRimsMaterial,
    islandSlabsMaterial,
    layoutResult,
    structuralEdgeMaterial,
  ]);

  // ---------------------------------------------------------------------------
  // 6. Frame-time watchdog (avg > 100 ms sustained for 3 s while custom shaders active)
  // ---------------------------------------------------------------------------
  const hasActiveCustomShaders =
    shadersAllowed &&
    ((!useVolumetricMesh && nodeShaderBundle.isCustom) ||
      (edgeShaderConfig.isCustom &&
        (Boolean(semanticEdgeGeometry) || Boolean(structuralEdgeGeometry))) ||
      Boolean(backgroundBundle.material));

  const watchdogRef = useRef<{
    lastTs: number | null;
    samples: Array<{ ts: number; dtMs: number }>;
    slowSince: number | null;
    tripped: boolean;
  }>({
    lastTs: null,
    samples: [],
    slowSince: null,
    tripped: false,
  });

  useEffect(() => {
    watchdogRef.current.lastTs = null;
    watchdogRef.current.samples = [];
    watchdogRef.current.slowSince = null;
    watchdogRef.current.tripped = shadersDisabledForSession;
  }, [hasActiveCustomShaders, manifest.id, shadersDisabledForSession]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibility = () => {
      watchdogRef.current.lastTs = null;
      watchdogRef.current.samples = [];
      watchdogRef.current.slowSince = null;
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  // Reusable scratch objects for zero-allocation pulse, frustum, & off-screen frame updates
  const pulseColorScratchRef = useRef(new THREE.Color());
  const scratchWorldPosRef = useRef(new THREE.Vector3());
  const scratchViewPosRef = useRef(new THREE.Vector3());
  const scratchProjPosRef = useRef(new THREE.Vector3());
  const frustumRef = useRef(new THREE.Frustum());
  const projScreenMatrixRef = useRef(new THREE.Matrix4());
  const onPulseVisibilityRef = useRef(onPulseVisibilityChange);
  onPulseVisibilityRef.current = onPulseVisibilityChange;
  const onNodesInViewRef = useRef(onNodesInViewChange);
  onNodesInViewRef.current = onNodesInViewChange;
  const lastVisibilityReportTsRef = useRef(0);
  const lastVisibilitySigRef = useRef("");
  const lastFrustumCheckTsRef = useRef(0);
  const lastNodesInViewRef = useRef<boolean | null>(null);

  useEffect(() => {
    return () => {
      onPulseVisibilityRef.current?.(null);
      onNodesInViewRef.current?.(true);
    };
  }, []);

  // Per-frame loop: watchdog, shader uniforms, layout lerp, camera focus, and synaptic pulses
  useFrame((rootState, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const now = performance.now();
    const timeSec = now * 0.001;
    const dpr = gl.getPixelRatio();
    const liveSize = rootState.size;

    // 0. Frame-time watchdog while custom shaders are active
    const watchdog = watchdogRef.current;
    if (
      hasActiveCustomShaders &&
      !watchdog.tripped &&
      (typeof document === "undefined" || !document.hidden)
    ) {
      if (watchdog.lastTs !== null) {
        const dtMs = now - watchdog.lastTs;
        if (dtMs > 0 && dtMs < 5_000) {
          watchdog.samples.push({ ts: now, dtMs });
          const cutoff = now - WATCHDOG_WINDOW_MS;
          while (watchdog.samples.length > 0 && (watchdog.samples[0]?.ts ?? 0) < cutoff) {
            watchdog.samples.shift();
          }
          let sum = 0;
          for (const sample of watchdog.samples) {
            sum += sample.dtMs;
          }
          const avgMs = watchdog.samples.length > 0 ? sum / watchdog.samples.length : 0;
          if (avgMs > WATCHDOG_FRAME_MS_THRESHOLD) {
            if (watchdog.slowSince === null) {
              watchdog.slowSince = now;
            } else if (now - watchdog.slowSince >= WATCHDOG_SUSTAINED_MS) {
              watchdog.tripped = true;
              useThemeStore.getState().tripShaderWatchdog(manifest.id, Math.round(avgMs));
            }
          } else {
            watchdog.slowSince = null;
          }
        } else if (dtMs >= 5_000) {
          watchdog.samples = [];
          watchdog.slowSince = null;
        }
      }
      watchdog.lastTs = now;
    }

    // Sync point shader uniforms
    const uniforms = pointMaterial.uniforms;
    const pixelRatioUniform = uniforms.uPixelRatio;
    const scaleFactorUniform = uniforms.uScaleFactor;
    const timeUniform = uniforms.uTime;
    if (pixelRatioUniform) pixelRatioUniform.value = dpr;
    if (scaleFactorUniform) {
      const fovRad =
        camera instanceof THREE.PerspectiveCamera
          ? THREE.MathUtils.degToRad(camera.fov)
          : THREE.MathUtils.degToRad(55);
      scaleFactorUniform.value = liveSize.height / (2 * Math.tan(fovRad * 0.5));
    }
    if (timeUniform) timeUniform.value = timeSec;

    // Sync custom edge shader uTime uniforms
    if (semanticEdgeMaterial instanceof THREE.ShaderMaterial && semanticEdgeMaterial.uniforms.uTime) {
      semanticEdgeMaterial.uniforms.uTime.value = timeSec;
    }
    if (
      structuralEdgeMaterial instanceof THREE.ShaderMaterial &&
      structuralEdgeMaterial.uniforms.uTime
    ) {
      structuralEdgeMaterial.uniforms.uTime.value = timeSec;
    }

    // Sync full-screen background quad uniforms
    const bgMat = backgroundBundle.material;
    if (bgMat) {
      if (bgMat.uniforms.uTime) bgMat.uniforms.uTime.value = timeSec;
      const resUniform = bgMat.uniforms.uResolution;
      if (resUniform && resUniform.value instanceof THREE.Vector2) {
        resUniform.value.set(Math.max(1, liveSize.width * dpr), Math.max(1, liveSize.height * dpr));
      }
    }

    // 1. Organic "sand" layout transition OR reduced-motion plain fade (GPU buffers only)
    const transition = transitionRef.current;
    let targetChromeOpacity = 1.0;

    if (transition.mode === "sand") {
      transition.elapsedSec += delta;
      const count = graph.nodes.length;
      const {
        positions,
        prevPositions,
        targetPositions,
        arcOffsets,
        nodeDelays,
        nodeDurations,
        posAttr,
      } = buffers;

      const finished = stepSandTransition(
        count,
        transition.elapsedSec,
        positions,
        prevPositions,
        targetPositions,
        arcOffsets,
        nodeDelays,
        nodeDurations,
      );
      posAttr.needsUpdate = true;

      if (instancedMesh) {
        for (let i = 0; i < count; i += 1) {
          writeVolumetricInstance(instancedMesh, i, false);
        }
        instancedMesh.instanceMatrix.needsUpdate = true;
      }

      syncSemanticEdgesFromPositions(semanticEdgeBundle, positions);

      const overallProgress =
        transition.maxEndTimeSec > 0
          ? Math.min(1, transition.elapsedSec / transition.maxEndTimeSec)
          : 1;
      targetChromeOpacity = finished ? 1.0 : smoothstep(0.38, 0.9, overallProgress);

      if (finished) {
        transition.mode = "none";
        spatialDirtyRef.current = true;
        lastFrustumCheckTsRef.current = 0;
      }
    } else if (transition.mode === "fade") {
      transition.elapsedSec += delta;
      const halfSec = transition.fadeHalfSec;

      if (!transition.fadeSwapped && transition.elapsedSec >= halfSec) {
        const count = graph.nodes.length;
        const len3 = count * 3;
        const { positions, targetPositions, posAttr } = buffers;
        for (let i = 0; i < len3; i += 1) {
          positions[i] = targetPositions[i] ?? 0;
        }
        posAttr.needsUpdate = true;

        if (instancedMesh) {
          for (let i = 0; i < count; i += 1) {
            writeVolumetricInstance(instancedMesh, i, false);
          }
          instancedMesh.instanceMatrix.needsUpdate = true;
        }

        syncSemanticEdgesFromPositions(semanticEdgeBundle, positions);
        transition.fadeSwapped = true;
        spatialDirtyRef.current = true;
        lastFrustumCheckTsRef.current = 0;
      }

      if (transition.elapsedSec < halfSec) {
        transition.fadeOpacity = Math.max(0, 1 - transition.elapsedSec / halfSec);
      } else if (transition.elapsedSec < halfSec * 2) {
        transition.fadeOpacity = Math.min(1, (transition.elapsedSec - halfSec) / halfSec);
      } else {
        transition.fadeOpacity = 1;
        transition.mode = "none";
        lastFrustumCheckTsRef.current = 0;
      }
      targetChromeOpacity = transition.fadeOpacity;
    }

    // Apply layout chrome opacity (structural edges, custom mesh backdrop, islands)
    if (Math.abs(targetChromeOpacity - appliedChromeOpacityRef.current) > 0.002) {
      setMaterialOpacity(
        structuralEdgeMaterial,
        STRUCTURAL_EDGE_BASE_OPACITY * targetChromeOpacity,
      );
      if (customMeshBackdropMaterial) {
        customMeshBackdropMaterial.opacity =
          CUSTOM_MESH_BACKDROP_BASE_OPACITY * targetChromeOpacity;
      }
      islandSlabsMaterial.opacity = ISLAND_SLABS_BASE_OPACITY * targetChromeOpacity;
      islandRimsMaterial.opacity = ISLAND_RIMS_BASE_OPACITY * targetChromeOpacity;
      for (const lbl of islandLabels) {
        lbl.material.opacity = targetChromeOpacity;
      }
      appliedChromeOpacityRef.current = targetChromeOpacity;
    }

    // Apply reduced-motion fade to semantic edges
    const semanticFade = transition.fadeOpacity;
    if (Math.abs(semanticFade - appliedSemanticFadeRef.current) > 0.002) {
      setMaterialOpacity(semanticEdgeMaterial, semanticEdgeBaseOpacity * semanticFade);
      appliedSemanticFadeRef.current = semanticFade;
    }

    // 1b. Smooth camera transition (node focus, reset camera, center view, theme change)
    const camAnim = cameraAnimRef.current;
    if (camAnim) {
      camAnim.progress = Math.min(1, camAnim.progress + delta / camAnim.durationSec);
      const p = camAnim.progress;
      const tEase =
        camAnim.easeMode === "inOut"
          ? p < 0.5
            ? 4 * p * p * p
            : 1 - Math.pow(-2 * p + 2, 3) / 2
          : 1 - Math.pow(1 - p, 3);
      camera.position.lerpVectors(camAnim.startPos, camAnim.endPos, tEase);
      if (camera instanceof THREE.PerspectiveCamera) {
        let projDirty = false;
        if (Math.abs(camAnim.endFov - camAnim.startFov) > 0.01) {
          camera.fov = camAnim.startFov + (camAnim.endFov - camAnim.startFov) * tEase;
          projDirty = true;
        }
        if (Math.abs(camAnim.endZoom - camAnim.startZoom) > 0.001) {
          camera.zoom = camAnim.startZoom + (camAnim.endZoom - camAnim.startZoom) * tEase;
          projDirty = true;
        }
        if (projDirty) {
          camera.updateProjectionMatrix();
        }
      }
      if (controlsRef.current) {
        controlsRef.current.target.lerpVectors(camAnim.startTarget, camAnim.endTarget, tEase);
        controlsRef.current.update();
      }
      if (camAnim.progress >= 1) {
        cameraAnimRef.current = null;
        lastFrustumCheckTsRef.current = 0;
      }
    }

    // 1c. Detect whether any visible node is inside the camera view frustum (for "Center view" hint)
    const nodesInViewCb = onNodesInViewRef.current;
    if (
      nodesInViewCb &&
      transition.initialized &&
      now - lastFrustumCheckTsRef.current >= FRUSTUM_CHECK_INTERVAL_MS
    ) {
      lastFrustumCheckTsRef.current = now;
      const count = graph.nodes.length;
      const { positions: livePos, sizes: liveSizes } = buffers;
      let visibleTotal = 0;
      let anyInView = false;

      if (count > 0 && cameraAnimRef.current === null) {
        camera.updateMatrixWorld();
        const projScreen = projScreenMatrixRef.current;
        projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const frustum = frustumRef.current;
        frustum.setFromProjectionMatrix(projScreen);
        const worldPos = scratchWorldPosRef.current;

        for (let i = 0; i < count; i += 1) {
          if ((liveSizes[i] ?? 0) <= 0.0001) continue;
          visibleTotal += 1;
          const i3 = i * 3;
          worldPos.set(livePos[i3] ?? 0, livePos[i3 + 1] ?? 0, livePos[i3 + 2] ?? 0);
          if (frustum.containsPoint(worldPos)) {
            anyInView = true;
            break;
          }
        }
      }

      const nextInView = visibleTotal === 0 || anyInView;
      if (lastNodesInViewRef.current !== nextInView) {
        lastNodesInViewRef.current = nextInView;
        nodesInViewCb(nextInView);
      }
    }

    // 2. Synaptic live pulses (AI: 6 s ease-out strong pulse + dimming; internal: faint 1 s disc flicker only)
    const pulses = useSynapticStore.getState().pulses;
    const activeAiSet = activePulsedIndicesRef.current;
    const activeVisualSet = activeVisualPulseIndicesRef.current;
    const { pulse, pulseAttr, meta, metaAttr, baseOpacities, positions, sizes } = buffers;
    let pulseDirty = false;
    let aiMembershipChanged = false;
    let maxAiPulseIntensity = 0;
    let primaryAiPulseColor = "#60A5FA";
    let activeAiPulseCount = 0;
    const touchedVolumetric: number[] = [];

    if (pulses.size > 0 || activeVisualSet.size > 0 || activeAiSet.size > 0) {
      const scratch = pulseColorScratchRef.current;
      const nextActiveAi = new Set<number>();
      const nextActiveVisual = new Set<number>();

      for (const [memoryId, entry] of pulses.entries()) {
        const elapsed = Math.max(0, now - entry.startedAt);
        if (elapsed >= entry.durationMs) {
          pulses.delete(memoryId);
          continue;
        }
        const progress = Math.min(1, elapsed / entry.durationMs);
        // Smooth ease-out fade: holds bright early, eases gently to 0 at durationMs
        const easeOutFade = Math.pow(1 - progress * progress, 1.5);
        const currentIntensity = entry.intensity * easeOutFade;
        const isAi = entry.kind === "ai";

        if (isAi) {
          activeAiPulseCount += 1;
          if (currentIntensity > maxAiPulseIntensity) {
            maxAiPulseIntensity = currentIntensity;
            primaryAiPulseColor = entry.colorHex;
          }
        }

        const idx = nodeIndexMap.get(memoryId);
        if (idx === undefined) continue;

        scratch.set(entry.colorHex);
        const i4 = idx * 4;
        pulse[i4] = scratch.r;
        pulse[i4 + 1] = scratch.g;
        pulse[i4 + 2] = scratch.b;
        // Positive aPulse.a = strong AI pulse with halo; negative aPulse.a = faint disc flicker only
        pulse[i4 + 3] = isAi ? currentIntensity : -currentIntensity;

        nextActiveVisual.add(idx);
        if (isAi) {
          nextActiveAi.add(idx);
          if (!activeAiSet.has(idx)) aiMembershipChanged = true;
        }
        if (instancedMesh) touchedVolumetric.push(idx);
        pulseDirty = true;
      }

      // Clear any previously pulsed or flickered indices that have now expired or been suppressed
      for (const prevIdx of activeVisualSet) {
        if (!nextActiveVisual.has(prevIdx)) {
          pulse[prevIdx * 4 + 3] = 0;
          if (instancedMesh) touchedVolumetric.push(prevIdx);
          pulseDirty = true;
        }
      }

      for (const prevAiIdx of activeAiSet) {
        if (!nextActiveAi.has(prevAiIdx)) {
          aiMembershipChanged = true;
        }
      }

      activePulsedIndicesRef.current = nextActiveAi;
      activeVisualPulseIndicesRef.current = nextActiveVisual;
      if (pulseDirty) {
        pulseAttr.needsUpdate = true;
        if (instancedMesh && touchedVolumetric.length > 0) {
          for (const idx of touchedVolumetric) {
            writeVolumetricInstance(instancedMesh, idx, true);
          }
          instancedMesh.instanceMatrix.needsUpdate = true;
          if (instancedMesh.instanceColor) {
            instancedMesh.instanceColor.needsUpdate = true;
          }
        }
      }
    }

    // 2b. Smoothly dim non-AI nodes to ~30% opacity ONLY while an AI pulse is active (internal flickers never dim)
    const dimStrength =
      maxAiPulseIntensity > 0.02 ? Math.min(1, maxAiPulseIntensity / 0.24) : 0;
    const targetDim = 1.0 - (1.0 - PULSE_DIM_OPACITY) * dimStrength;
    const dimSpeed = targetDim < dimFactorRef.current ? 9.0 : 3.8;
    const nextDim =
      Math.abs(targetDim - dimFactorRef.current) < 0.0015
        ? targetDim
        : dimFactorRef.current + (targetDim - dimFactorRef.current) * (1 - Math.exp(-delta * dimSpeed));
    dimFactorRef.current = nextDim;

    const dimDelta = Math.abs(nextDim - appliedDimFactorRef.current);
    const fadeOpacity = transition.fadeOpacity;
    const fadeDelta = Math.abs(fadeOpacity - appliedFadeOpacityRef.current);
    if (
      dimDelta > 0.002 ||
      fadeDelta > 0.002 ||
      (aiMembershipChanged && (nextDim < 0.998 || appliedDimFactorRef.current < 0.998))
    ) {
      const count = graph.nodes.length;
      const currentActive = activePulsedIndicesRef.current;
      for (let i = 0; i < count; i += 1) {
        const i4 = i * 4;
        const baseOp = baseOpacities[i] ?? 1.0;
        const focus = meta[i4 + 2] ?? 0;
        let op: number;
        if (currentActive.has(i)) {
          op = 1.0;
        } else if (focus === 1 || focus === 2) {
          op = Math.max(baseOp * nextDim, 0.85);
        } else {
          op = baseOp * nextDim;
        }
        meta[i4 + 3] = op * fadeOpacity;
      }
      metaAttr.needsUpdate = true;
      appliedDimFactorRef.current = nextDim;
      appliedFadeOpacityRef.current = fadeOpacity;

      if (instancedMesh) {
        for (let i = 0; i < count; i += 1) {
          writeVolumetricInstance(instancedMesh, i, true);
        }
        if (instancedMesh.instanceColor) {
          instancedMesh.instanceColor.needsUpdate = true;
        }
      }
    }

    // 2c. Detect off-screen / filtered-out AI-pulsed nodes ONLY (internal flickers are never counted)
    const visibilityCb = onPulseVisibilityRef.current;
    if (visibilityCb) {
      if (activeAiPulseCount === 0) {
        if (lastVisibilitySigRef.current !== "") {
          lastVisibilitySigRef.current = "";
          visibilityCb(null);
        }
      } else if (
        aiMembershipChanged ||
        now - lastVisibilityReportTsRef.current >= PULSE_VISIBILITY_REPORT_MS
      ) {
        lastVisibilityReportTsRef.current = now;
        let onScreenCount = 0;
        let offScreenCount = 0;
        let filteredOutCount = 0;
        let missingFromGraphCount = 0;
        const offScreenIds: Uuid[] = [];
        const filteredOutIds: Uuid[] = [];
        let sumDx = 0;
        let sumDy = 0;

        const worldPos = scratchWorldPosRef.current;
        const viewPos = scratchViewPosRef.current;
        const projPos = scratchProjPosRef.current;

        for (const [memoryId, entry] of pulses.entries()) {
          if (entry.kind !== "ai") continue;

          const idx = nodeIndexMap.get(memoryId);
          if (idx === undefined) {
            missingFromGraphCount += 1;
            continue;
          }
          if ((sizes[idx] ?? 0) <= 0.0001) {
            filteredOutCount += 1;
            filteredOutIds.push(memoryId);
            continue;
          }

          const i3 = idx * 3;
          worldPos.set(positions[i3] ?? 0, positions[i3 + 1] ?? 0, positions[i3 + 2] ?? 0);
          viewPos.copy(worldPos).applyMatrix4(camera.matrixWorldInverse);
          const isBehindCamera = viewPos.z >= 0;
          projPos.copy(worldPos).project(camera);

          const isVisibleInView =
            !isBehindCamera &&
            Math.abs(projPos.x) <= 0.98 &&
            Math.abs(projPos.y) <= 0.98 &&
            projPos.z >= -1 &&
            projPos.z <= 1;

          if (isVisibleInView) {
            onScreenCount += 1;
          } else {
            offScreenCount += 1;
            offScreenIds.push(memoryId);
            let dx = isBehindCamera ? -projPos.x : projPos.x;
            let dy = isBehindCamera ? -projPos.y : projPos.y;
            const len = Math.hypot(dx, dy);
            if (len < 0.001) {
              dx = 0;
              dy = -1;
            } else {
              dx /= len;
              dy /= len;
            }
            sumDx += dx;
            sumDy += dy;
          }
        }

        let edge: ViewportEdge | null = null;
        let edgeOffset = 0.5;
        if (offScreenCount > 0) {
          if (Math.abs(sumDx) >= Math.abs(sumDy)) {
            edge = sumDx >= 0 ? "right" : "left";
            const slopeY = Math.abs(sumDx) > 0.001 ? sumDy / Math.abs(sumDx) : 0;
            const clampedNdcY = Math.max(-1, Math.min(1, slopeY));
            edgeOffset = Math.max(0.2, Math.min(0.78, 0.5 - clampedNdcY * 0.42));
          } else {
            edge = sumDy >= 0 ? "top" : "bottom";
            const slopeX = Math.abs(sumDy) > 0.001 ? sumDx / Math.abs(sumDy) : 0;
            const clampedNdcX = Math.max(-1, Math.min(1, slopeX));
            edgeOffset = Math.max(0.22, Math.min(0.78, 0.5 + clampedNdcX * 0.42));
          }
        }

        const totalHidden = offScreenCount + filteredOutCount + missingFromGraphCount;
        const sig =
          totalHidden === 0
            ? "all-visible"
            : `${onScreenCount}:${offScreenCount}:${filteredOutCount}:${missingFromGraphCount}:${edge ?? "none"}:${Math.round(edgeOffset * 20)}:${primaryAiPulseColor}`;

        if (sig !== lastVisibilitySigRef.current) {
          lastVisibilitySigRef.current = sig;
          if (totalHidden === 0) {
            visibilityCb(null);
          } else {
            visibilityCb({
              totalActive: activeAiPulseCount,
              onScreenCount,
              offScreenCount,
              filteredOutCount,
              missingFromGraphCount,
              edge,
              edgeOffset,
              colorHex: primaryAiPulseColor,
              offScreenIds,
              filteredOutIds,
            });
          }
        }
      }
    }
  });

  return (
    <>
      <FrameRateController maxFps={maxFps} />
      <CanvasResizeSync manualFrameloop={maxFps !== null} />
      <color attach="background" args={[manifest.palette.background]} />

      {/* Full-screen custom theme background quad (THEME_SPEC §6.2) */}
      {backgroundBundle.material && (
        <mesh
          geometry={backgroundQuadGeometry}
          material={backgroundBundle.material}
          frustumCulled={false}
          renderOrder={-1000}
        />
      )}

      {/* Faint wireframe backdrop for `custom_mesh` layout (`palette.edge` at 15% opacity) */}
      {activeCustomMeshData && customMeshBackdropMaterial && (
        <mesh
          geometry={activeCustomMeshData.backdropGeometry}
          material={customMeshBackdropMaterial}
          frustumCulled={false}
        />
      )}

      {islandSlabsGeometry && (
        <mesh geometry={islandSlabsGeometry} material={islandSlabsMaterial} />
      )}

      {islandRimsGeometry && (
        <lineSegments geometry={islandRimsGeometry} material={islandRimsMaterial} />
      )}

      {/* Nodes: unlit volumetric InstancedMesh (balanced/ultra, ≤ 5k visible) or point-sprites */}
      {instancedMesh ? (
        <primitive object={instancedMesh} />
      ) : (
        <points geometry={buffers.geometry} material={pointMaterial} frustumCulled={false} />
      )}

      {structuralEdgeGeometry && (
        <lineSegments geometry={structuralEdgeGeometry} material={structuralEdgeMaterial} />
      )}

      {semanticEdgeGeometry && (
        <lineSegments geometry={semanticEdgeGeometry} material={semanticEdgeMaterial} />
      )}

      {islandLabels.map((lbl) => (
        <sprite
          key={lbl.id}
          position={lbl.position}
          scale={lbl.scale}
          material={lbl.material}
        />
      ))}

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={14}
        maxDistance={maxOrbitDistanceRef.current}
      />
    </>
  );
}

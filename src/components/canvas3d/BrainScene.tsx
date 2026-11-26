import { useEffect, useMemo, useRef, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { matchesVisualFilters, useSynapticStore } from "@/stores";
import type {
  ClusterSizeMetric,
  GraphData,
  GraphNode,
  HardwareTier,
  LayoutType,
  ProjectContainer,
  ThemeManifest,
  Uuid,
  VisualFilters,
} from "@/types/contracts";
import {
  buildIslandRimsGeometry,
  buildIslandSlabsGeometry,
  computeIslandsCameraFraming,
  createIslandLabelSprite,
} from "./islandVisuals";
import { resolveLayoutFn } from "./layouts";
import { createNodePointMaterial } from "./pointShader";
import { SpatialHashGrid } from "./spatialIndex";

const LERP_DURATION_SEC = 0.72;
const INITIAL_CAPACITY = 1024;

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

export interface BrainSceneProps {
  graph: GraphData;
  manifest: ThemeManifest;
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
  onHoverNode: (node: GraphNode | null) => void;
  onSelectNode: (node: GraphNode | null) => void;
  onContainersChange?: (containers: readonly ProjectContainer[]) => void;
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
  colors: Float32Array;
  sizes: Float32Array;
  meta: Float32Array;
  pulse: Float32Array;
  posAttr: THREE.BufferAttribute;
  colorAttr: THREE.BufferAttribute;
  sizeAttr: THREE.BufferAttribute;
  metaAttr: THREE.BufferAttribute;
  pulseAttr: THREE.BufferAttribute;
}

function createPointBuffers(capacity: number): PointBuffers {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 3);
  const prevPositions = new Float32Array(capacity * 3);
  const targetPositions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity);
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
    colors,
    sizes,
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

export function BrainScene({
  graph,
  manifest,
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
  onHoverNode,
  onSelectNode,
  onContainersChange,
}: BrainSceneProps) {
  const { t, i18n } = useTranslation();
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);

  const isProjectIslands = activeLayout === "project_islands";
  const maxFps = hardwareTier === "eco" ? 30 : hardwareTier === "balanced" ? 60 : null;

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

  // Compute deterministic target coordinates via pure LayoutFn
  const layoutResult = useMemo(() => {
    const layoutFn = resolveLayoutFn(activeLayout);
    return layoutFn({
      nodes: graph.nodes,
      edges: graph.edges,
      projects: graph.projects,
      params: manifest.layout_params,
      sizeMetric: clusterSizeMetric,
    });
  }, [
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
    buffersRef.current?.geometry.dispose();
    buffersRef.current = createPointBuffers(requiredCapacity);
  }
  const buffers = buffersRef.current;

  useEffect(() => {
    return () => {
      buffersRef.current?.geometry.dispose();
      buffersRef.current = null;
    };
  }, []);

  // Point-sprite custom shader material (THEME_SPEC §6.1) with explicit disposal
  const pointMaterial = useMemo(
    () => createNodePointMaterial(manifest.palette.core_pin),
    [manifest.id, manifest.palette.core_pin],
  );

  useEffect(() => {
    return () => {
      pointMaterial.dispose();
    };
  }, [pointMaterial]);

  // Spatial index for fast picking at 50k+ nodes
  const spatialGridRef = useRef<SpatialHashGrid>(new SpatialHashGrid(14));
  const spatialDirtyRef = useRef(true);

  // Lerp transition state
  const lerpStateRef = useRef<{ progress: number; initialized: boolean }>({
    progress: 1,
    initialized: false,
  });

  // Update target positions whenever layout or node set changes, triggering smooth lerp
  useEffect(() => {
    const count = graph.nodes.length;
    const { positions, prevPositions, targetPositions, geometry, posAttr } = buffers;
    const state = lerpStateRef.current;

    for (let i = 0; i < count; i += 1) {
      const node = graph.nodes[i];
      if (!node) continue;
      const target = layoutResult.nodePositions[node.id] ?? [0, 0, 0];
      const i3 = i * 3;

      if (!state.initialized) {
        positions[i3] = target[0];
        positions[i3 + 1] = target[1];
        positions[i3 + 2] = target[2];
        prevPositions[i3] = target[0];
        prevPositions[i3 + 1] = target[1];
        prevPositions[i3 + 2] = target[2];
      } else {
        prevPositions[i3] = positions[i3] ?? target[0];
        prevPositions[i3 + 1] = positions[i3 + 1] ?? target[1];
        prevPositions[i3 + 2] = positions[i3 + 2] ?? target[2];
      }

      targetPositions[i3] = target[0];
      targetPositions[i3 + 1] = target[1];
      targetPositions[i3 + 2] = target[2];
    }

    geometry.setDrawRange(0, count);
    if (!state.initialized) {
      state.initialized = true;
      state.progress = 1;
      posAttr.needsUpdate = true;
    } else {
      state.progress = 0;
    }
    spatialDirtyRef.current = true;
  }, [buffers, graph.nodes, layoutResult]);

  // Update colors, sizes (filters = size 0), and meta attributes IN PLACE (zero geometry rebuild)
  useEffect(() => {
    const count = graph.nodes.length;
    const { colors, sizes, meta, colorAttr, sizeAttr, metaAttr } = buffers;
    const tmpColor = new THREE.Color();
    const baseSize = Math.max(0.4, manifest.node_geometry.base_size) * 2.4;
    const scaleByHits = manifest.node_geometry.scale_by_hits;

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

      const i4 = i * 4;
      meta[i4] = node.is_core_pin ? 1 : 0;
      meta[i4 + 1] = node.is_reusable ? 1 : 0;
      meta[i4 + 2] = isSelected ? 2 : isHovered ? 1 : isHighlighted ? 3 : 0;
      meta[i4 + 3] = node.status === "active" ? 1.0 : 0.45;
    }

    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    metaAttr.needsUpdate = true;
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

  const sizeRef = useRef(size);
  sizeRef.current = size;

  const islandFraming = useMemo(() => {
    if (!isProjectIslands) return null;
    const containers = layoutResult.projectContainers ?? [];
    const aspect = sizeRef.current.width / Math.max(1, sizeRef.current.height);
    return computeIslandsCameraFraming(containers, manifest.camera.fov, aspect);
  }, [isProjectIslands, layoutResult.projectContainers, manifest.camera.fov]);

  // Apply camera defaults, island overview framing, & explicit reset signal
  useEffect(() => {
    if (isProjectIslands && islandFraming) {
      const [px, py, pz] = islandFraming.position;
      const [tx, ty, tz] = islandFraming.target;
      camera.position.set(px, py, pz);
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.fov = manifest.camera.fov;
        camera.updateProjectionMatrix();
      }
      if (controlsRef.current) {
        controlsRef.current.target.set(tx, ty, tz);
        controlsRef.current.update();
      }
      return;
    }

    const [px, py, pz] = manifest.camera.position;
    const [tx, ty, tz] = manifest.camera.target;
    camera.position.set(px, py, pz);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = manifest.camera.fov;
      camera.updateProjectionMatrix();
    }
    if (controlsRef.current) {
      controlsRef.current.target.set(tx, ty, tz);
      controlsRef.current.update();
    }
  }, [activeLayout, camera, isProjectIslands, islandFraming, manifest.camera, resetSignal]);

  // Keep latest callbacks/nodes in refs for zero-rebind DOM pointer listeners
  const latestNodesRef = useRef(graph.nodes);
  latestNodesRef.current = graph.nodes;
  const onHoverRef = useRef(onHoverNode);
  onHoverRef.current = onHoverNode;
  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;
  const lastHoveredIdxRef = useRef(-1);

  // Spatial-index DOM picking (no O(N) Three.js raycast on 50k points)
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
      // Skip picking while dragging camera orbit
      if (e.buttons !== 0) return;
      const now = performance.now();
      if (now - lastMoveTs < 28) return; // ~35Hz hover picking cap
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
      if (dist > 5) return; // Dragged orbit, not a click

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

  // Reusable scratch Color + set for zero-allocation pulse frame updates
  const pulseColorScratchRef = useRef(new THREE.Color());
  const activePulsedIndicesRef = useRef<Set<number>>(new Set());

  // Per-frame loop: update shader uniforms, layout lerp, and synaptic pulses in place
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const now = performance.now();

    // Sync shader uniforms
    const uniforms = pointMaterial.uniforms;
    const pixelRatioUniform = uniforms.uPixelRatio;
    const scaleFactorUniform = uniforms.uScaleFactor;
    const timeUniform = uniforms.uTime;
    if (pixelRatioUniform) pixelRatioUniform.value = gl.getPixelRatio();
    if (scaleFactorUniform) {
      const fovRad =
        camera instanceof THREE.PerspectiveCamera
          ? THREE.MathUtils.degToRad(camera.fov)
          : THREE.MathUtils.degToRad(55);
      scaleFactorUniform.value = size.height / (2 * Math.tan(fovRad * 0.5));
    }
    if (timeUniform) timeUniform.value = now * 0.001;

    // 1. Layout position lerp
    const lerpState = lerpStateRef.current;
    if (lerpState.progress < 1) {
      lerpState.progress = Math.min(1, lerpState.progress + delta / LERP_DURATION_SEC);
      const t = 1 - Math.pow(1 - lerpState.progress, 3); // cubic ease-out
      const len3 = graph.nodes.length * 3;
      const { positions, prevPositions, targetPositions, posAttr } = buffers;
      for (let i = 0; i < len3; i += 1) {
        const p = prevPositions[i] ?? 0;
        const tgt = targetPositions[i] ?? 0;
        positions[i] = p + (tgt - p) * t;
      }
      posAttr.needsUpdate = true;
      if (lerpState.progress >= 1) {
        spatialDirtyRef.current = true;
      }
    }

    // 2. Synaptic live pulses (O(activePulses) in-place update)
    const pulses = useSynapticStore.getState().pulses;
    const activeSet = activePulsedIndicesRef.current;
    const { pulse, pulseAttr } = buffers;
    let pulseDirty = false;

    if (pulses.size > 0 || activeSet.size > 0) {
      const scratch = pulseColorScratchRef.current;
      const nextActive = new Set<number>();

      for (const [memoryId, entry] of pulses.entries()) {
        const elapsed = now - entry.startedAt;
        if (elapsed >= entry.durationMs) {
          pulses.delete(memoryId);
          continue;
        }
        const idx = nodeIndexMap.get(memoryId);
        if (idx === undefined) continue;

        const norm = 1 - elapsed / entry.durationMs;
        const currentIntensity = entry.intensity * Math.pow(norm, 1.5);
        scratch.set(entry.colorHex);

        const i4 = idx * 4;
        pulse[i4] = scratch.r;
        pulse[i4 + 1] = scratch.g;
        pulse[i4 + 2] = scratch.b;
        pulse[i4 + 3] = currentIntensity;
        nextActive.add(idx);
        pulseDirty = true;
      }

      // Clear any previously pulsed indices that have now expired
      for (const prevIdx of activeSet) {
        if (!nextActive.has(prevIdx)) {
          pulse[prevIdx * 4 + 3] = 0;
          pulseDirty = true;
        }
      }

      activePulsedIndicesRef.current = nextActive;
      if (pulseDirty) {
        pulseAttr.needsUpdate = true;
      }
    }
  });

  const visibleNodeIds = useMemo(() => {
    const visible = new Set<Uuid>();
    for (const node of graph.nodes) {
      if (matchesVisualFilters(node, filters, searchQuery)) {
        visible.add(node.id);
      }
    }
    return visible;
  }, [filters, graph.nodes, searchQuery]);

  // Real memory edges geometry (all real edges when `showConnections` is enabled; hover/selection always preserved)
  const semanticEdgeGeometry = useMemo(() => {
    const focusId = hoveredNodeId ?? selectedNodeId;
    if (!showConnections && !focusId) return null;

    const coords: number[] = [];
    for (const edge of graph.edges) {
      if (!visibleNodeIds.has(edge.source_id) || !visibleNodeIds.has(edge.target_id)) {
        continue;
      }

      const touchesFocus =
        focusId !== null && (edge.source_id === focusId || edge.target_id === focusId);

      if (!showConnections && !touchesFocus) {
        continue;
      }

      // In `project_islands`, cross-island edges stay on hover/selection unless user explicitly toggled all connections on
      if (isProjectIslands && !showConnections) {
        const srcProj = nodeProjectMap.get(edge.source_id) ?? null;
        const dstProj = nodeProjectMap.get(edge.target_id) ?? null;
        if (srcProj !== dstProj && !touchesFocus) {
          continue;
        }
      }

      const from = layoutResult.nodePositions[edge.source_id];
      const to = layoutResult.nodePositions[edge.target_id];
      if (!from || !to) continue;
      coords.push(from[0], from[1], from[2], to[0], to[1], to[2]);
    }

    if (coords.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(coords, 3));
    return geometry;
  }, [
    graph.edges,
    hoveredNodeId,
    isProjectIslands,
    layoutResult.nodePositions,
    nodeProjectMap,
    selectedNodeId,
    showConnections,
    visibleNodeIds,
  ]);

  const semanticEdgeMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: manifest.palette.edge,
        transparent: true,
        opacity: showConnections ? 0.45 : 0.72,
      }),
    [manifest.palette.edge, showConnections],
  );

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
    return geometry;
  }, [layoutResult]);

  const structuralEdgeMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: "#2b3a55",
        transparent: true,
        opacity: 0.36,
      }),
    [],
  );

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
    return () => {
      for (const lbl of islandLabels) {
        lbl.material.dispose();
        lbl.texture.dispose();
      }
    };
  }, [islandLabels]);

  return (
    <>
      <FrameRateController maxFps={maxFps} />
      <color attach="background" args={[manifest.palette.background]} />

      {islandSlabsGeometry && (
        <mesh geometry={islandSlabsGeometry} material={islandSlabsMaterial} />
      )}

      {islandRimsGeometry && (
        <lineSegments geometry={islandRimsGeometry} material={islandRimsMaterial} />
      )}

      {/* Camera-facing point-sprite nodes (single draw call, zero scene lighting) */}
      <points
        geometry={buffers.geometry}
        material={pointMaterial}
        frustumCulled={false}
      />

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
        maxDistance={Math.max(380, islandFraming?.maxDistance ?? 380)}
        autoRotate={manifest.camera.auto_rotate}
        autoRotateSpeed={manifest.camera.auto_rotate_speed}
      />
    </>
  );
}

import { useEffect, useMemo, useRef, type ComponentRef } from "react";
import * as THREE from "three";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { matchesVisualFilters } from "@/stores/filters";
import type {
  GraphData,
  GraphNode,
  HardwareTier,
  ThemeManifest,
  Uuid,
  VisualFilters,
} from "@/types/contracts";
import { createNodeGeometry } from "./geometry";
import { galaxyLayout } from "./layouts/galaxy";

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

    // Trigger an initial frame immediately so first paint is never blank.
    advance(performance.now());
    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [advance, maxFps]);

  return null;
}

interface BrainSceneProps {
  graph: GraphData;
  manifest: ThemeManifest;
  hardwareTier: HardwareTier;
  filters: VisualFilters;
  searchQuery: string;
  hoveredNodeId: Uuid | null;
  selectedNodeId: Uuid | null;
  resetSignal: number;
  onHoverNode: (node: GraphNode | null) => void;
  onSelectNode: (node: GraphNode | null) => void;
}

function resolveNodeColorHex(node: GraphNode, manifest: ThemeManifest): string {
  if (node.is_core_pin) return manifest.palette.core_pin;
  if (node.is_reusable) return manifest.palette.reusable;
  return manifest.palette.category_colors[node.category] ?? manifest.palette.node;
}

export function BrainScene({
  graph,
  manifest,
  hardwareTier,
  filters,
  searchQuery,
  hoveredNodeId,
  selectedNodeId,
  resetSignal,
  onHoverNode,
  onSelectNode,
}: BrainSceneProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);
  const camera = useThree((state) => state.camera);

  const maxFps = hardwareTier === "eco" ? 30 : hardwareTier === "balanced" ? 60 : null;

  // Compute deterministic positions via pure LayoutFn.
  const layoutResult = useMemo(
    () =>
      galaxyLayout({
        nodes: graph.nodes,
        edges: graph.edges,
        projects: graph.projects,
        params: manifest.layout_params,
        sizeMetric: "vectors",
      }),
    [graph.nodes, graph.edges, graph.projects, manifest.layout_params],
  );

  // Node InstancedMesh geometry + material with explicit disposal.
  const nodeGeometry = useMemo(
    () => createNodeGeometry(manifest.node_geometry),
    [manifest.node_geometry],
  );

  const nodeMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        roughness: 0.42,
        metalness: 0.12,
      }),
    [manifest.id],
  );

  useEffect(() => {
    return () => {
      nodeGeometry.dispose();
    };
  }, [nodeGeometry]);

  useEffect(() => {
    return () => {
      nodeMaterial.dispose();
    };
  }, [nodeMaterial]);

  // Apply camera manifest defaults and react to explicit camera reset requests.
  useEffect(() => {
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
  }, [camera, manifest.camera, resetSignal]);

  // Update all instance transforms and colors inside the single InstancedMesh.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const baseSize = manifest.node_geometry.base_size;
    const scaleByHits = manifest.node_geometry.scale_by_hits;

    for (let i = 0; i < graph.nodes.length; i += 1) {
      const node = graph.nodes[i];
      if (!node) continue;

      const pos = layoutResult.nodePositions[node.id] ?? [0, 0, 0];
      const visible = matchesVisualFilters(node, filters, searchQuery);

      if (!visible) {
        dummy.position.set(pos[0], pos[1], pos[2]);
        dummy.scale.setScalar(0);
      } else {
        const hitBoost = scaleByHits ? 1 + Math.min(Math.log1p(node.hit_count) * 0.35, 1.35) : 1;
        const pinBoost = node.is_core_pin ? 1.35 : 1;
        const focusBoost =
          node.id === hoveredNodeId || node.id === selectedNodeId ? 1.45 : 1;
        const radius = baseSize * hitBoost * pinBoost * focusBoost;

        dummy.position.set(pos[0], pos[1], pos[2]);
        dummy.scale.setScalar(radius);
      }

      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      color.set(resolveNodeColorHex(node, manifest));
      if (node.id === hoveredNodeId || node.id === selectedNodeId) {
        color.lerp(new THREE.Color("#ffffff"), 0.35);
      }
      mesh.setColorAt(i, color);
    }

    mesh.count = graph.nodes.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
    mesh.computeBoundingSphere();
  }, [
    graph.nodes,
    layoutResult,
    manifest,
    filters,
    searchQuery,
    hoveredNodeId,
    selectedNodeId,
  ]);

  // Hover-only edge LineSegments with explicit geometry/material disposal.
  const edgeData = useMemo(() => {
    const mode = manifest.layout_params.semantic_edges_mode;
    const effectiveMode = hardwareTier === "eco" && mode === "always" ? "hover_only" : mode;
    if (effectiveMode === "never") return null;

    const focusId = hoveredNodeId ?? selectedNodeId;
    if (effectiveMode === "hover_only" && !focusId) return null;

    const coords: number[] = [];
    for (const edge of graph.edges) {
      if (
        effectiveMode === "hover_only" &&
        edge.source_id !== focusId &&
        edge.target_id !== focusId
      ) {
        continue;
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
    hardwareTier,
    hoveredNodeId,
    selectedNodeId,
    layoutResult,
    manifest.layout_params.semantic_edges_mode,
  ]);

  const edgeMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: manifest.palette.edge,
        transparent: true,
        opacity: 0.65,
      }),
    [manifest.palette.edge],
  );

  useEffect(() => {
    return () => {
      edgeData?.dispose();
    };
  }, [edgeData]);

  useEffect(() => {
    return () => {
      edgeMaterial.dispose();
    };
  }, [edgeMaterial]);

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const id = e.instanceId;
    if (id === undefined) return;
    const node = graph.nodes[id] ?? null;
    onHoverNode(node);
  };

  const handlePointerOut = () => {
    onHoverNode(null);
  };

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const id = e.instanceId;
    if (id === undefined) return;
    const node = graph.nodes[id] ?? null;
    onSelectNode(node);
  };

  const instanceCount = Math.max(1, graph.nodes.length);

  return (
    <>
      <FrameRateController maxFps={maxFps} />
      <color attach="background" args={[manifest.palette.background]} />

      <ambientLight intensity={0.75} />
      <directionalLight position={[80, 120, 90]} intensity={0.85} />
      <directionalLight position={[-90, -60, -80]} intensity={0.35} color="#8fb3ff" />

      <instancedMesh
        ref={meshRef}
        args={[nodeGeometry, nodeMaterial, instanceCount]}
        frustumCulled={false}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
      />

      {edgeData && <lineSegments geometry={edgeData} material={edgeMaterial} />}

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={18}
        maxDistance={320}
        autoRotate={manifest.camera.auto_rotate}
        autoRotateSpeed={manifest.camera.auto_rotate_speed}
      />
    </>
  );
}

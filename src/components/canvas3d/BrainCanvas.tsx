import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Canvas } from "@react-three/fiber";
import { GitBranch, RotateCcw } from "lucide-react";
import {
  useFiltersStore,
  useMemoryStore,
  useSettingsStore,
  useThemeStore,
} from "@/stores";
import { MockBadge } from "@/components/shell/MockBadge";
import type { GraphNode } from "@/types/contracts";
import { BrainScene } from "./BrainScene";
import { NodeTooltip, type TooltipPointer } from "./NodeTooltip";

interface CanvasErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

interface CanvasErrorBoundaryState {
  hasError: boolean;
}

class CanvasErrorBoundary extends Component<
  CanvasErrorBoundaryProps,
  CanvasErrorBoundaryState
> {
  override state: CanvasErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): CanvasErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("WebGL Canvas error:", error, info);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

export function BrainCanvas() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  const graph = useMemoryStore((s) => s.graph);
  const loading = useMemoryStore((s) => s.loading);
  const isMockData = useMemoryStore((s) => s.isMockData);
  const hoveredNodeId = useMemoryStore((s) => s.hoveredNodeId);
  const selectedNodeId = useMemoryStore((s) => s.selectedNodeId);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const setHoveredNodeId = useMemoryStore((s) => s.setHoveredNodeId);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);

  const manifest = useThemeStore((s) => s.manifest);
  const hardwareTier = useSettingsStore((s) => s.settings.hardware_tier);
  const filters = useFiltersStore((s) => s.filters);
  const searchQuery = useFiltersStore((s) => s.searchQuery);

  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [pointer, setPointer] = useState<TooltipPointer>({ x: 0, y: 0 });
  const [resetSignal, setResetSignal] = useState(0);

  useEffect(() => {
    if (!graph && !loading) {
      void loadGraph();
    }
  }, [graph, loading, loadGraph]);

  const projectById = useMemo(() => {
    const map = new Map(graph?.projects.map((p) => [p.project.id, p.project]) ?? []);
    return map;
  }, [graph]);

  const handleHoverNode = useCallback(
    (node: GraphNode | null) => {
      setHoveredNode(node);
      setHoveredNodeId(node ? node.id : null);
    },
    [setHoveredNodeId],
  );

  const handleSelectNode = useCallback(
    (node: GraphNode | null) => {
      setSelectedNodeId(node ? node.id : null);
    },
    [setSelectedNodeId],
  );

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const containerWidth = containerRef.current?.clientWidth ?? 800;
  const containerHeight = containerRef.current?.clientHeight ?? 600;

  const isEco = hardwareTier === "eco";
  const fpsBadgeKey =
    hardwareTier === "eco"
      ? "brain.ecoFpsCap"
      : hardwareTier === "balanced"
        ? "brain.balancedFpsCap"
        : "brain.fpsUncapped";

  const dpr: [number, number] = isEco ? [1, 1] : hardwareTier === "balanced" ? [1, 1.5] : [1, 2];

  const fallbackView = (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
      <h2 className="text-base font-semibold text-slate-200">{t("brain.webglFallbackTitle")}</h2>
      <p className="max-w-sm text-xs text-slate-400">{t("brain.webglFallbackDesc")}</p>
    </div>
  );

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => handleHoverNode(null)}
      className="relative h-full w-full overflow-hidden select-none"
      style={{ backgroundColor: manifest.palette.background }}
    >
      {/* Top-left HUD */}
      <div className="pointer-events-none absolute top-4 left-4 z-10 flex flex-wrap items-center gap-2">
        {graph && (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-void/80 px-3 py-1 text-xs font-medium text-slate-200 backdrop-blur">
              <GitBranch size={12} className="text-cobalt-300" aria-hidden />
              {graph.branch.name}
            </span>
            <span className="rounded-full border border-white/10 bg-void/80 px-3 py-1 font-mono text-xs text-slate-300 backdrop-blur">
              {t("brain.nodesCount", { count: graph.nodes.length })}
            </span>
            <span className="rounded-full border border-white/10 bg-void/80 px-3 py-1 font-mono text-xs text-slate-400 backdrop-blur">
              {t("brain.projectsCount", { count: graph.projects.length })}
            </span>
          </>
        )}

        <span className="rounded-full border border-cobalt-500/30 bg-cobalt-900/70 px-3 py-1 text-xs font-medium text-cobalt-300 backdrop-blur">
          {t(fpsBadgeKey)}
        </span>

        {isMockData && <MockBadge className="pointer-events-auto" />}
      </div>

      {/* Top-right camera reset */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setResetSignal((n) => n + 1)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-void/80 px-3 py-1.5 text-xs font-medium text-slate-200 backdrop-blur transition hover:border-white/25 hover:bg-white/10"
        >
          <RotateCcw size={13} aria-hidden />
          {t("brain.resetCamera")}
        </button>
      </div>

      {/* 3D R3F Canvas (zero postprocessing, explicit Eco FPS cap) */}
      {graph && (
        <CanvasErrorBoundary fallback={fallbackView}>
          <Canvas
            frameloop={hardwareTier === "ultra" ? "always" : "never"}
            shadows={false}
            dpr={dpr}
            camera={{
              position: manifest.camera.position,
              fov: manifest.camera.fov,
              near: 0.1,
              far: 1200,
            }}
            gl={{
              antialias: !isEco,
              powerPreference: isEco ? "low-power" : "high-performance",
            }}
            onPointerMissed={() => handleSelectNode(null)}
          >
            <BrainScene
              graph={graph}
              manifest={manifest}
              hardwareTier={hardwareTier}
              filters={filters}
              searchQuery={searchQuery}
              hoveredNodeId={hoveredNodeId}
              selectedNodeId={selectedNodeId}
              resetSignal={resetSignal}
              onHoverNode={handleHoverNode}
              onSelectNode={handleSelectNode}
            />
          </Canvas>
        </CanvasErrorBoundary>
      )}

      {/* Pointer-tracked hover tooltip */}
      {hoveredNode && (
        <NodeTooltip
          node={hoveredNode}
          project={
            hoveredNode.project_id ? (projectById.get(hoveredNode.project_id) ?? null) : null
          }
          pointer={pointer}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
        />
      )}

      {/* Bottom-left minimal palette legend */}
      <div className="pointer-events-none absolute bottom-4 left-4 z-10 hidden items-center gap-3 rounded-xl border border-white/10 bg-void/75 px-3 py-2 text-[11px] text-slate-300 backdrop-blur sm:flex">
        <span className="font-medium text-slate-400">{manifest.name}</span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: manifest.palette.core_pin }}
          />
          {t("brain.corePin")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: manifest.palette.reusable }}
          />
          {t("brain.reusable")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: manifest.palette.node }}
          />
          {t("categories.decision")}
        </span>
      </div>

      {/* Bottom-right hint */}
      <div className="pointer-events-none absolute right-4 bottom-4 z-10 rounded-lg border border-white/10 bg-void/70 px-3 py-1.5 text-[11px] text-slate-400 backdrop-blur">
        {t("brain.hoverHint")}
      </div>
    </div>
  );
}

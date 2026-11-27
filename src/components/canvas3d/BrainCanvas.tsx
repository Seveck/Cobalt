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
import {
  Clock,
  Radio,
  RotateCcw,
  SearchCode,
  Share2,
  Shield,
  Sparkles,
  Upload,
} from "lucide-react";
import { useFileDrop } from "@/lib/dialogs";
import {
  useFiltersStore,
  useIngestStore,
  useMemoryStore,
  useSettingsStore,
  useThemeStore,
  useUiStore,
} from "@/stores";
import { NodeInspector } from "@/components/inspector/NodeInspector";
import { MockBadge } from "@/components/shell/MockBadge";
import { BranchSwitcher } from "@/components/tools/BranchSwitcher";
import { CleanBrainPanel } from "@/components/tools/CleanBrainPanel";
import { RagDebugger } from "@/components/tools/RagDebugger";
import { TimeTravelBar } from "@/components/tools/TimeTravelBar";
import { BUILTIN_THEME_ID, type GraphNode, type ProjectContainer } from "@/types/contracts";
import { BrainScene } from "./BrainScene";
import { FilterDock } from "./FilterDock";
import { LayoutSwitcher } from "./LayoutSwitcher";
import { NodeTooltip, type TooltipPointer } from "./NodeTooltip";
import { SynapticHud } from "./SynapticHud";
import { ThemeWarningsBanner } from "./ThemeWarningsBanner";

type ActiveDrawer = "none" | "inspector" | "rag" | "clean";

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
  const highlightedNodeIds = useMemoryStore((s) => s.highlightedNodeIds);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const setHoveredNodeId = useMemoryStore((s) => s.setHoveredNodeId);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);

  const manifest = useThemeStore((s) => s.manifest);
  const installedThemes = useThemeStore((s) => s.installedThemes);
  const activeLayout = useThemeStore((s) => s.activeLayout);
  const clusterSizeMetric = useThemeStore((s) => s.clusterSizeMetric);
  const showConnections = useThemeStore((s) => s.showConnections);
  const setActiveLayout = useThemeStore((s) => s.setActiveLayout);
  const setClusterSizeMetric = useThemeStore((s) => s.setClusterSizeMetric);
  const toggleShowConnections = useThemeStore((s) => s.toggleShowConnections);

  const appInfo = useUiStore((s) => s.appInfo);

  const themeBasePath = useMemo(() => {
    if (manifest.id === BUILTIN_THEME_ID) return null;
    const installed = installedThemes.find((item) => item.id === manifest.id);
    if (installed?.local_path && !installed.local_path.startsWith("builtin://")) {
      return installed.local_path;
    }
    if (appInfo?.data_dir && !appInfo.data_dir.includes("(mock)")) {
      const clean = appInfo.data_dir.replace(/[\\/]+$/, "");
      const sep = clean.includes("\\") && !clean.includes("/") ? "\\" : "/";
      return `${clean}${sep}themes${sep}${manifest.id}`;
    }
    return null;
  }, [appInfo?.data_dir, installedThemes, manifest.id]);

  const hardwareTier = useSettingsStore((s) => s.settings.hardware_tier);
  const readOnly = useSettingsStore((s) => s.settings.read_only);
  const savingSettings = useSettingsStore((s) => s.saving);
  const daemonStatus = useSettingsStore((s) => s.daemonStatus);
  const setReadOnly = useSettingsStore((s) => s.setReadOnly);

  const filters = useFiltersStore((s) => s.filters);
  const searchQuery = useFiltersStore((s) => s.searchQuery);
  const startIngestPaths = useIngestStore((s) => s.startIngestPaths);

  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [pointer, setPointer] = useState<TooltipPointer>({ x: 0, y: 0 });
  const [resetSignal, setResetSignal] = useState(0);
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>("none");
  const [timeTravelOpen, setTimeTravelOpen] = useState(false);
  const [projectContainers, setProjectContainers] = useState<readonly ProjectContainer[]>([]);

  const handleDropOnto3D = useCallback(
    (paths: string[]) => {
      if (readOnly || paths.length === 0) return;
      void startIngestPaths({
        paths,
        project_id: null,
        watch: false,
        mark_reusable: false,
        ocr: false,
      });
    },
    [readOnly, startIngestPaths],
  );

  const { isDragging } = useFileDrop(handleDropOnto3D, !readOnly);

  useEffect(() => {
    if (!graph && !loading) {
      void loadGraph();
    }
  }, [graph, loading, loadGraph]);

  // Open Node Inspector automatically when a node is selected
  useEffect(() => {
    if (selectedNodeId) {
      setActiveDrawer("inspector");
    } else if (activeDrawer === "inspector") {
      setActiveDrawer("none");
    }
  }, [selectedNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const projectById = useMemo(() => {
    return new Map(graph?.projects.map((p) => [p.project.id, p.project]) ?? []);
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

  const handleInspectMemoryId = useCallback(
    (id: string) => {
      setSelectedNodeId(id);
      setActiveDrawer("inspector");
    },
    [setSelectedNodeId],
  );

  const handleCloseDrawer = useCallback(() => {
    setActiveDrawer("none");
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  const toggleDrawer = (target: Exclude<ActiveDrawer, "none" | "inspector">) => {
    setActiveDrawer((prev) => (prev === target ? "none" : target));
  };

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
      <h2 className="font-display text-lg font-medium text-bone">{t("brain.webglFallbackTitle")}</h2>
      <p className="max-w-sm text-xs text-bone-muted">{t("brain.webglFallbackDesc")}</p>
    </div>
  );

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Main 3D viewport column */}
      <div
        ref={containerRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => handleHoverNode(null)}
        className="relative flex-1 overflow-hidden select-none"
        style={{ backgroundColor: manifest.palette.background }}
      >
        {/* Drag & drop onto 3D overlay */}
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-void/75 backdrop-blur-xs">
            <div className="flex flex-col items-center gap-2.5 rounded-[2px] border-2 border-dashed border-cobalt bg-cobalt-wash/90 px-8 py-6 text-center">
              <Upload size={26} className="text-cobalt-ink" aria-hidden />
              <div className="font-display text-base font-medium text-bone">
                {t("brain.dropToIngestTitle")}
              </div>
              <p className="text-xs text-bone-muted">{t("brain.dropToIngestHint")}</p>
            </div>
          </div>
        )}
        {/* Top HUD bar: left status + center layout switcher + right tool buttons */}
        <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex flex-wrap items-start justify-between gap-2">
          {/* Top-left: Branch Switcher, counts, FPS badge, Read-Only toggle, Daemon status */}
          <div className="flex flex-wrap items-center gap-1.5">
            <BranchSwitcher />

            {graph && (
              <div className="inline-flex items-center divide-x divide-rule rounded-[2px] border border-rule-strong bg-surface/95 font-mono text-[11px]">
                <span className="px-2.5 py-1 tabular-nums text-bone-muted">
                  {t("brain.nodesCount", { count: graph.nodes.length })}
                </span>
                <span className="px-2.5 py-1 tabular-nums text-bone-subtle">
                  {t("brain.projectsCount", { count: graph.projects.length })}
                </span>
              </div>
            )}

            <span className="rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-2 py-1 font-mono text-[10px] font-medium text-cobalt-ink">
              {t(fpsBadgeKey)}
            </span>

            {/* Interactive Read-Only indicator synced with cobalt://read-only-changed */}
            <button
              type="button"
              disabled={savingSettings}
              onClick={() => void setReadOnly(!readOnly)}
              title={t("brain.toggleReadOnlyHint")}
              className={`pointer-events-auto inline-flex items-center gap-1.5 rounded-[2px] border px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.08em] transition-colors ${
                readOnly
                  ? "border-ochre bg-ochre-wash text-ochre"
                  : "border-rule-strong bg-surface/95 text-bone-subtle hover:border-ochre-rule hover:text-bone"
              }`}
            >
              <Shield size={11} aria-hidden />
              <span>{readOnly ? t("shell.readOnly") : t("brain.writable")}</span>
            </button>

            {daemonStatus && (
              <span
                title={t("brain.daemonTooltip", {
                  clients: daemonStatus.clients.length,
                })}
                className="hidden items-center gap-1.5 rounded-[2px] border border-rule bg-surface/90 px-2 py-1 font-mono text-[10px] text-bone-subtle xl:inline-flex"
              >
                <Radio
                  size={10}
                  className={daemonStatus.running ? "text-verdigris" : "text-bone-subtle"}
                  aria-hidden
                />
                <span>
                  {daemonStatus.running
                    ? t("brain.daemonOnline", { clients: daemonStatus.clients.length })
                    : t("brain.daemonOffline")}
                </span>
              </span>
            )}

            {isMockData && <MockBadge className="pointer-events-auto" />}
          </div>

          {/* Top-right: 5-Layout Switcher + Governance Tools + Camera Reset */}
          <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
            <LayoutSwitcher
              activeLayout={activeLayout}
              clusterSizeMetric={clusterSizeMetric}
              hasCustomMesh={Boolean(manifest.mesh_path)}
              onSelectLayout={setActiveLayout}
              onSelectSizeMetric={setClusterSizeMetric}
            />

            <button
              type="button"
              onClick={toggleShowConnections}
              aria-pressed={showConnections}
              title={t("brain.showConnectionsHint")}
              className={`inline-flex items-center gap-1.5 rounded-[2px] border px-2 py-1 font-mono text-[11px] transition-colors ${
                showConnections
                  ? "border-cobalt-rule bg-cobalt-wash font-semibold text-cobalt-ink"
                  : "border-rule-strong bg-surface/95 text-bone-muted hover:bg-surface-2 hover:text-bone"
              }`}
            >
              <Share2 size={12} aria-hidden />
              <span>{t("brain.showConnections")}</span>
            </button>

            <div className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface/95 p-0.5">
              <button
                type="button"
                onClick={() => toggleDrawer("rag")}
                aria-pressed={activeDrawer === "rag"}
                title={t("rag.title")}
                className={`inline-flex items-center gap-1.5 rounded-[1px] px-2 py-1 font-mono text-[11px] transition-colors ${
                  activeDrawer === "rag"
                    ? "bg-cobalt-wash font-semibold text-cobalt-ink"
                    : "text-bone-muted hover:bg-surface-2 hover:text-bone"
                }`}
              >
                <SearchCode size={12} aria-hidden />
                <span className="hidden 2xl:inline">{t("rag.shortLabel")}</span>
              </button>

              <button
                type="button"
                onClick={() => setTimeTravelOpen((v) => !v)}
                aria-pressed={timeTravelOpen}
                title={t("timeTravel.title")}
                className={`inline-flex items-center gap-1.5 rounded-[1px] px-2 py-1 font-mono text-[11px] transition-colors ${
                  timeTravelOpen
                    ? "bg-cobalt-wash font-semibold text-cobalt-ink"
                    : "text-bone-muted hover:bg-surface-2 hover:text-bone"
                }`}
              >
                <Clock size={12} aria-hidden />
                <span className="hidden 2xl:inline">{t("timeTravel.shortLabel")}</span>
              </button>

              <button
                type="button"
                onClick={() => toggleDrawer("clean")}
                aria-pressed={activeDrawer === "clean"}
                title={t("cleanBrain.title")}
                className={`inline-flex items-center gap-1.5 rounded-[1px] px-2 py-1 font-mono text-[11px] transition-colors ${
                  activeDrawer === "clean"
                    ? "bg-cobalt-wash font-semibold text-cobalt-ink"
                    : "text-bone-muted hover:bg-surface-2 hover:text-bone"
                }`}
              >
                <Sparkles size={12} aria-hidden />
                <span className="hidden 2xl:inline">{t("cleanBrain.shortLabel")}</span>
              </button>

              <span className="mx-0.5 h-4 w-px bg-rule" aria-hidden />

              <button
                type="button"
                onClick={() => setResetSignal((n) => n + 1)}
                title={t("brain.resetCamera")}
                className="inline-flex items-center gap-1 rounded-[1px] px-2 py-1 font-mono text-[11px] text-bone-muted transition-colors hover:bg-surface-2 hover:text-bone"
              >
                <RotateCcw size={12} aria-hidden />
              </button>
            </div>
          </div>
        </div>

        {/* Non-blocking theme shader / custom mesh warnings (THEME_SPEC §6.2) */}
        <div className="pointer-events-auto absolute top-14 right-3 z-25 max-w-md">
          <ThemeWarningsBanner />
        </div>

        {/* Project Clusters Legend Overlay (when project_clusters layout is active) */}
        {activeLayout === "project_clusters" && projectContainers.length > 0 && (
          <div className="pointer-events-none absolute top-16 left-3 z-10 hidden max-w-xs flex-wrap gap-1.5 rounded-[2px] border border-rule bg-surface/90 p-2 font-mono text-[10px] sm:flex">
            {projectContainers.map((c) => (
              <span
                key={c.id}
                className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule bg-void px-1.5 py-0.5 text-bone-muted"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
                <span className="text-bone">{c.label}</span>
                <span className="tabular-nums text-bone-subtle">
                  {clusterSizeMetric === "tokens"
                    ? `${c.totalTokens.toLocaleString()}t`
                    : `${c.vectorCount}v`}
                </span>
              </span>
            ))}
          </div>
        )}

        {/* 3D R3F Canvas — camera-facing point sprites, zero lighting, Eco 30 FPS cap */}
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
                far: 3000,
              }}
              gl={{
                antialias: !isEco,
                powerPreference: isEco ? "low-power" : "high-performance",
              }}
            >
              <BrainScene
                graph={graph}
                manifest={manifest}
                themeBasePath={themeBasePath}
                activeLayout={activeLayout}
                clusterSizeMetric={clusterSizeMetric}
                showConnections={showConnections}
                hardwareTier={hardwareTier}
                filters={filters}
                searchQuery={searchQuery}
                hoveredNodeId={hoveredNodeId}
                selectedNodeId={selectedNodeId}
                highlightedNodeIds={highlightedNodeIds}
                resetSignal={resetSignal}
                onHoverNode={handleHoverNode}
                onSelectNode={handleSelectNode}
                onContainersChange={setProjectContainers}
              />
            </Canvas>
          </CanvasErrorBoundary>
        )}

        {/* Pointer-tracked hover tooltip (only for hovered node — THEME_SPEC §6.1) */}
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

        {/* Bottom overlays: Synaptic Live HUD, Time-Travel Bar, Filter Dock */}
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex flex-col gap-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <SynapticHud />

            {/* Minimal palette legend */}
            <div className="hidden items-center gap-3 rounded-[2px] border border-rule bg-surface/90 px-2.5 py-1 font-mono text-[10px] text-bone-muted lg:flex">
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
          </div>

          {timeTravelOpen && <TimeTravelBar onClose={() => setTimeTravelOpen(false)} />}

          {graph && <FilterDock nodes={graph.nodes} projects={graph.projects} />}
        </div>
      </div>

      {/* Contextual Right Slide-Over Drawer (Node Inspector / RAG Debugger / Clean Brain) */}
      {activeDrawer === "inspector" && selectedNodeId && (
        <NodeInspector memoryId={selectedNodeId} onClose={handleCloseDrawer} />
      )}
      {activeDrawer === "rag" && (
        <RagDebugger
          onClose={() => setActiveDrawer("none")}
          onInspectMemory={handleInspectMemoryId}
        />
      )}
      {activeDrawer === "clean" && (
        <CleanBrainPanel
          onClose={() => setActiveDrawer("none")}
          onInspectMemory={handleInspectMemoryId}
        />
      )}
    </div>
  );
}

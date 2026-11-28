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
  Crosshair,
  Folder,
  FolderCode,
  FolderInput,
  FolderKanban,
  Globe,
  Inbox,
  Pause,
  Play,
  Plug,
  Radio,
  RotateCcw,
  SearchCode,
  Share2,
  Shield,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { backendCall } from "@/lib/backend";
import {
  buildMoveSelectionSummary,
  formatMoveReportToast,
  isCodeProject,
  splitProjects,
  UNSORTED_PROJECT_COLOR,
  UNSORTED_PROJECT_NAME,
} from "@/lib/projects";
import { isBuiltinThemeId } from "@/lib/themeEngine";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import {
  useFiltersStore,
  useMemoryStore,
  useSettingsStore,
  useThemeStore,
  useUiStore,
} from "@/stores";
import { NodeInspector } from "@/components/inspector/NodeInspector";
import { FolderPickerDialog } from "@/components/projects/FolderPickerDialog";
import { CobaltMark } from "@/components/shell/CobaltMark";
import { Skeleton } from "@/components/ui";
import { BranchSwitcher } from "@/components/tools/BranchSwitcher";
import { CleanBrainPanel } from "@/components/tools/CleanBrainPanel";
import { RagDebugger } from "@/components/tools/RagDebugger";
import { TimeTravelBar } from "@/components/tools/TimeTravelBar";
import type { GraphNode, ProjectContainer, Uuid } from "@/types/contracts";
import { BrainScene, type PulseVisibilitySummary } from "./BrainScene";
import { FilterDock } from "./FilterDock";
import { LayoutsPanel } from "./LayoutsPanel";
import { NodeTooltip, type TooltipPointer } from "./NodeTooltip";
import { PulseEdgeIndicator, type PulseIndicatorSafeInsets } from "./PulseEdgeIndicator";
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
  const topToolbarRef = useRef<HTMLDivElement>(null);
  const bottomDockRef = useRef<HTMLDivElement>(null);
  const hudWrapperRef = useRef<HTMLDivElement>(null);

  const graph = useMemoryStore((s) => s.graph);
  const loading = useMemoryStore((s) => s.loading);
  const graphError = useMemoryStore((s) => s.error);
  const hoveredNodeId = useMemoryStore((s) => s.hoveredNodeId);
  const selectedNodeId = useMemoryStore((s) => s.selectedNodeId);
  const selectedNodeIds = useMemoryStore((s) => s.selectedNodeIds);
  const highlightedNodeIds = useMemoryStore((s) => s.highlightedNodeIds);
  const loadGraph = useMemoryStore((s) => s.loadGraph);
  const setHoveredNodeId = useMemoryStore((s) => s.setHoveredNodeId);
  const setSelectedNodeId = useMemoryStore((s) => s.setSelectedNodeId);
  const toggleNodeSelection = useMemoryStore((s) => s.toggleNodeSelection);
  const clearMultiSelection = useMemoryStore((s) => s.clearMultiSelection);
  const requestFocusNodes = useMemoryStore((s) => s.requestFocusNodes);
  const pushThemeToast = useThemeStore((s) => s.pushThemeToast);

  const manifest = useThemeStore((s) => s.manifest);
  const installedThemes = useThemeStore((s) => s.installedThemes);
  const activeLayout = useThemeStore((s) => s.activeLayout);
  const clusterSizeMetric = useThemeStore((s) => s.clusterSizeMetric);
  const showConnections = useThemeStore((s) => s.showConnections);
  const autoRotatePaused = useThemeStore((s) => s.autoRotatePaused);
  const setActiveLayout = useThemeStore((s) => s.setActiveLayout);
  const setClusterSizeMetric = useThemeStore((s) => s.setClusterSizeMetric);
  const toggleShowConnections = useThemeStore((s) => s.toggleShowConnections);
  const toggleAutoRotatePaused = useThemeStore((s) => s.toggleAutoRotatePaused);
  const prefersReducedMotion = usePrefersReducedMotion();

  const appInfo = useUiStore((s) => s.appInfo);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const openToolsTab = useUiStore((s) => s.openToolsTab);
  const openUnsortedView = useUiStore((s) => s.openUnsortedView);

  const themeBasePath = useMemo(() => {
    if (isBuiltinThemeId(manifest.id)) return null;
    const installed = installedThemes.find((item) => item.id === manifest.id);
    if (installed?.local_path && !installed.local_path.startsWith("builtin://")) {
      return installed.local_path;
    }
    if (appInfo?.data_dir) {
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
  const resetFilters = useFiltersStore((s) => s.resetFilters);

  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [pointer, setPointer] = useState<TooltipPointer>({ x: 0, y: 0 });
  const hoveredNodeRef = useRef<GraphNode | null>(null);
  const pointerRef = useRef<TooltipPointer>({ x: 0, y: 0 });
  const [resetSignal, setResetSignal] = useState(0);
  const [centerViewSignal, setCenterViewSignal] = useState(0);
  const [anyNodeInView, setAnyNodeInView] = useState(true);
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>("none");
  const [timeTravelOpen, setTimeTravelOpen] = useState(false);
  const [moveSelectionOpen, setMoveSelectionOpen] = useState(false);
  const [projectContainers, setProjectContainers] = useState<readonly ProjectContainer[]>([]);
  const [pulseVisibility, setPulseVisibility] = useState<PulseVisibilitySummary | null>(null);

  // Freeze initial Canvas camera config so re-renders / layout changes never touch camera props
  const initialCanvasCameraRef = useRef({
    position: manifest.camera.position,
    fov: manifest.camera.fov,
    near: 0.1,
    far: 3000,
  });
  const [indicatorSafeInsets, setIndicatorSafeInsets] = useState<PulseIndicatorSafeInsets>({
    top: 68,
    bottom: 72,
    containerWidth: 800,
    containerHeight: 600,
    hudRight: 0,
    hudTopFromBottom: 0,
  });

  // Measure top toolbar, bottom dock, and SynapticHud bounds so PulseEdgeIndicator never overlaps buttons
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const containerRect = container.getBoundingClientRect();
      if (containerRect.width <= 0 || containerRect.height <= 0) return;

      const topEl = topToolbarRef.current;
      const topInset = topEl
        ? Math.max(56, Math.ceil(topEl.getBoundingClientRect().bottom - containerRect.top) + 12)
        : 68;

      const dockEl = bottomDockRef.current;
      const dockRect = dockEl?.getBoundingClientRect();
      const bottomInset =
        dockRect && dockRect.height > 0
          ? Math.max(56, Math.ceil(containerRect.bottom - dockRect.top) + 12)
          : 56;

      const hudEl = hudWrapperRef.current;
      const hudRect = hudEl?.getBoundingClientRect();
      const hudVisibleNow = Boolean(hudRect && hudRect.height > 0 && hudRect.width > 0);
      const hudRight = hudVisibleNow && hudRect ? Math.ceil(hudRect.right - containerRect.left) : 0;
      const hudTopFromBottom =
        hudVisibleNow && hudRect ? Math.ceil(containerRect.bottom - hudRect.top) : 0;

      const nextWidth = Math.round(containerRect.width);
      const nextHeight = Math.round(containerRect.height);

      setIndicatorSafeInsets((prev) =>
        prev.top === topInset &&
        prev.bottom === bottomInset &&
        prev.containerWidth === nextWidth &&
        prev.containerHeight === nextHeight &&
        prev.hudRight === hudRight &&
        prev.hudTopFromBottom === hudTopFromBottom
          ? prev
          : {
              top: topInset,
              bottom: bottomInset,
              containerWidth: nextWidth,
              containerHeight: nextHeight,
              hudRight,
              hudTopFromBottom,
            },
      );
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    if (topToolbarRef.current) observer.observe(topToolbarRef.current);
    if (bottomDockRef.current) observer.observe(bottomDockRef.current);
    if (hudWrapperRef.current) observer.observe(hudWrapperRef.current);
    return () => observer.disconnect();
  }, [graph?.nodes.length, timeTravelOpen]);

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

  const { regular: regularProjects, unsorted: unsortedProject } = useMemo(
    () => splitProjects(graph?.projects ?? []),
    [graph?.projects],
  );

  const unsortedCount = useMemo(() => {
    if (!unsortedProject || !graph) return unsortedProject?.vector_count ?? 0;
    const nodeCount = graph.nodes.filter(
      (n) => n.project_id === unsortedProject.project.id && n.status !== "superseded",
    ).length;
    return Math.max(unsortedProject.vector_count, nodeCount);
  }, [graph, unsortedProject]);

  const handleHoverNode = useCallback(
    (node: GraphNode | null) => {
      hoveredNodeRef.current = node;
      if (node) {
        setPointer(pointerRef.current);
      }
      setHoveredNode(node);
      setHoveredNodeId(node ? node.id : null);
    },
    [setHoveredNodeId],
  );

  const handleSelectNode = useCallback(
    (node: GraphNode | null, additive = false) => {
      if (additive) {
        if (node) {
          toggleNodeSelection(node.id);
        }
        return;
      }
      setSelectedNodeId(node ? node.id : null);
    },
    [setSelectedNodeId, toggleNodeSelection],
  );

  const selectedNodesList = useMemo<GraphNode[]>(() => {
    if (!graph || selectedNodeIds.size === 0) return [];
    return graph.nodes.filter((n) => selectedNodeIds.has(n.id));
  }, [graph, selectedNodeIds]);

  const multiMoveSummary = useMemo(
    () => buildMoveSelectionSummary(selectedNodesList, graph?.nodes),
    [graph?.nodes, selectedNodesList],
  );

  const multiMoveInfoBanner = useMemo(() => {
    const { sourceDocIds, standaloneMemoryIds, documentFragmentsCount } = multiMoveSummary;
    if (sourceDocIds.length === 0) return null;
    if (sourceDocIds.length === 1 && standaloneMemoryIds.length === 0) {
      return t("folders.moveWholeDocumentNotice", { count: documentFragmentsCount });
    }
    if (standaloneMemoryIds.length === 0) {
      return t("folders.moveWholeDocumentsNotice", {
        docs: sourceDocIds.length,
        fragments: documentFragmentsCount,
      });
    }
    return t("folders.moveMixedSelectionNotice", {
      docs: sourceDocIds.length,
      fragments: documentFragmentsCount,
      standalone: standaloneMemoryIds.length,
    });
  }, [multiMoveSummary, t]);

  const handleConfirmMoveSelection = useCallback(
    async (projectId: Uuid | null, targetName: string) => {
      if (selectedNodesList.length === 0) {
        setMoveSelectionOpen(false);
        return;
      }
      const report = await backendCall("move_to_project", {
        ...multiMoveSummary.request,
        project_id: projectId,
      });
      setMoveSelectionOpen(false);
      clearMultiSelection();
      await loadGraph();
      pushThemeToast({
        kind: "saved",
        message: formatMoveReportToast(report, targetName, t),
      });
    },
    [clearMultiSelection, loadGraph, multiMoveSummary.request, pushThemeToast, selectedNodesList.length, t],
  );

  const handleInspectMemoryId = useCallback(
    (id: string) => {
      setSelectedNodeId(id);
      setActiveDrawer("inspector");
    },
    [setSelectedNodeId],
  );

  const handleFocusOffScreenPulses = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      requestFocusNodes(ids);
    },
    [requestFocusNodes],
  );

  const handleRevealFilteredPulses = useCallback(
    (ids: readonly string[]) => {
      resetFilters();
      if (ids.length > 0) {
        requestFocusNodes(ids);
      }
    },
    [requestFocusNodes, resetFilters],
  );

  const handleCloseDrawer = useCallback(() => {
    setActiveDrawer("none");
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  const handleCloseToolDrawer = useCallback(() => {
    setActiveDrawer("none");
  }, []);

  const toggleDrawer = (target: Exclude<ActiveDrawer, "none" | "inspector">) => {
    setActiveDrawer((prev) => (prev === target ? "none" : target));
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pointerRef.current = next;
    // Only trigger React state updates while a tooltip is actively visible
    if (hoveredNodeRef.current) {
      setPointer(next);
    }
  };

  const sceneViewportInsets = useMemo(
    () => ({
      top: indicatorSafeInsets.top,
      bottom: indicatorSafeInsets.bottom,
    }),
    [indicatorSafeInsets.bottom, indicatorSafeInsets.top],
  );

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
      <h2 className="text-lg font-semibold tracking-tight text-bone">{t("brain.webglFallbackTitle")}</h2>
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
        className="relative min-w-0 flex-1 overflow-hidden select-none"
        style={{ backgroundColor: manifest.palette.background }}
      >
        {/* Top HUD bar: left status + center layout switcher + right tool buttons */}
        <div
          ref={topToolbarRef}
          className="pointer-events-none absolute inset-x-3 top-3 z-20 flex flex-wrap items-start justify-between gap-2"
        >
          {/* Top-left: Branch Switcher, counts, FPS badge, Read-Only toggle, Daemon status */}
          <div className="flex flex-wrap items-center gap-1.5">
            <BranchSwitcher />

            {graph && (
              <div className="inline-flex items-center divide-x divide-rule rounded-[2px] border border-rule-strong bg-surface/95 font-mono text-[11px]">
                <span className="px-2.5 py-1 tabular-nums text-bone-muted">
                  {t("brain.nodesCount", { count: graph.nodes.length })}
                </span>
                <span className="px-2.5 py-1 tabular-nums text-bone-subtle">
                  {t("brain.projectsCount", { count: regularProjects.length })}
                </span>
              </div>
            )}

            {unsortedProject && unsortedCount > 0 && (
              <button
                type="button"
                onClick={openUnsortedView}
                title={t("unsorted.explanation")}
                className="pointer-events-auto inline-flex items-center gap-1.5 rounded-[2px] border border-dashed border-rule-strong bg-surface/95 px-2 py-1 font-mono text-[10px] text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:text-bone"
              >
                <Inbox size={11} style={{ color: UNSORTED_PROJECT_COLOR }} aria-hidden />
                <span>{UNSORTED_PROJECT_NAME}</span>
                <span className="inline-flex min-w-[1.2rem] items-center justify-center rounded-[2px] border border-rule-strong bg-void px-1 py-0.25 text-[9px] font-semibold tabular-nums text-bone">
                  {unsortedCount}
                </span>
              </button>
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
          </div>

          {/* Top-right: Connections toggle + Governance Tools + Camera Reset */}
          <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
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

              {activeLayout === "project_islands" && graph && graph.nodes.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCenterViewSignal((n) => n + 1)}
                  title={t("brain.centerViewIslandsHint")}
                  className="inline-flex items-center gap-1 rounded-[1px] px-2 py-1 font-mono text-[11px] text-bone-muted transition-colors hover:bg-surface-2 hover:text-bone"
                >
                  <Crosshair size={12} aria-hidden />
                  <span>{t("brain.centerView")}</span>
                </button>
              )}

              <span
                title={
                  prefersReducedMotion
                    ? t("brain.rotationDisabledReducedMotion")
                    : autoRotatePaused
                      ? t("brain.resumeRotation")
                      : t("brain.pauseRotation")
                }
                className="inline-flex"
              >
                <button
                  type="button"
                  disabled={prefersReducedMotion}
                  onClick={toggleAutoRotatePaused}
                  aria-pressed={prefersReducedMotion || autoRotatePaused}
                  aria-label={
                    prefersReducedMotion
                      ? t("brain.rotationDisabledReducedMotion")
                      : autoRotatePaused
                        ? t("brain.resumeRotation")
                        : t("brain.pauseRotation")
                  }
                  className={`inline-flex items-center gap-1 rounded-[1px] px-2 py-1 font-mono text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                    !prefersReducedMotion && autoRotatePaused
                      ? "bg-cobalt-wash font-semibold text-cobalt-ink"
                      : "text-bone-muted hover:bg-surface-2 hover:text-bone disabled:hover:bg-transparent disabled:hover:text-bone-muted"
                  }`}
                >
                  {prefersReducedMotion || autoRotatePaused ? (
                    <Play size={12} aria-hidden />
                  ) : (
                    <Pause size={12} aria-hidden />
                  )}
                </button>
              </span>

              <button
                type="button"
                onClick={() => setResetSignal((n) => n + 1)}
                title={t("brain.resetCamera")}
                aria-label={t("brain.resetCamera")}
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

        {/* Project / Folder Legend Overlay (when project_clusters or project_islands layout is active) */}
        {(activeLayout === "project_clusters" || activeLayout === "project_islands") &&
          projectContainers.length > 0 && (
            <div className="pointer-events-none absolute top-16 left-3 z-10 hidden max-w-xs flex-wrap gap-1.5 rounded-[2px] border border-rule bg-surface/90 p-2 font-mono text-[10px] sm:flex">
              {projectContainers.map((c) => {
                const proj = c.projectId ? projectById.get(c.projectId) : null;
                const displayLabel = c.projectId === null ? t("brain.globalScope") : c.label;
                return (
                  <span
                    key={c.id}
                    className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule bg-void px-1.5 py-0.5 text-bone-muted"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: c.color }}
                    />
                    {c.projectId === null ? (
                      <Globe size={10} className="shrink-0 text-bone-subtle" aria-hidden />
                    ) : isCodeProject(proj) ? (
                      <FolderCode size={10} className="shrink-0 text-bone-subtle" aria-hidden />
                    ) : (
                      <Folder size={10} className="shrink-0 text-bone-subtle" aria-hidden />
                    )}
                    <span className="text-bone">{displayLabel}</span>
                    <span className="tabular-nums text-bone-subtle">
                      {clusterSizeMetric === "tokens"
                        ? `${c.totalTokens.toLocaleString()}t`
                        : `${c.vectorCount}v`}
                    </span>
                  </span>
                );
              })}
            </div>
          )}

        {/* Initial loading skeleton before graph arrives */}
        {loading && !graph && (
          <div
            className="cobalt-view-fade pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6"
            aria-busy="true"
            aria-label={t("shell.loading")}
          >
            <CobaltMark size={24} />
            <Skeleton className="h-1.5 w-40" />
          </div>
        )}

        {/* 3D R3F Canvas — camera-facing point sprites, zero lighting, Eco 30 FPS cap */}
        {graph && (
          <div className="absolute inset-0">
            <CanvasErrorBoundary fallback={fallbackView}>
              <Canvas
                frameloop={hardwareTier === "ultra" ? "always" : "never"}
                resize={{ scroll: false, debounce: { scroll: 0, resize: 0 } }}
                shadows={false}
                dpr={dpr}
                camera={initialCanvasCameraRef.current}
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
                  autoRotatePaused={autoRotatePaused}
                  viewportInsets={sceneViewportInsets}
                  hardwareTier={hardwareTier}
                  filters={filters}
                  searchQuery={searchQuery}
                  hoveredNodeId={hoveredNodeId}
                  selectedNodeId={selectedNodeId}
                  selectedNodeIds={selectedNodeIds}
                  highlightedNodeIds={highlightedNodeIds}
                  resetSignal={resetSignal}
                  centerViewSignal={centerViewSignal}
                  onHoverNode={handleHoverNode}
                  onSelectNode={handleSelectNode}
                  onContainersChange={setProjectContainers}
                  onPulseVisibilityChange={setPulseVisibility}
                  onNodesInViewChange={setAnyNodeInView}
                />
              </Canvas>
            </CanvasErrorBoundary>
          </div>
        )}

        {/* Helpful empty state for a brand-new install with 0 memories */}
        {!loading && graph && graph.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-15 flex items-center justify-center p-6">
            <div className="cobalt-modal-enter pointer-events-auto w-full max-w-md rounded-[2px] border border-rule-strong bg-surface/95 p-6 text-center shadow-[0_20px_48px_rgba(0,0,0,0.7)] backdrop-blur-sm">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash">
                <CobaltMark size={22} />
              </div>
              <h2 className="mt-4 text-xl font-semibold tracking-tight text-bone">
                {t("brain.emptyTitle")}
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-bone-muted">
                {t("brain.emptyDesc")}
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => openToolsTab("importer")}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-3.5 py-2 font-mono text-xs font-semibold text-bone transition-colors hover:bg-cobalt-bright"
                >
                  <Upload size={13} aria-hidden />
                  <span>{t("brain.emptyImportAction")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveNav("connectors")}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-2 font-mono text-xs text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:text-bone"
                >
                  <Plug size={13} aria-hidden />
                  <span>{t("brain.emptyConnectAction")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => openToolsTab("projects")}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-2 font-mono text-xs text-bone-muted transition-colors hover:border-cobalt-ink/60 hover:text-bone"
                >
                  <FolderKanban size={13} aria-hidden />
                  <span>{t("brain.emptyProjectAction")}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Load error state when initial graph fetch fails */}
        {!loading && !graph && graphError && (
          <div className="pointer-events-none absolute inset-0 z-15 flex items-center justify-center p-6">
            <div className="pointer-events-auto w-full max-w-md rounded-[2px] border border-cinnabar-rule bg-surface/95 p-5 text-center">
              <p className="text-xs text-cinnabar">{graphError}</p>
              <button
                type="button"
                onClick={() => void loadGraph()}
                className="mt-3 inline-flex items-center gap-1.5 rounded-[2px] border border-rule-strong bg-surface-2 px-3 py-1.5 font-mono text-xs text-bone hover:border-cobalt-ink/60"
              >
                <RotateCcw size={12} aria-hidden />
                {t("common.refresh")}
              </button>
            </div>
          </div>
        )}

        {/* Off-screen / filtered-out live pulse edge indicator */}
        <PulseEdgeIndicator
          summary={pulseVisibility}
          safeInsets={indicatorSafeInsets}
          onFocusOffScreen={handleFocusOffScreenPulses}
          onRevealFiltered={handleRevealFilteredPulses}
        />

        {/* Subtle "Center view" hint when no visible node is inside the camera frustum */}
        {!anyNodeInView && graph && graph.nodes.length > 0 && (
          <button
            type="button"
            onClick={() => setCenterViewSignal((n) => n + 1)}
            title={
              activeLayout === "project_islands"
                ? t("brain.centerViewIslandsHint")
                : t("brain.centerViewHint")
            }
            style={{
              bottom: `${
                Math.max(indicatorSafeInsets.bottom + 8, 76) +
                (pulseVisibility?.edge === "bottom" ? 44 : 0)
              }px`,
            }}
            className="cobalt-panel-enter-up pointer-events-auto absolute left-1/2 z-25 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-surface/95 px-3 py-1.5 font-mono text-xs font-medium text-bone shadow-[0_8px_24px_rgba(0,0,0,0.65)] backdrop-blur-xs transition-colors hover:border-cobalt-ink hover:bg-cobalt-wash hover:text-cobalt-ink focus-visible:ring-1 focus-visible:ring-cobalt-ink focus-visible:outline-none"
          >
            <Crosshair size={13} className="shrink-0 text-cobalt-ink" aria-hidden />
            <span className="whitespace-nowrap">{t("brain.centerView")}</span>
          </button>
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
            <div ref={hudWrapperRef} className="max-w-full">
              <SynapticHud />
            </div>

            {/* Minimal palette legend */}
            {graph && graph.nodes.length > 0 && (
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
            )}
          </div>

          <div ref={bottomDockRef} className="flex flex-col gap-2">
            {selectedNodesList.length > 0 && (
              <div className="cobalt-panel-enter-up pointer-events-auto flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-cobalt-rule bg-surface/95 px-3 py-2 shadow-[0_10px_28px_rgba(0,0,0,0.68)]">
                <div className="flex items-center gap-2 font-mono text-[11px] text-bone">
                  <span className="inline-flex h-5 min-w-[1.4rem] items-center justify-center rounded-[2px] border border-cobalt-rule bg-cobalt-wash px-1.5 font-semibold tabular-nums text-cobalt-ink">
                    {selectedNodesList.length}
                  </span>
                  <span>
                    {t("folders.selectionCount", { count: selectedNodesList.length })}
                  </span>
                  <span className="hidden text-[10px] text-bone-subtle sm:inline">
                    · {t("folders.multiSelectHint")}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => setMoveSelectionOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-[2px] border border-cobalt-rule bg-cobalt px-2.5 py-1 font-mono text-[11px] font-semibold text-on-accent transition-colors hover:bg-cobalt-bright disabled:opacity-45"
                  >
                    <FolderInput size={12} aria-hidden />
                    <span>{t("folders.moveSelectionAction")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={clearMultiSelection}
                    aria-label={t("folders.clearSelection")}
                    title={t("folders.clearSelection")}
                    className="inline-flex items-center gap-1 rounded-[2px] border border-rule-strong bg-surface-2 px-2 py-1 font-mono text-[11px] text-bone-muted hover:text-bone"
                  >
                    <X size={11} aria-hidden />
                  </button>
                </div>
              </div>
            )}

            {timeTravelOpen && <TimeTravelBar onClose={() => setTimeTravelOpen(false)} />}

            {graph && graph.nodes.length > 0 && (
              <FilterDock nodes={graph.nodes} projects={graph.projects} />
            )}
          </div>
        </div>
      </div>

      {moveSelectionOpen && selectedNodesList.length > 0 && (
        <FolderPickerDialog
          mode="move"
          title={t("folders.moveSelectionDialogTitle", { count: selectedNodesList.length })}
          infoBanner={multiMoveInfoBanner}
          initialProjects={graph?.projects}
          onConfirm={handleConfirmMoveSelection}
          onCancel={() => setMoveSelectionOpen(false)}
        />
      )}

      {/* Collapsible Layouts Panel on the right edge of the 3D view */}
      <LayoutsPanel
        activeLayout={activeLayout}
        clusterSizeMetric={clusterSizeMetric}
        hasCustomMesh={Boolean(manifest.mesh_path)}
        onSelectLayout={setActiveLayout}
        onSelectSizeMetric={setClusterSizeMetric}
      />

      {/* Contextual Right Slide-Over Drawer (Node Inspector / RAG Debugger / Clean Brain) */}
      {activeDrawer === "inspector" && selectedNodeId && (
        <NodeInspector memoryId={selectedNodeId} onClose={handleCloseDrawer} />
      )}
      {activeDrawer === "rag" && (
        <RagDebugger
          onClose={handleCloseToolDrawer}
          onInspectMemory={handleInspectMemoryId}
        />
      )}
      {activeDrawer === "clean" && (
        <CleanBrainPanel
          onClose={handleCloseToolDrawer}
          onInspectMemory={handleInspectMemoryId}
        />
      )}
    </div>
  );
}

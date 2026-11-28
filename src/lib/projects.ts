import type { TFunction } from "i18next";
import {
  UNSORTED_PROJECT_NAME,
  type DeleteProjectContents,
  type DeleteProjectReport,
  type GraphNode,
  type MoveReport,
  type MoveToProjectRequest,
  type Project,
  type ProjectStats,
  type Uuid,
} from "@/types/contracts";

export { UNSORTED_PROJECT_NAME };

/** Neutral grey color used everywhere for the "Sin clasificar" isolation bucket. */
export const UNSORTED_PROJECT_COLOR = "#71717A";

/** Calm slate color used consistently for the "General" (`project_id === null`) bucket. */
export const GENERAL_FOLDER_COLOR = "#94A3B8";

/** Shared color palette for folders and code projects. */
export const PROJECT_COLORS = [
  "#3B82F6",
  "#10B981",
  "#A855F7",
  "#F59E0B",
  "#EC4899",
  "#06B6D4",
  "#EF4444",
  "#84CC16",
] as const;

/** Sentinel value used in `<Select>` dropdowns and pickers to represent `project_id: null` (General). */
export const GLOBAL_PROJECT_SENTINEL = "__global__";

const LAST_DROP_FOLDER_STORAGE_KEY = "cobalt.lastDropFolder";

export function isUnsortedProjectName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.trim().toLowerCase() === UNSORTED_PROJECT_NAME.toLowerCase();
}

export function isUnsortedProject(project: Pick<Project, "name"> | null | undefined): boolean {
  return isUnsortedProjectName(project?.name);
}

/** A project without `root_path` is a plain folder ("carpeta"). */
export function isPlainFolder(project: Pick<Project, "root_path"> | null | undefined): boolean {
  if (!project) return false;
  return project.root_path === null || project.root_path.trim().length === 0;
}

/** A project with `root_path` is a linked code project on disk. */
export function isCodeProject(project: Pick<Project, "root_path"> | null | undefined): boolean {
  return Boolean(project?.root_path && project.root_path.trim().length > 0);
}

export function resolveProjectColor(
  project: Pick<Project, "name" | "color_hex"> | null | undefined,
  fallback = GENERAL_FOLDER_COLOR,
): string {
  if (!project) return fallback;
  if (isUnsortedProject(project)) return UNSORTED_PROJECT_COLOR;
  return project.color_hex;
}

export function resolveProjectColorByName(
  name: string | null | undefined,
  colorHex: string | null | undefined,
  fallback = GENERAL_FOLDER_COLOR,
): string {
  if (isUnsortedProjectName(name)) return UNSORTED_PROJECT_COLOR;
  return colorHex ?? fallback;
}

/** Pick the next unused palette color for a new folder, falling back to cycling. */
export function pickNextFolderColor(
  existingProjects: readonly Pick<Project, "color_hex">[],
): string {
  const used = new Set(existingProjects.map((p) => p.color_hex.toLowerCase()));
  for (const color of PROJECT_COLORS) {
    if (!used.has(color.toLowerCase())) {
      return color;
    }
  }
  return PROJECT_COLORS[existingProjects.length % PROJECT_COLORS.length] ?? PROJECT_COLORS[0];
}

export interface SplitProjectsResult<T extends { project: Project }> {
  regular: T[];
  unsorted: T | null;
}

export function splitProjects<T extends { project: Project }>(
  items: readonly T[],
): SplitProjectsResult<T> {
  const regular: T[] = [];
  let unsorted: T | null = null;
  for (const item of items) {
    if (isUnsortedProject(item.project)) {
      unsorted = item;
    } else {
      regular.push(item);
    }
  }
  return { regular, unsorted };
}

export function truncateMemoryPreview(text: string, maxLen = 58): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
}

export function toPatchProjectId(selectedValue: string): Uuid | null {
  return selectedValue === GLOBAL_PROJECT_SENTINEL ? null : selectedValue;
}

export function fromMemoryProjectId(projectId: Uuid | null): string {
  return projectId ?? GLOBAL_PROJECT_SENTINEL;
}

/** Remember the last destination folder chosen in the drop-to-ingest dialog. */
export function readLastDropFolder(): string {
  if (typeof window === "undefined") return GLOBAL_PROJECT_SENTINEL;
  try {
    const raw = window.localStorage.getItem(LAST_DROP_FOLDER_STORAGE_KEY);
    if (raw && raw.trim().length > 0) {
      return raw.trim();
    }
  } catch {
    // Ignore storage access errors in restricted environments.
  }
  return GLOBAL_PROJECT_SENTINEL;
}

export function writeLastDropFolder(projectId: Uuid | null): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LAST_DROP_FOLDER_STORAGE_KEY,
      projectId === null ? GLOBAL_PROJECT_SENTINEL : projectId,
    );
  } catch {
    // Ignore storage quota or restricted storage errors.
  }
}

function normalizePathForMatch(rawPath: string): string {
  const unified = rawPath.trim().replace(/\\/g, "/");
  // Keep root "/" intact, strip trailing slashes elsewhere
  const stripped = unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
  // Windows drive paths are case-insensitive
  if (/^[a-zA-Z]:\//.test(stripped) || /^[a-zA-Z]:$/.test(stripped)) {
    return stripped.toLowerCase();
  }
  return stripped;
}

/**
 * If dropped path(s) match an existing active code project's `root_path`
 * (either the folder itself or files inside it), return that project so it can
 * be preselected automatically.
 */
export function detectProjectForPaths(
  paths: readonly string[],
  projects: readonly Project[],
): Project | null {
  if (paths.length === 0) return null;

  const candidates = projects
    .filter((p) => !p.is_archived && !isUnsortedProject(p) && isCodeProject(p))
    .map((project) => ({
      project,
      root: normalizePathForMatch(project.root_path ?? ""),
    }))
    .filter((entry) => entry.root.length > 0)
    // Deepest root path wins for nested repos
    .sort((a, b) => b.root.length - a.root.length);

  if (candidates.length === 0) return null;

  let matchedProject: Project | null = null;
  for (const raw of paths) {
    const norm = normalizePathForMatch(raw);
    if (!norm) continue;
    const hit = candidates.find(
      ({ root }) => norm === root || norm.startsWith(`${root}/`),
    );
    if (!hit) {
      return null;
    }
    if (matchedProject && matchedProject.id !== hit.project.id) {
      return null;
    }
    matchedProject = hit.project;
  }

  return matchedProject;
}

/**
 * Count how many non-superseded fragments in the loaded graph belong to `sourceDocId`.
 * Returns at least 1 so single-chunk documents always display a sensible count.
 */
export function countDocumentFragments(
  nodes: readonly GraphNode[] | null | undefined,
  sourceDocId: Uuid,
): number {
  if (!nodes || nodes.length === 0) return 1;
  let count = 0;
  for (const node of nodes) {
    if (node.source_doc_id === sourceDocId && node.status !== "superseded") {
      count += 1;
    }
  }
  return Math.max(1, count);
}

export interface MoveSelectionSummary {
  request: Omit<MoveToProjectRequest, "project_id">;
  sourceDocIds: Uuid[];
  standaloneMemoryIds: Uuid[];
  documentFragmentsCount: number;
  totalEstimatedMemories: number;
}

/**
 * Build a `move_to_project` payload for a set of selected items (memories / assets).
 * Any item linked to a `source_doc_id` moves its entire source document (`source_doc_ids`);
 * standalone items move via `memory_ids`.
 */
export function buildMoveSelectionSummary(
  items: readonly { id: Uuid; source_doc_id: Uuid | null }[],
  graphNodes: readonly GraphNode[] | null | undefined,
): MoveSelectionSummary {
  const docSet = new Set<Uuid>();
  const standaloneSet = new Set<Uuid>();

  for (const item of items) {
    if (item.source_doc_id) {
      docSet.add(item.source_doc_id);
    } else {
      standaloneSet.add(item.id);
    }
  }

  const sourceDocIds = [...docSet];
  const standaloneMemoryIds = [...standaloneSet];

  let documentFragmentsCount = 0;
  for (const docId of sourceDocIds) {
    documentFragmentsCount += countDocumentFragments(graphNodes, docId);
  }

  const request: Omit<MoveToProjectRequest, "project_id"> = {};
  if (sourceDocIds.length > 0) {
    request.source_doc_ids = sourceDocIds;
  }
  if (standaloneMemoryIds.length > 0) {
    request.memory_ids = standaloneMemoryIds;
  }

  return {
    request,
    sourceDocIds,
    standaloneMemoryIds,
    documentFragmentsCount,
    totalEstimatedMemories: documentFragmentsCount + standaloneMemoryIds.length,
  };
}

/** Format a friendly localized toast message describing a `MoveReport`. */
export function formatMoveReportToast(
  report: MoveReport,
  targetName: string,
  t: TFunction,
): string {
  if (report.memories === 0 && report.documents === 0 && report.merged === 0) {
    return t("folders.moveReport.noChanges", { folder: targetName });
  }

  let base: string;
  if (report.documents > 0) {
    base = t("folders.moveReport.movedWithDocs", {
      folder: targetName,
      docs: report.documents,
      memories: report.memories,
    });
  } else {
    base = t("folders.moveReport.movedMemories", {
      folder: targetName,
      count: report.memories,
    });
  }

  if (report.merged > 0) {
    return `${base} · ${t("folders.moveReport.mergedSuffix", { count: report.merged })}`;
  }

  return base;
}

/** Case-insensitive match for an existing folder/project by name. */
export function findProjectByName(
  projects: readonly ProjectStats[],
  rawName: string,
): ProjectStats | null {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return null;
  return (
    projects.find((stat) => stat.project.name.trim().toLowerCase() === normalized) ?? null
  );
}

/** Count distinct indexed source documents belonging to a project in the loaded graph. */
export function countProjectDocuments(
  nodes: readonly GraphNode[] | null | undefined,
  projectId: Uuid,
): number {
  if (!nodes || nodes.length === 0) return 0;
  const docIds = new Set<Uuid>();
  for (const node of nodes) {
    if (node.project_id === projectId && node.source_doc_id) {
      docIds.add(node.source_doc_id);
    }
  }
  return docIds.size;
}

export interface ActiveFolderCounts {
  byProjectId: Map<Uuid, number>;
  general: number;
}

/**
 * Count active memories (`status === "active"`, excluding superseded and archived)
 * per folder/project plus the shared General space (`project_id === null`).
 */
export function countActiveMemoriesByFolder(
  nodes: readonly GraphNode[] | null | undefined,
): ActiveFolderCounts {
  const byProjectId = new Map<Uuid, number>();
  let general = 0;
  if (!nodes || nodes.length === 0) {
    return { byProjectId, general };
  }
  for (const node of nodes) {
    if (node.status !== "active") continue;
    if (node.project_id === null) {
      general += 1;
    } else {
      byProjectId.set(node.project_id, (byProjectId.get(node.project_id) ?? 0) + 1);
    }
  }
  return { byProjectId, general };
}

/** Format a friendly localized toast message describing a `DeleteProjectReport`. */
export function formatDeleteProjectReportToast(
  projectName: string,
  contents: DeleteProjectContents,
  targetName: string,
  report: DeleteProjectReport,
  t: TFunction,
): string {
  if (contents === "move") {
    const movedMemories = report.moved.memories;
    const movedDocs = report.moved.documents;
    if (movedMemories === 0 && movedDocs === 0) {
      return t("folders.deleteReport.deletedEmpty", { name: projectName });
    }
    const base =
      movedDocs > 0
        ? t("folders.deleteReport.movedWithDocs", {
            name: projectName,
            target: targetName,
            memories: movedMemories,
            docs: movedDocs,
          })
        : t("folders.deleteReport.movedMemories", {
            name: projectName,
            target: targetName,
            count: movedMemories,
          });
    if (report.moved.merged > 0) {
      return `${base} · ${t("folders.moveReport.mergedSuffix", { count: report.moved.merged })}`;
    }
    return base;
  }

  if (report.memories_deleted === 0 && report.documents_deleted === 0) {
    return t("folders.deleteReport.deletedEmpty", { name: projectName });
  }

  const base =
    report.documents_deleted > 0
      ? t("folders.deleteReport.deletedWithDocs", {
          name: projectName,
          memories: report.memories_deleted,
          docs: report.documents_deleted,
        })
      : t("folders.deleteReport.deletedMemories", {
          name: projectName,
          count: report.memories_deleted,
        });

  if (report.snapshot_id) {
    return `${base} · ${t("folders.deleteReport.snapshotCreated")}`;
  }

  return base;
}

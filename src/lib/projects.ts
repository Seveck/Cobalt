import { UNSORTED_PROJECT_NAME, type Project, type Uuid } from "@/types/contracts";

export { UNSORTED_PROJECT_NAME };

/** Neutral grey color used everywhere for the "Sin clasificar" isolation bucket. */
export const UNSORTED_PROJECT_COLOR = "#71717A";

/** Sentinel value used in `<Select>` dropdowns to represent `project_id: null` (Global). */
export const GLOBAL_PROJECT_SENTINEL = "__global__";

export function isUnsortedProjectName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.trim().toLowerCase() === UNSORTED_PROJECT_NAME.toLowerCase();
}

export function isUnsortedProject(project: Pick<Project, "name"> | null | undefined): boolean {
  return isUnsortedProjectName(project?.name);
}

export function resolveProjectColor(
  project: Pick<Project, "name" | "color_hex"> | null | undefined,
  fallback = "#A4A096",
): string {
  if (!project) return fallback;
  if (isUnsortedProject(project)) return UNSORTED_PROJECT_COLOR;
  return project.color_hex;
}

export function resolveProjectColorByName(
  name: string | null | undefined,
  colorHex: string | null | undefined,
  fallback = "#A4A096",
): string {
  if (isUnsortedProjectName(name)) return UNSORTED_PROJECT_COLOR;
  return colorHex ?? fallback;
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

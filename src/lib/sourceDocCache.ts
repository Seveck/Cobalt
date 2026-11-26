import { backendCall } from "@/lib/backend";
import { sourcePathMatchesTouched } from "@/lib/format";
import type { GraphData, Uuid } from "@/types/contracts";

/**
 * In-memory cache mapping `source_doc_id -> file_path` (or `null` if unavailable).
 * Used to match live `cobalt://cli-activity` touched file paths to 3D graph nodes
 * without flooding IPC on every event.
 */
const sourceDocPathCache = new Map<Uuid, string | null>();
const inflightRequests = new Map<Uuid, Promise<string | null>>();

const MAX_FETCH_PER_EVENT = 64;
const FETCH_CONCURRENCY = 8;

/** Seed or update the cache when a component loads or relinks a `SourceDocument`. */
export function cacheSourceDocPath(sourceDocId: Uuid, filePath: string | null): void {
  sourceDocPathCache.set(sourceDocId, filePath);
}

/** Read cached path if already known (`undefined` = not fetched yet). */
export function getCachedSourceDocPath(sourceDocId: Uuid): string | null | undefined {
  return sourceDocPathCache.get(sourceDocId);
}

async function fetchSourceDocPath(sourceDocId: Uuid): Promise<string | null> {
  if (sourceDocPathCache.has(sourceDocId)) {
    return sourceDocPathCache.get(sourceDocId) ?? null;
  }
  const existing = inflightRequests.get(sourceDocId);
  if (existing) return existing;

  const promise = backendCall("get_source_document", { id: sourceDocId })
    .then((doc) => {
      sourceDocPathCache.set(sourceDocId, doc.file_path);
      return doc.file_path;
    })
    .catch(() => {
      sourceDocPathCache.set(sourceDocId, null);
      return null;
    })
    .finally(() => {
      inflightRequests.delete(sourceDocId);
    });

  inflightRequests.set(sourceDocId, promise);
  return promise;
}

/**
 * Resolve all `GraphNode` ids whose linked `SourceDocument.file_path` matches
 * any file touched by a `cobalt://cli-activity` event.
 */
export async function resolveNodesForTouchedFiles(
  graph: GraphData | null,
  files: readonly string[],
  cwd: string | null,
  projectId: Uuid | null,
): Promise<Uuid[]> {
  if (!graph || files.length === 0) return [];

  const linkedNodes = graph.nodes.filter((n) => n.source_doc_id !== null);
  if (linkedNodes.length === 0) return [];

  // Prioritize nodes belonging to the active project so we fetch their docs first.
  const orderedNodes = projectId
    ? [
        ...linkedNodes.filter((n) => n.project_id === projectId),
        ...linkedNodes.filter((n) => n.project_id !== projectId),
      ]
    : linkedNodes;

  const uniqueDocIds: Uuid[] = [];
  const seenDocs = new Set<Uuid>();
  for (const node of orderedNodes) {
    const docId = node.source_doc_id;
    if (!docId || seenDocs.has(docId)) continue;
    seenDocs.add(docId);
    uniqueDocIds.push(docId);
  }

  const uncachedIds = uniqueDocIds
    .filter((id) => !sourceDocPathCache.has(id))
    .slice(0, MAX_FETCH_PER_EVENT);

  for (let i = 0; i < uncachedIds.length; i += FETCH_CONCURRENCY) {
    const batch = uncachedIds.slice(i, i + FETCH_CONCURRENCY);
    await Promise.all(batch.map((id) => fetchSourceDocPath(id)));
  }

  const matchedDocIds = new Set<Uuid>();
  for (const docId of uniqueDocIds) {
    const docPath = sourceDocPathCache.get(docId);
    if (!docPath) continue;
    if (files.some((touched) => sourcePathMatchesTouched(docPath, touched, cwd))) {
      matchedDocIds.add(docId);
    }
  }

  if (matchedDocIds.size === 0) return [];

  const matchedNodeIds: Uuid[] = [];
  for (const node of linkedNodes) {
    if (node.source_doc_id && matchedDocIds.has(node.source_doc_id)) {
      matchedNodeIds.push(node.id);
    }
  }
  return matchedNodeIds;
}

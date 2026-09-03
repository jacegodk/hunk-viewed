import { useSyncExternalStore } from "react";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import { normalizeDiffPath } from "./sidebar/entries";

/** What the extension knows about the live review, gathered from lifecycle events. */
export interface ReviewMirror {
  /** Full changeset in review order, unfiltered. */
  files: readonly ExtensionDiffFile[];
  /** Hunk's file filter text. */
  filter: string;
  selectedFileId: string | null;
  /** True while the extension's files keyboard mode owns keys. */
  filesModeActive: boolean;
}

const initial: ReviewMirror = { files: [], filter: "", selectedFileId: null, filesModeActive: false };
let mirror: ReviewMirror = initial;
const listeners = new Set<() => void>();

function publish(patch: Partial<ReviewMirror>) {
  mirror = { ...mirror, ...patch };
  for (const listener of listeners) listener();
}

/** Return the current immutable mirror snapshot. */
export function getReviewMirror(): ReviewMirror {
  return mirror;
}

/** Subscribe to mirror changes; returns the unsubscribe function. */
export function subscribeReviewMirror(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the mirror from a React component. */
export function useReviewMirror(): ReviewMirror {
  return useSyncExternalStore(subscribeReviewMirror, getReviewMirror);
}

/** Replace the changeset after `changeset_loaded` or `session_reload`. */
export function setMirrorFiles(files: readonly ExtensionDiffFile[]): void {
  publish({ files });
}

/** Record the filter after `filter_changed`. */
export function setMirrorFilter(filter: string): void {
  publish({ filter });
}

/** Record the selection after `selection_changed`. */
export function setMirrorSelectedFileId(fileId: string | null): void {
  publish({ selectedFileId: fileId });
}

/** Record whether the files keyboard mode is active. */
export function setMirrorFilesModeActive(active: boolean): void {
  publish({ filesModeActive: active });
}

/** The file facts hunk's filter reads (`src/core/review/selectors.ts`). */
export type FilterableFile = Pick<ExtensionDiffFile, "path" | "previousPath" | "agent">;

/**
 * Apply hunk's filter rule: a lowercased, trimmed substring match against the file's
 * current path, previous path, and agent summary, joined with a space. Blank matches all.
 * Mirrors `reviewFileMatchesFilter` in hunk's `src/core/review/selectors.ts`.
 */
export function fileMatchesFilter(file: FilterableFile, filter: string): boolean {
  const query = filter.trim().toLowerCase();
  if (query.length === 0) return true;
  return [normalizeDiffPath(file.path), file.previousPath ? normalizeDiffPath(file.previousPath) : undefined, file.agent?.summary]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase()
    .includes(query);
}

/** Return the files hunk currently shows, in review order. */
export function visibleFiles(current: ReviewMirror): ExtensionDiffFile[] {
  return current.files.filter((file) => fileMatchesFilter(file, current.filter));
}

/** Reset module state between tests. */
export function resetReviewMirrorForTests(): void {
  mirror = initial;
  listeners.clear();
}

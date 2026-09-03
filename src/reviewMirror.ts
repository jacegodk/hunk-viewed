import { useSyncExternalStore } from "react";
import type { ExtensionDiffFile } from "hunkdiff/extension";

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

/** Read the mirror from a React component. */
export function useReviewMirror(): ReviewMirror {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getReviewMirror,
  );
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

/** Apply hunk's filter rule: lowercased, trimmed substring of the path; blank matches all. */
export function fileMatchesFilter(path: string, filter: string): boolean {
  const query = filter.trim().toLowerCase();
  return query.length === 0 || path.toLowerCase().includes(query);
}

/** Return the files hunk currently shows, in review order. */
export function visibleFiles(current: ReviewMirror): ExtensionDiffFile[] {
  return current.files.filter((file) => fileMatchesFilter(file.path, current.filter));
}

/** Reset module state between tests. */
export function resetReviewMirrorForTests(): void {
  mirror = initial;
  listeners.clear();
}

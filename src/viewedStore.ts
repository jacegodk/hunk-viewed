import { useSyncExternalStore } from "react";
import { hashPatch } from "./patchHash";
import type { RepoFiles } from "./viewedFile";

/** The two fields a file needs to be checked or marked. `ExtensionDiffFile` satisfies it. */
export interface ViewedFileLike {
  path: string;
  patch: string;
}

export interface ViewedState {
  /** Canonical repo path the marks belong to; null until the startup event loads it. */
  repoKey: string | null;
  files: RepoFiles;
}

type Persist = (repoKey: string, files: RepoFiles) => void;

let state: ViewedState = { repoKey: null, files: {} };
let persist: Persist | null = null;
const listeners = new Set<() => void>();

/** Return the current immutable snapshot. */
export function getViewedState(): ViewedState {
  return state;
}

/** Subscribe to snapshot changes; returns the unsubscribe function. */
export function subscribeViewed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the viewed snapshot from a React component. */
export function useViewedState(): ViewedState {
  return useSyncExternalStore(subscribeViewed, getViewedState);
}

/** Install the save callback; pass null to disable persistence. */
export function setPersist(next: Persist | null): void {
  persist = next;
}

/** Publish a new snapshot, notify React, and save it. Same-object updates are ignored. */
function publish(next: ViewedState) {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
  if (state.repoKey !== null) persist?.(state.repoKey, state.files);
}

/** Install the marks loaded from disk for one repo. Does not persist. */
export function loadRepo(repoKey: string, files: RepoFiles): void {
  state = { repoKey, files };
  for (const listener of listeners) listener();
}

/** Return true when the file has a mark whose hash still matches its patch. */
export function isViewed(current: ViewedState, file: ViewedFileLike): boolean {
  const entry = current.files[file.path];
  return entry !== undefined && entry.hash === hashPatch(file.patch);
}

/** Mark an unviewed file, or clear a viewed one. A stale mark counts as unviewed and is replaced. */
export function toggleViewed(file: ViewedFileLike, now: Date): "marked" | "cleared" {
  if (state.repoKey === null) return "cleared";
  if (isViewed(state, file)) {
    const { [file.path]: _removed, ...rest } = state.files;
    publish({ ...state, files: rest });
    return "cleared";
  }
  publish({
    ...state,
    files: { ...state.files, [file.path]: { hash: hashPatch(file.patch), at: now.toISOString() } },
  });
  return "marked";
}

/**
 * Drop marks for files present in the changeset whose patch no longer matches.
 * Marks for paths absent from the changeset stay, so a path-filtered review does not erase them.
 */
export function reconcileViewed(files: readonly ViewedFileLike[]): void {
  if (state.repoKey === null) return;
  let changed = false;
  const next: RepoFiles = { ...state.files };
  for (const file of files) {
    const entry = next[file.path];
    if (entry !== undefined && entry.hash !== hashPatch(file.patch)) {
      delete next[file.path];
      changed = true;
    }
  }
  if (changed) publish({ ...state, files: next });
}

/** Remove every mark for the current repo. */
export function clearRepo(): void {
  if (state.repoKey === null) return;
  publish({ ...state, files: {} });
}

/** Reset module state between tests. */
export function resetViewedStoreForTests(): void {
  state = { repoKey: null, files: {} };
  persist = null;
  listeners.clear();
}

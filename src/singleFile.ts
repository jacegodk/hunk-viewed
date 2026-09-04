import { useSyncExternalStore } from "react";
import type { ExtensionChangeset, ExtensionDiffFile } from "hunkdiff/extension";

/** Single-file mode: which file the review shows while the mode is active. */
export interface SingleFileState {
  active: boolean;
  /** Path of the one file the changeset transform keeps. */
  targetPath: string | null;
  /** Path a pane click chose; `enter` inside the mode loads it. */
  pendingPath: string | null;
}

const initial: SingleFileState = { active: false, targetPath: null, pendingPath: null };
let state: SingleFileState = initial;
const listeners = new Set<() => void>();

function publish(next: SingleFileState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Return the current immutable snapshot. */
export function getSingleFileState(): SingleFileState {
  return state;
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeSingleFile(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the snapshot from a React component. */
export function useSingleFileState(): SingleFileState {
  return useSyncExternalStore(subscribeSingleFile, getSingleFileState);
}

/** Turn the mode on with the given target. */
export function enterSingleFile(targetPath: string | null): void {
  publish({ active: true, targetPath, pendingPath: null });
}

/** Turn the mode off and forget the target. */
export function exitSingleFile(): void {
  publish(initial);
}

/** Point the mode at another file. No-op when it is already the target and nothing is pending. */
export function setSingleFileTarget(path: string): void {
  if (state.targetPath === path && state.pendingPath === null) return;
  publish({ ...state, targetPath: path, pendingPath: null });
}

/** Remember a pane click until `enter` loads it. No-op when it is already pending. */
export function setSingleFilePending(path: string | null): void {
  if (state.pendingPath === path) return;
  publish({ ...state, pendingPath: path });
}

/** Keep only the target file while the mode is active; otherwise return the changeset as is. */
export function applySingleFileTransform(changeset: ExtensionChangeset, current: SingleFileState): ExtensionChangeset {
  if (!current.active || current.targetPath === null) return changeset;
  const kept = changeset.files.filter((file) => file.path === current.targetPath);
  if (kept.length === 0) return changeset;
  return { ...changeset, files: kept };
}

/** Path of the file before/after `targetPath` in `files`, no wrap; null/unknown target starts at an end. */
export function neighborPath(
  files: readonly ExtensionDiffFile[],
  targetPath: string | null,
  direction: 1 | -1,
): string | null {
  const index = targetPath === null ? -1 : files.findIndex((file) => file.path === targetPath);
  const next = index === -1 ? (direction === 1 ? 0 : files.length - 1) : index + direction;
  return files[next]?.path ?? null;
}

/** Reset module state between tests. */
export function resetSingleFileForTests(): void {
  state = initial;
  listeners.clear();
}

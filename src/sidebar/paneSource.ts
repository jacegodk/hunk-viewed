import type { ExtensionDiffFile } from "hunkdiff/extension";
import type { SingleFileState } from "../singleFile";

/** The files pane's list and the id of the row it highlights. */
export interface PaneSource {
  listFiles: readonly ExtensionDiffFile[];
  highlightedId: string | null;
}

/**
 * Decide which files the pane lists and which row is highlighted.
 *
 * Outside single-file mode the pane mirrors the host's filtered `files` and `selectedFileId`.
 * Inside it, the host-filtered `files` prop holds only the one target file, so the pane instead
 * lists the full `allFiles` and highlights the row whose path matches the current target.
 */
export function resolvePaneSource(
  single: SingleFileState,
  allFiles: readonly ExtensionDiffFile[],
  files: readonly ExtensionDiffFile[],
  selectedFileId: string | null,
): PaneSource {
  if (!single.active) return { listFiles: files, highlightedId: selectedFileId };
  return { listFiles: allFiles, highlightedId: allFiles.find((file) => file.path === single.targetPath)?.id ?? null };
}

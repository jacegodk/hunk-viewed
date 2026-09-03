import type { ExtensionDiffFile } from "hunkdiff/extension";

/**
 * Find the nearest unviewed file after (direction 1) or before (direction -1) the selection.
 * Never wraps. An unknown or null selection starts the search at the first or last file.
 */
export function findUnviewedNeighbor(
  files: readonly ExtensionDiffFile[],
  selectedFileId: string | null,
  direction: 1 | -1,
  isViewedFile: (file: ExtensionDiffFile) => boolean,
): ExtensionDiffFile | null {
  const selectedIndex = selectedFileId === null ? -1 : files.findIndex((file) => file.id === selectedFileId);
  let index: number;
  if (selectedIndex === -1) {
    index = direction === 1 ? 0 : files.length - 1;
  } else {
    index = selectedIndex + direction;
  }
  for (; index >= 0 && index < files.length; index += direction) {
    const file = files[index]!;
    if (!isViewedFile(file)) return file;
  }
  return null;
}

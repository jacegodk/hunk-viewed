import type { ExtensionDiffFile, ExtensionFileViewLayout } from "hunkdiff/extension";

/** Id of the folded presentation, qualified by hunk as `hunk-viewed:viewed`. */
export const FOLDED_VIEW_ID = "viewed";

/**
 * Build the one-row "folded" presentation for a viewed file: a green check, the word viewed,
 * the hunk count, and the line stats. Every hunk maps to that row so hunk navigation still
 * stops at the file. A file without hunks folds to its header alone.
 */
export function buildFoldedLayout(file: ExtensionDiffFile): ExtensionFileViewLayout {
  const hunkCount = file.hunks?.length ?? 0;
  if (hunkCount === 0) return { rows: [], hunkRows: [] };
  const plus = `+${file.stats.additions}${file.statsTruncated ? "+" : ""}`;
  const minus = `-${file.stats.deletions}`;
  return {
    rows: [
      {
        id: "folded",
        spans: [
          { text: "✓ ", tone: "added" },
          { text: "viewed", tone: "muted" },
          { text: `  ${hunkCount} ${hunkCount === 1 ? "hunk" : "hunks"}  ${plus} ${minus}`, tone: "muted" },
        ],
      },
    ],
    hunkRows: Array.from({ length: hunkCount }, () => ({ startRow: 0, endRow: 0 })),
  };
}

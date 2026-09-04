import type { ExtensionFileViewLayout, ExtensionFileViewRow, ExtensionFileViewSpan } from "hunkdiff/extension";
import type { PatchHunk } from "./unifiedPatch";

/** Id of the full-file presentation, qualified by hunk as `hunk-viewed:full`. */
export const FULL_VIEW_ID = "full";
/** Hunk's per-view row limit; a layout over it falls back to the raw diff. */
export const FULL_VIEW_MAX_ROWS = 10_000;

/** Split a document into lines, dropping the empty tail a trailing newline produces. */
function documentLines(document: string): string[] {
  const lines = document.replaceAll("\r\n", "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Rebuild the whole file as a unified diff with unlimited context.
 *
 * Walks the new-side document in order, splicing each hunk's patch lines in at its
 * `newStart`: context rows take the document text and must match the patch, added and removed
 * rows take the patch text. Only rows produced inside a hunk's line loop carry `sourceRanges` —
 * hunk's layout validator requires every row with `sourceRanges` to fall inside exactly one
 * `hunkRows` range, and the context fill before, between, and after hunks does not. Returns null
 * when the patch has no hunks, a hunk has no lines, a context line disagrees with the document
 * (the source moved on), or the row budget is exceeded; hunk then keeps the raw diff.
 */
export function buildFullFileLayout(newDocument: string, hunks: readonly PatchHunk[]): ExtensionFileViewLayout | null {
  if (hunks.length === 0) return null;
  const lines = documentLines(newDocument);
  if (lines.length > FULL_VIEW_MAX_ROWS) return null;
  const gutterWidth = String(Math.max(1, lines.length)).length;
  const rows: ExtensionFileViewRow[] = [];
  const hunkRows: { startRow: number; endRow: number }[] = [];

  const push = (kind: "context" | "added" | "removed", text: string, newLine: number | null, oldLine: number | null, inHunk: boolean) => {
    const number = newLine === null ? " ".repeat(gutterWidth) : String(newLine).padStart(gutterWidth);
    const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
    const tone: ExtensionFileViewSpan["tone"] | undefined = kind === "added" ? "added" : kind === "removed" ? "removed" : undefined;
    const spans: ExtensionFileViewSpan[] = [
      { text: `${number} `, tone: "muted" },
      tone ? { text: `${marker} ${text}`, tone } : { text: `${marker} ${text}` },
    ];
    const sourceRanges =
      inHunk && newLine !== null
        ? [{ side: "new" as const, range: [newLine, newLine] as const }]
        : inHunk && oldLine !== null
          ? [{ side: "old" as const, range: [oldLine, oldLine] as const }]
          : undefined;
    rows.push({ id: `full:${rows.length}`, spans, ...(sourceRanges ? { sourceRanges } : {}) });
  };

  let nextNew = 1; // 1-based new-side line about to be emitted
  for (const hunk of hunks) {
    if (hunk.lines.length === 0) return null;
    const hunkNewStart = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    while (nextNew < hunkNewStart && nextNew <= lines.length) {
      push("context", lines[nextNew - 1]!, nextNew, null, false);
      nextNew += 1;
    }
    const startRow = rows.length;
    let oldLine = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.kind === "removed") {
        push("removed", line.text, null, oldLine, true);
        oldLine += 1;
        continue;
      }
      const documentText = lines[nextNew - 1];
      if (documentText === undefined) return null;
      if (line.kind === "context" && documentText !== line.text) return null;
      const text = line.kind === "added" ? line.text : documentText;
      push(line.kind, text, nextNew, line.kind === "context" ? oldLine : null, true);
      nextNew += 1;
      if (line.kind === "context") oldLine += 1;
    }
    hunkRows.push({ startRow, endRow: Math.max(startRow, rows.length - 1) });
    if (rows.length > FULL_VIEW_MAX_ROWS) return null;
  }
  while (nextNew <= lines.length) {
    push("context", lines[nextNew - 1]!, nextNew, null, false);
    nextNew += 1;
  }
  if (rows.length > FULL_VIEW_MAX_ROWS) return null;
  return { rows, hunkRows };
}

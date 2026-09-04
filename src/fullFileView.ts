import type { ExtensionFileViewLayout, ExtensionFileViewRow, ExtensionFileViewSpan } from "hunkdiff/extension";
import { fitText, padText } from "./sidebar/text";
import type { PatchHunk } from "./unifiedPatch";

/** Id of the full-file presentation, qualified by hunk as `hunk-viewed:full`. */
export const FULL_VIEW_ID = "full";
/** Hunk's per-view row limit; a layout over it falls back to the raw diff. */
export const FULL_VIEW_MAX_ROWS = 10_000;
/** Below this terminal width, a split layout has no room for two usable columns. */
const MIN_SPLIT_WIDTH = 20;

/** How to lay the file view out: hunk's own diff-column width, when known. */
export interface FullFileViewOptions {
  columns?: "single" | "split";
  width?: number;
}

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
 *
 * `options.columns` picks the presentation: `"single"` (default) is one full-width column, the
 * behavior above unchanged. `"split"` renders old and new side by side, following hunk's own
 * resolved layout; it needs `options.width` and falls back to `"single"` when that width has no
 * room for two usable columns.
 */
export function buildFullFileLayout(newDocument: string, hunks: readonly PatchHunk[], options?: FullFileViewOptions): ExtensionFileViewLayout | null {
  if (hunks.length === 0) return null;
  if (options?.columns === "split" && options.width !== undefined && options.width >= MIN_SPLIT_WIDTH) {
    return buildSplitFileLayout(newDocument, hunks, options.width);
  }
  return buildSingleFileLayout(newDocument, hunks);
}

/** One full-width column, unlimited context, unchanged from the pre-split implementation. */
function buildSingleFileLayout(newDocument: string, hunks: readonly PatchHunk[]): ExtensionFileViewLayout | null {
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

/** One line of the rebuilt file, before it is rendered as a single- or split-column row. */
interface FullFileEntry {
  kind: "context" | "added" | "removed";
  text: string;
  newLine: number | null;
  oldLine: number | null;
  inHunk: boolean;
}

/** `buildEntries` output: the flattened file, hunk boundaries within it, and both gutter widths. */
interface FullFileEntries {
  entries: FullFileEntry[];
  /** Inclusive entry-index range covered by each hunk, ordered to match `hunks`. */
  hunkEntryRanges: { start: number; end: number }[];
  gutterWidthOld: number;
  gutterWidthNew: number;
}

/**
 * Walk the new-side document and splice in each hunk's lines, the same way
 * `buildSingleFileLayout` does, but keep the flattened line-by-line result instead of rendering
 * rows immediately. The split renderer regroups this into paired rows; the null rules (no hunks,
 * empty hunk, context mismatch, row budget) match `buildSingleFileLayout` exactly, checked here
 * against the same per-line count so a switch between columns modes never changes what falls back
 * to the raw diff.
 */
function buildEntries(newDocument: string, hunks: readonly PatchHunk[]): FullFileEntries | null {
  const lines = documentLines(newDocument);
  if (lines.length > FULL_VIEW_MAX_ROWS) return null;
  const entries: FullFileEntry[] = [];
  const hunkEntryRanges: { start: number; end: number }[] = [];
  let maxOldLine = 0;
  const record = (oldLine: number | null) => {
    if (oldLine !== null && oldLine > maxOldLine) maxOldLine = oldLine;
  };

  let nextNew = 1;
  let fillOld = 1; // old-side counter for context outside hunks; tracks nextNew until a hunk shifts it
  for (const hunk of hunks) {
    if (hunk.lines.length === 0) return null;
    const hunkNewStart = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    while (nextNew < hunkNewStart && nextNew <= lines.length) {
      entries.push({ kind: "context", text: lines[nextNew - 1]!, newLine: nextNew, oldLine: fillOld, inHunk: false });
      record(fillOld);
      nextNew += 1;
      fillOld += 1;
    }
    const startEntry = entries.length;
    let oldLine = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.kind === "removed") {
        entries.push({ kind: "removed", text: line.text, newLine: null, oldLine, inHunk: true });
        record(oldLine);
        oldLine += 1;
        continue;
      }
      const documentText = lines[nextNew - 1];
      if (documentText === undefined) return null;
      if (line.kind === "context" && documentText !== line.text) return null;
      const text = line.kind === "added" ? line.text : documentText;
      const entryOldLine = line.kind === "context" ? oldLine : null;
      entries.push({ kind: line.kind, text, newLine: nextNew, oldLine: entryOldLine, inHunk: true });
      if (line.kind === "context") {
        record(oldLine);
        oldLine += 1;
      }
      nextNew += 1;
    }
    hunkEntryRanges.push({ start: startEntry, end: Math.max(startEntry, entries.length - 1) });
    fillOld = oldLine;
    if (entries.length > FULL_VIEW_MAX_ROWS) return null;
  }
  while (nextNew <= lines.length) {
    entries.push({ kind: "context", text: lines[nextNew - 1]!, newLine: nextNew, oldLine: fillOld, inHunk: false });
    record(fillOld);
    nextNew += 1;
    fillOld += 1;
  }
  if (entries.length > FULL_VIEW_MAX_ROWS) return null;
  return {
    entries,
    hunkEntryRanges,
    gutterWidthOld: String(Math.max(1, maxOldLine)).length,
    gutterWidthNew: String(Math.max(1, lines.length)).length,
  };
}

/** One side of a split row: what to print in that column, or null for a blank column. */
interface SplitCell {
  text: string;
  lineNumber: number;
  marker: " " | "+" | "-";
  tone: ExtensionFileViewSpan["tone"];
}

/** Render one column (gutter + marker + fitted text, padded to `colWidth`) as two spans. */
function renderColumn(cell: SplitCell | null, gutterWidth: number, colWidth: number): ExtensionFileViewSpan[] {
  const contentWidth = Math.max(0, colWidth - gutterWidth - 1);
  if (cell === null) {
    return [
      { text: " ".repeat(gutterWidth) + " ", tone: "muted" },
      { text: padText("", contentWidth) },
    ];
  }
  const gutterText = String(cell.lineNumber).padStart(gutterWidth) + " ";
  const fitted = fitText(cell.text, Math.max(0, contentWidth - 2), "…");
  const content = padText(`${cell.marker} ${fitted}`, contentWidth);
  return [
    { text: gutterText, tone: "muted" },
    cell.tone ? { text: content, tone: cell.tone } : { text: content },
  ];
}

/** Push one split row built from an optional old-side and new-side cell. */
function pushSplitRow(rows: ExtensionFileViewRow[], gutterWidthOld: number, gutterWidthNew: number, colWidth: number, left: SplitCell | null, right: SplitCell | null) {
  const spans: ExtensionFileViewSpan[] = [
    ...renderColumn(left, gutterWidthOld, colWidth),
    { text: " │ ", tone: "muted" },
    ...renderColumn(right, gutterWidthNew, colWidth),
  ];
  rows.push({ id: `full:${rows.length}`, spans });
}

/**
 * Two columns (old | new), following hunk's own resolved split layout.
 *
 * Runs `buildEntries` for the flattened file, then regroups each hunk's entries: a run of
 * removed lines immediately followed by a run of added lines pairs index-wise (leftovers get a
 * blank other side), and a context line inside or outside a hunk appears unchanged on both
 * sides. `sourceRanges` is attached only inside a hunk, on both sides for a paired or context
 * row and on the one present side for a leftover row.
 */
function buildSplitFileLayout(newDocument: string, hunks: readonly PatchHunk[], width: number): ExtensionFileViewLayout | null {
  const built = buildEntries(newDocument, hunks);
  if (built === null) return null;
  const { entries, hunkEntryRanges, gutterWidthOld, gutterWidthNew } = built;
  const colWidth = Math.floor((width - 3) / 2);
  const rows: ExtensionFileViewRow[] = [];
  const hunkRows: { startRow: number; endRow: number }[] = [];

  const contextCell = (entry: FullFileEntry, lineNumber: number): SplitCell => ({ text: entry.text, lineNumber, marker: " ", tone: undefined });
  const removedCell = (entry: FullFileEntry): SplitCell => ({ text: entry.text, lineNumber: entry.oldLine!, marker: "-", tone: "removed" });
  const addedCell = (entry: FullFileEntry): SplitCell => ({ text: entry.text, lineNumber: entry.newLine!, marker: "+", tone: "added" });

  /** Push one row and, when it falls inside a hunk, attach `sourceRanges` for the present side(s). */
  const emit = (left: SplitCell | null, right: SplitCell | null, inHunk: boolean, oldLine: number | null, newLine: number | null) => {
    pushSplitRow(rows, gutterWidthOld, gutterWidthNew, colWidth, left, right);
    if (!inHunk) return;
    const sourceRanges: { side: "old" | "new"; range: readonly [number, number] }[] = [];
    if (left !== null && oldLine !== null) sourceRanges.push({ side: "old", range: [oldLine, oldLine] });
    if (right !== null && newLine !== null) sourceRanges.push({ side: "new", range: [newLine, newLine] });
    if (sourceRanges.length > 0) rows[rows.length - 1] = { ...rows[rows.length - 1]!, sourceRanges };
  };

  let hunkIndex = 0;
  let i = 0;
  while (i < entries.length) {
    const range = hunkEntryRanges[hunkIndex];
    if (range && i === range.start) {
      const startRow = rows.length;
      while (i <= range.end) {
        const entry = entries[i]!;
        if (entry.kind === "context") {
          emit(contextCell(entry, entry.oldLine!), contextCell(entry, entry.newLine!), true, entry.oldLine, entry.newLine);
          i += 1;
          continue;
        }
        // A maximal removed run, followed (if present, with nothing else between) by a maximal
        // added run: pair them index-wise, leftovers get a blank other side.
        const removedStart = i;
        while (i <= range.end && entries[i]!.kind === "removed") i += 1;
        const removedRun = entries.slice(removedStart, i);
        const addedStart = i;
        while (i <= range.end && entries[i]!.kind === "added") i += 1;
        const addedRun = entries.slice(addedStart, i);
        const pairCount = Math.max(removedRun.length, addedRun.length);
        for (let p = 0; p < pairCount; p += 1) {
          const removedEntry = removedRun[p];
          const addedEntry = addedRun[p];
          emit(
            removedEntry ? removedCell(removedEntry) : null,
            addedEntry ? addedCell(addedEntry) : null,
            true,
            removedEntry?.oldLine ?? null,
            addedEntry?.newLine ?? null,
          );
        }
      }
      hunkRows.push({ startRow, endRow: Math.max(startRow, rows.length - 1) });
      hunkIndex += 1;
      continue;
    }
    // Context-fill entry outside any hunk: same text and marker on both sides, own line numbers.
    const entry = entries[i]!;
    emit(contextCell(entry, entry.oldLine!), contextCell(entry, entry.newLine!), false, null, null);
    i += 1;
  }

  if (rows.length > FULL_VIEW_MAX_ROWS) return null;
  return { rows, hunkRows };
}

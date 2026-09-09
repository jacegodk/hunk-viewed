import type {
  ExtensionFileViewCodeDocument,
  ExtensionFileViewLayout,
  ExtensionFileViewRow,
  ExtensionFileViewSpan,
  ExtensionFileViewSyntaxReference,
} from "hunkdiff/extension";
import { fitText, padText, textWidth } from "./sidebar/text";
import { findLineHits, sameHitLocation, type SearchHit } from "./search";
import type { PatchHunk } from "./unifiedPatch";

/** Id of the full-file presentation, qualified by hunk as `hunk-viewed:full`. */
export const FULL_VIEW_ID = "full";
/** Hunk's per-view row limit; a layout over it falls back to the raw diff. */
export const FULL_VIEW_MAX_ROWS = 10_000;
/** Below this terminal width, a split layout has no room for two usable columns; one column reads better. */
const MIN_SPLIT_WIDTH = 48;
/**
 * Hunk's layout validator caps (`src/ui/fileViews/layout.ts` in the hunk checkout): a layout with
 * more spans or text characters than these is rejected with a user-visible warning. A plain
 * single-column row stays well under both (2 spans), and a plain split row stays under both too
 * (5 spans, two per column plus the separator) — but search-hit splitting can add several spans
 * to any one row, so both builds count their exact totals and drop hit-splitting (then, for
 * split, drop the split presentation itself) rather than risk that warning on a large file with a
 * common query.
 */
const SPLIT_MAX_SPANS = 40_000;
const SPLIT_MAX_CHARS = 1_000_000;
/**
 * Hunk's code-document caps (API 24), aggregate over a layout's `codeDocuments`; a layout over
 * either is rejected outright, so the documents are trimmed to fit before they are declared.
 */
const CODE_DOCUMENT_MAX_LINES = 10_000;
const CODE_DOCUMENT_MAX_CHARS = 1_000_000;
/**
 * Terminal controls hunk strips from a code-document line before comparing a syntax span against
 * it, plus a lone CR, which hunk treats as a line break and this file does not. Either would move
 * the column ranges or line numbers the spans reference, so such a document gets no syntax paint.
 */
const UNSAFE_FOR_SYNTAX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\r(?!\n)/u;

/** Sum every row's span count across a built layout. */
function countSpans(rows: readonly ExtensionFileViewRow[]): number {
  return rows.reduce((sum, row) => sum + row.spans.length, 0);
}

/** Sum every row's total span text length across a built layout. */
function countChars(rows: readonly ExtensionFileViewRow[]): number {
  return rows.reduce((sum, row) => sum + row.spans.reduce((s, span) => s + span.text.length, 0), 0);
}

/** Whether a built layout's rows fit inside hunk's layout-validator caps. */
function withinLayoutCaps(rows: readonly ExtensionFileViewRow[]): boolean {
  return countSpans(rows) <= SPLIT_MAX_SPANS && countChars(rows) <= SPLIT_MAX_CHARS;
}

/** How to lay the file view out: hunk's own diff-column width, when known. */
export interface FullFileViewOptions {
  columns?: "single" | "split";
  width?: number;
  /** Active search query and current pick, so rows can mark hit text as they render. */
  hits?: { query: string; current: SearchHit | null };
  /**
   * The old-side document, when readable. Lets removed rows reference it for syntax paint; the
   * new side is always declared. Without it, removed rows keep their flat `removed` tone.
   */
  oldDocument?: string | null;
}

/** The code documents a layout declares for hunk's syntax paint, with their lines for exact-text checks. */
interface SyntaxDocuments {
  codeDocuments: ExtensionFileViewCodeDocument[];
  lines: { readonly new: readonly string[]; readonly old: readonly string[] | null };
}

/**
 * Decide which documents to declare: the new side, plus the old side when the caller read it. The
 * old side is dropped first, then syntax paint altogether, when hunk's aggregate line/length caps
 * would reject the layout; a document with controls hunk would strip gets no syntax paint either.
 */
function resolveSyntaxDocuments(newDocument: string, newLines: readonly string[], oldDocument: string | null | undefined): SyntaxDocuments | null {
  if (UNSAFE_FOR_SYNTAX.test(newDocument)) return null;
  const fits = (lineCount: number, ...texts: string[]) =>
    lineCount <= CODE_DOCUMENT_MAX_LINES && texts.reduce((sum, text) => sum + text.length, 0) <= CODE_DOCUMENT_MAX_CHARS;
  if (oldDocument != null && !UNSAFE_FOR_SYNTAX.test(oldDocument)) {
    const oldLines = documentLines(oldDocument);
    if (fits(newLines.length + oldLines.length, newDocument, oldDocument)) {
      return {
        codeDocuments: [
          { id: "new", text: newDocument },
          { id: "old", text: oldDocument },
        ],
        lines: { new: newLines, old: oldLines },
      };
    }
  }
  if (!fits(newLines.length, newDocument)) return null;
  return { codeDocuments: [{ id: "new", text: newDocument }], lines: { new: newLines, old: null } };
}

/**
 * A syntax reference for `text` shown at `(side, line)`, or undefined when hunk would reject it:
 * the side was not declared, or `text` is not exactly that document line (or `range` of it).
 * Hunk rejects the whole layout on a mismatch, so an unverifiable span is left unpainted instead.
 */
function syntaxRef(
  docs: SyntaxDocuments | null,
  side: "old" | "new",
  line: number,
  text: string,
  range?: readonly [number, number],
): ExtensionFileViewSyntaxReference | undefined {
  const sourceLine = docs?.lines[side]?.[line - 1];
  if (sourceLine === undefined) return undefined;
  if (range && range[1] > sourceLine.length) return undefined;
  if ((range ? sourceLine.slice(range[0], range[1]) : sourceLine) !== text) return undefined;
  return range ? { documentId: side, line, range } : { documentId: side, line };
}

/** A span of row content: toned like its row, and painted by hunk's highlighter when `syntax` resolves. */
function contentSpan(text: string, tone: ExtensionFileViewSpan["tone"], syntax?: ExtensionFileViewSyntaxReference): ExtensionFileViewSpan {
  return { text, ...(tone ? { tone } : {}), ...(syntax ? { syntax } : {}) };
}

/** Add `codeDocuments` to a built layout when syntax paint is on. */
function withCodeDocuments(layout: ExtensionFileViewLayout, docs: SyntaxDocuments | null): ExtensionFileViewLayout {
  return docs ? { ...layout, codeDocuments: docs.codeDocuments } : layout;
}

/** Whether `range` on `(side, line)` is the search's current pick, for the bold accent mark. */
function isCurrentHit(current: SearchHit | null | undefined, side: "old" | "new", line: number, range: readonly [number, number]): boolean {
  return !!current && sameHitLocation(current, { side, line, range });
}

/**
 * Split `text` into spans at every hit in `ranges` (already located in `text`): plain runs keep
 * `tone` and reference their slice of the source line for syntax paint, each hit becomes `accent`
 * (bold too for the current pick) with no syntax reference, so hunk's token color cannot override
 * the hit color. `text` must start at column 0 of the source line. Assumes `ranges` is non-empty;
 * callers fall back to a merged single span otherwise so unrelated rows are unchanged.
 */
function splitHitContentSpans(
  marker: string,
  text: string,
  tone: ExtensionFileViewSpan["tone"],
  side: "old" | "new",
  line: number,
  ranges: readonly (readonly [number, number])[],
  current: SearchHit | null | undefined,
  docs: SyntaxDocuments | null,
): ExtensionFileViewSpan[] {
  const spans: ExtensionFileViewSpan[] = [contentSpan(`${marker} `, tone)];
  const plain = (start: number, end: number) => contentSpan(text.slice(start, end), tone, syntaxRef(docs, side, line, text.slice(start, end), [start, end]));
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) spans.push(plain(cursor, start));
    spans.push(
      isCurrentHit(current, side, line, [start, end])
        ? { text: text.slice(start, end), tone: "accent", attributes: ["bold"] }
        : { text: text.slice(start, end), tone: "accent" },
    );
    cursor = end;
  }
  if (cursor < text.length) spans.push(plain(cursor, text.length));
  return spans;
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
    return buildSplitFileLayout(newDocument, hunks, options.width, options.hits, options.oldDocument);
  }
  return buildSingleFileLayout(newDocument, hunks, options?.hits, options?.oldDocument);
}

/** One full-width column, unlimited context, unchanged from the pre-split implementation. */
function buildSingleFileLayout(
  newDocument: string,
  hunks: readonly PatchHunk[],
  hits?: FullFileViewOptions["hits"],
  oldDocument?: string | null,
): ExtensionFileViewLayout | null {
  const lines = documentLines(newDocument);
  if (lines.length > FULL_VIEW_MAX_ROWS) return null;
  const docs = resolveSyntaxDocuments(newDocument, lines, oldDocument);
  const gutterWidth = String(Math.max(1, lines.length)).length;
  const rows: ExtensionFileViewRow[] = [];
  const hunkRows: { startRow: number; endRow: number }[] = [];

  const push = (kind: "context" | "added" | "removed", text: string, newLine: number | null, oldLine: number | null, inHunk: boolean) => {
    const number = newLine === null ? " ".repeat(gutterWidth) : String(newLine).padStart(gutterWidth);
    const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
    const tone: ExtensionFileViewSpan["tone"] | undefined = kind === "added" ? "added" : kind === "removed" ? "removed" : undefined;
    // Search hits attribute to the new side for context/added lines and the old side for
    // removed lines, exactly like `scanPatchHits`/`scanDocumentHits`.
    // A removed row's text is still checked against the query and painted when it matches, but
    // `scanDocumentHits` (the full-view hit count `n`/`p` navigate) only scans the new-side
    // document — a removed-line match is visible here but is not one of the navigable hits.
    const rowSide: "old" | "new" = kind === "removed" ? "old" : "new";
    const rowLine = kind === "removed" ? oldLine : newLine;
    const hitRanges = hits && rowLine !== null ? findLineHits(text, hits.query) : [];
    // The marker is its own span so the row's tone stays visible on it when syntax paint colors
    // the text; an empty line adds no content span.
    const spans: ExtensionFileViewSpan[] =
      hitRanges.length > 0
        ? [{ text: `${number} `, tone: "muted" }, ...splitHitContentSpans(marker, text, tone, rowSide, rowLine!, hitRanges, hits?.current, docs)]
        : [
            { text: `${number} `, tone: "muted" },
            contentSpan(`${marker} `, tone),
            ...(text === "" ? [] : [contentSpan(text, tone, rowLine === null ? undefined : syntaxRef(docs, rowSide, rowLine, text))]),
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
  // Hit-splitting can push any one row well past its plain 2-span shape; on a large file with a
  // common query that can cross hunk's layout caps, so drop hit-splitting and rebuild plain
  // rather than risk the warning hunk shows for an over-cap layout.
  if (hits && !withinLayoutCaps(rows)) return buildSingleFileLayout(newDocument, hunks, undefined, oldDocument);
  return withCodeDocuments({ rows, hunkRows }, docs);
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
  /** The new-side document's lines, as walked. */
  lines: readonly string[];
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
    // A pure-insertion hunk (oldCount 0) never advances the local `oldLine`: git's `oldStart` for
    // one names the line *before* the insertion point, not a line the hunk owns, so continuing
    // fill from `oldLine` would repeat that line's number (or print 0 for an insert at the very
    // start of the file). Mirrors the `hunkNewStart` adjustment above for the symmetric new-side case.
    fillOld = hunk.oldCount === 0 ? hunk.oldStart + 1 : oldLine;
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
    lines,
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

/**
 * Render one column (gutter + marker + fitted text, padded to `colWidth`).
 * `fitText` keeps a code-point prefix of the line and appends the one-unit `…` when it cuts, so
 * that prefix is still an exact slice of the source line hunk can paint; the marker and the
 * padding after it go in a trailing span of their own. Hits are located inside the kept prefix,
 * so a hit past the truncation point is simply not there to find.
 */
function renderColumn(
  cell: SplitCell | null,
  gutterWidth: number,
  colWidth: number,
  side: "old" | "new",
  hits: FullFileViewOptions["hits"],
  docs: SyntaxDocuments | null,
): ExtensionFileViewSpan[] {
  const contentWidth = Math.max(0, colWidth - gutterWidth - 1);
  if (cell === null) {
    return [
      { text: " ".repeat(gutterWidth) + " ", tone: "muted" },
      { text: padText("", contentWidth) },
    ];
  }
  const gutterText = String(cell.lineNumber).padStart(gutterWidth) + " ";
  const fitted = fitText(cell.text, Math.max(0, contentWidth - 2), "…");
  const truncated = fitted !== cell.text && fitted.endsWith("…");
  const kept = truncated ? fitted.slice(0, -1) : fitted;
  const hitRanges = hits ? findLineHits(kept, hits.query) : [];
  const contentSpans =
    hitRanges.length === 0
      ? [
          contentSpan(`${cell.marker} `, cell.tone),
          ...(kept === "" ? [] : [contentSpan(kept, cell.tone, syntaxRef(docs, side, cell.lineNumber, kept, kept === cell.text ? undefined : [0, kept.length]))]),
        ]
      : splitHitContentSpans(cell.marker, kept, cell.tone, side, cell.lineNumber, hitRanges, hits?.current, docs);
  const tail = (truncated ? "…" : "") + " ".repeat(Math.max(0, contentWidth - textWidth(`${cell.marker} ${fitted}`)));
  if (tail !== "") contentSpans.push(contentSpan(tail, cell.tone));
  return [{ text: gutterText, tone: "muted" }, ...contentSpans];
}

/** Push one split row built from an optional old-side and new-side cell. */
function pushSplitRow(
  rows: ExtensionFileViewRow[],
  gutterWidthOld: number,
  gutterWidthNew: number,
  colWidth: number,
  left: SplitCell | null,
  right: SplitCell | null,
  hits: FullFileViewOptions["hits"],
  docs: SyntaxDocuments | null,
) {
  const spans: ExtensionFileViewSpan[] = [
    ...renderColumn(left, gutterWidthOld, colWidth, "old", hits, docs),
    { text: " │ ", tone: "muted" },
    ...renderColumn(right, gutterWidthNew, colWidth, "new", hits, docs),
  ];
  rows.push({ id: `full:${rows.length}`, spans });
}

/**
 * Two columns (old | new), following hunk's own resolved split layout. Pure row construction —
 * `buildSplitFileLayout` below decides whether the result fits hunk's layout caps.
 *
 * Runs `buildEntries` for the flattened file, then regroups each hunk's entries: a run of
 * removed lines immediately followed by a run of added lines pairs index-wise (leftovers get a
 * blank other side), and a context line inside or outside a hunk appears unchanged on both
 * sides. `sourceRanges` is attached only inside a hunk, on both sides for a paired or context
 * row and on the one present side for a leftover row.
 */
function buildSplitRows(
  newDocument: string,
  hunks: readonly PatchHunk[],
  width: number,
  hits?: FullFileViewOptions["hits"],
  oldDocument?: string | null,
): ExtensionFileViewLayout | null {
  const built = buildEntries(newDocument, hunks);
  if (built === null) return null;
  const { entries, lines, hunkEntryRanges, gutterWidthOld, gutterWidthNew } = built;
  const docs = resolveSyntaxDocuments(newDocument, lines, oldDocument);
  const colWidth = Math.floor((width - 3) / 2);
  const rows: ExtensionFileViewRow[] = [];
  const hunkRows: { startRow: number; endRow: number }[] = [];

  const contextCell = (entry: FullFileEntry, lineNumber: number): SplitCell => ({ text: entry.text, lineNumber, marker: " ", tone: undefined });
  const removedCell = (entry: FullFileEntry): SplitCell => ({ text: entry.text, lineNumber: entry.oldLine!, marker: "-", tone: "removed" });
  const addedCell = (entry: FullFileEntry): SplitCell => ({ text: entry.text, lineNumber: entry.newLine!, marker: "+", tone: "added" });

  /** Push one row and, when it falls inside a hunk, attach `sourceRanges` for the present side(s). */
  const emit = (left: SplitCell | null, right: SplitCell | null, inHunk: boolean, oldLine: number | null, newLine: number | null) => {
    pushSplitRow(rows, gutterWidthOld, gutterWidthNew, colWidth, left, right, hits, docs);
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
        // added run: pair them index-wise, leftovers get a blank other side. Assumes removals
        // precede additions within a change, which is git's own unified-diff hunk order.
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
  return withCodeDocuments({ rows, hunkRows }, docs);
}

/**
 * `buildSplitRows` plus the layout-cap fallback chain: hit-splitting can push any row past its
 * plain shape (up to 9 spans), so first try with hits, then retry the same split columns without
 * hit-splitting, and only then give up the split presentation for a plain single column — a file
 * too big or a terminal too wide for two columns even without hits still needs that last step.
 */
function buildSplitFileLayout(
  newDocument: string,
  hunks: readonly PatchHunk[],
  width: number,
  hits?: FullFileViewOptions["hits"],
  oldDocument?: string | null,
): ExtensionFileViewLayout | null {
  const withHits = buildSplitRows(newDocument, hunks, width, hits, oldDocument);
  if (withHits === null) return null;
  if (withinLayoutCaps(withHits.rows)) return withHits;
  if (hits) {
    const withoutHits = buildSplitRows(newDocument, hunks, width, undefined, oldDocument);
    if (withoutHits !== null && withinLayoutCaps(withoutHits.rows)) return withoutHits;
  }
  return buildSingleFileLayout(newDocument, hunks, undefined, oldDocument);
}

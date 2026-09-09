import { describe, expect, test } from "bun:test";
import type { ExtensionFileViewLayout } from "hunkdiff/extension";
import { buildFullFileLayout } from "./fullFileView";
import { textWidth } from "./sidebar/text";
import { parseUnifiedPatch } from "./unifiedPatch";

/** Assert the two host invariants hunk's validator enforces on a file-view layout. */
function expectValidFileViewLayout(layout: ExtensionFileViewLayout, hunkCount: number) {
  expect(layout.hunkRows.length).toBe(hunkCount);
  expect(new Set(layout.rows.map((r) => r.id)).size).toBe(layout.rows.length);
  for (const { startRow, endRow } of layout.hunkRows) {
    expect(startRow).toBeGreaterThanOrEqual(0);
    expect(endRow).toBeGreaterThanOrEqual(startRow);
    expect(endRow).toBeLessThan(layout.rows.length);
  }
  layout.rows.forEach((row, index) => {
    if (!row.sourceRanges?.length) return;
    const owners = layout.hunkRows.filter((h) => index >= h.startRow && index <= h.endRow).length;
    expect(owners).toBe(1);
  });
  // API 24: every syntax span must name a declared document and equal exactly the referenced
  // line (or range of it), or hunk rejects the whole layout.
  const documents = new Map((layout.codeDocuments ?? []).map((doc) => [doc.id, doc.text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n")]));
  for (const span of layout.rows.flatMap((row) => row.spans)) {
    if (!span.syntax) continue;
    const lines = documents.get(span.syntax.documentId);
    expect(lines).toBeDefined();
    const line = lines![span.syntax.line - 1];
    expect(line).toBeDefined();
    const range = span.syntax.range;
    if (range) expect(range[1]).toBeLessThanOrEqual(line!.length);
    expect(span.text).toBe(range ? line!.slice(range[0], range[1]) : line!);
  }
}

/** Every span with a syntax reference, flattened over the layout's rows. */
function syntaxSpans(layout: ExtensionFileViewLayout) {
  return layout.rows.flatMap((row) => row.spans.filter((span) => span.syntax !== undefined));
}

const newDocument = ["line one", "line two changed", "line three", "line four", "line five", "line six"].join("\n") + "\n";
const patch = [
  "@@ -2,3 +2,3 @@",
  " line one",
  "-line two",
  "+line two changed",
  " line three",
  "@@ -6,1 +6,1 @@",
  " line six",
  "",
].join("\n");

function texts(layout: NonNullable<ReturnType<typeof buildFullFileLayout>>) {
  return layout.rows.map((row) => row.spans.map((span) => span.text).join(""));
}

describe("buildFullFileLayout", () => {
  test("rebuilds the whole file with removed lines at their hunk position", () => {
    const layout = buildFullFileLayout(newDocument, parseUnifiedPatch(patch.replace("-2,3 +2,3", "-1,3 +1,3")));
    expect(layout).not.toBeNull();
    expect(texts(layout!)).toEqual([
      "1   line one",
      "  - line two",
      "2 + line two changed",
      "3   line three",
      "4   line four",
      "5   line five",
      "6   line six",
    ]);
    expect(layout!.rows[1]!.spans.some((span) => span.tone === "removed")).toBe(true);
    expect(layout!.rows[2]!.spans.some((span) => span.tone === "added")).toBe(true);
    expect(layout!.rows[3]!.spans[1]!.tone).toBeUndefined();
    expect(layout!.rows[1]!.sourceRanges).toEqual([{ side: "old", range: [2, 2] }]);
    expect(layout!.rows[2]!.sourceRanges).toEqual([{ side: "new", range: [2, 2] }]);
    expect(layout!.hunkRows).toEqual([
      { startRow: 0, endRow: 3 },
      { startRow: 6, endRow: 6 },
    ]);
    // Rows 4 and 5 ("line four", "line five") sit between the two hunks, outside both ranges.
    expect(layout!.rows[4]!.sourceRanges).toBeUndefined();
    expect(layout!.rows[5]!.sourceRanges).toBeUndefined();
    expectValidFileViewLayout(layout!, 2);
  });

  test("gutter width follows the largest line number", () => {
    const doc = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const layout = buildFullFileLayout(doc, parseUnifiedPatch("@@ -1 +1 @@\n l1\n"));
    expect(texts(layout!)[0]).toBe(" 1   l1");
    expect(texts(layout!)[11]).toBe("12   l12");
    expectValidFileViewLayout(layout!, 1);
  });

  test("returns null when a context line disagrees with the document", () => {
    expect(buildFullFileLayout("other\n", parseUnifiedPatch("@@ -1 +1 @@\n line one\n"))).toBeNull();
  });

  test("returns null without hunks or when the row budget is exceeded", () => {
    expect(buildFullFileLayout(newDocument, [])).toBeNull();
    const huge = "x\n".repeat(10_001);
    expect(buildFullFileLayout(huge, parseUnifiedPatch("@@ -1 +1 @@\n x\n"))).toBeNull();
  });

  test("handles a file with no trailing newline and a pure deletion at the end", () => {
    const layout = buildFullFileLayout("a\nb", parseUnifiedPatch("@@ -2,2 +2 @@\n b\n-c\n"));
    expect(texts(layout!)).toEqual(["1   a", "2   b", "  - c"]);
    expectValidFileViewLayout(layout!, 1);
  });

  test("added rows show the patch text, not the document text at that line", () => {
    const layout = buildFullFileLayout("a\nDIFFERENT\n", parseUnifiedPatch("@@ -1,1 +1,2 @@\n a\n+b\n"));
    expect(layout).not.toBeNull();
    expect(texts(layout!)).toEqual(["1   a", "2 + b"]);
    expectValidFileViewLayout(layout!, 1);
  });

  test("returns null when a hunk has no lines", () => {
    const layout = buildFullFileLayout("a\nb\nc\n", parseUnifiedPatch("@@ -2,0 +2,0 @@\n@@ -3,1 +3,1 @@\n c\n"));
    expect(layout).toBeNull();
  });

  test("places a pure-deletion hunk (newCount 0) with no added or context lines of its own", () => {
    const layout = buildFullFileLayout("l1\nl2\nl5\n", parseUnifiedPatch("@@ -3,2 +2,0 @@\n-l3\n-l4\n"));
    expect(layout).not.toBeNull();
    expect(texts(layout!)).toEqual(["1   l1", "2   l2", "  - l3", "  - l4", "3   l5"]);
    expect(layout!.hunkRows).toEqual([{ startRow: 2, endRow: 3 }]);
    expectValidFileViewLayout(layout!, 1);
  });

  test("with no columns option (or columns: 'single' explicitly), output is identical to the default", () => {
    const hunks = parseUnifiedPatch(patch.replace("-2,3 +2,3", "-1,3 +1,3"));
    const bare = buildFullFileLayout(newDocument, hunks);
    const explicit = buildFullFileLayout(newDocument, hunks, { columns: "single" });
    expect(explicit).toEqual(bare);
  });
});

describe("buildFullFileLayout split columns", () => {
  const splitHunks = parseUnifiedPatch(patch.replace("-2,3 +2,3", "-1,3 +1,3"));

  test("renders two columns (old | new) separated by ' │ ', 48 wide (colWidth 22)", () => {
    const layout = buildFullFileLayout(newDocument, splitHunks, { columns: "split", width: 48 });
    expect(layout).not.toBeNull();
    expect(texts(layout!)).toEqual([
      "1   line one           │ 1   line one          ",
      "2 - line two           │ 2 + line two changed  ",
      "3   line three         │ 3   line three        ",
      "4   line four          │ 4   line four         ",
      "5   line five          │ 5   line five         ",
      "6   line six           │ 6   line six          ",
    ]);
    // The paired change row: left carries the removed text with a "-" marker, right the added
    // text with a "+" marker; marker, text, and padding are separate spans in the row's tone.
    expect(layout!.rows[1]!.spans).toEqual([
      { text: "2 ", tone: "muted" },
      { text: "- ", tone: "removed" },
      { text: "line two", tone: "removed" },
      { text: "          ", tone: "removed" },
      { text: " │ ", tone: "muted" },
      { text: "2 ", tone: "muted" },
      { text: "+ ", tone: "added" },
      { text: "line two changed", tone: "added", syntax: { documentId: "new", line: 2 } },
      { text: "  ", tone: "added" },
    ]);
    // A context row shows the same text on both sides.
    expect(layout!.rows[0]!.spans[2]!.text).toBe("line one");
    expect(layout!.rows[0]!.spans[7]!.text).toBe("line one");
    expectValidFileViewLayout(layout!, 2);
  });

  test("a run of 2 removed + 1 added pairs index-wise; the leftover removed row's right side is blank", () => {
    const layout = buildFullFileLayout("a\nx\nd\n", parseUnifiedPatch("@@ -2,2 +2,1 @@\n-b\n-c\n+x\n"), { columns: "split", width: 48 });
    expect(layout).not.toBeNull();
    expect(texts(layout!)).toEqual([
      "1   a                  │ 1   a                 ",
      "2 - b                  │ 2 + x                 ",
      "3 - c                  │                       ",
      "4   d                  │ 3   d                 ",
    ]);
    expect(layout!.rows[2]!.spans[5]).toEqual({ text: "  ", tone: "muted" });
    expect(layout!.rows[2]!.spans[6]).toEqual({ text: "                    " });
    expectValidFileViewLayout(layout!, 1);
  });

  test("falls back to the single-column output when the width leaves no room for two columns", () => {
    const single = buildFullFileLayout(newDocument, splitHunks);
    const tooNarrow = buildFullFileLayout(newDocument, splitHunks, { columns: "split", width: 10 });
    const belowMinSplitWidth = buildFullFileLayout(newDocument, splitHunks, { columns: "split", width: 47 });
    const missingWidth = buildFullFileLayout(newDocument, splitHunks, { columns: "split" });
    expect(tooNarrow).toEqual(single);
    expect(belowMinSplitWidth).toEqual(single);
    expect(missingWidth).toEqual(single);
  });

  test("pure-insertion hunk: old-side numbering resumes after the hunk's real old line, not oldStart", () => {
    // Insert "X","Y" between old lines 2 ("b") and 3 ("c"); oldStart 2 is the line *before* the
    // insertion, so the old side must continue from 3, not repeat 2.
    const layout = buildFullFileLayout("a\nb\nX\nY\nc\nd\n", parseUnifiedPatch("@@ -2,0 +3,2 @@\n+X\n+Y\n"), { columns: "split", width: 48 });
    expect(layout).not.toBeNull();
    const rowFor = (text: string) => layout!.rows.find((r) => r.spans.map((s) => s.text).join("").includes(text))!;
    expect(rowFor("c").spans[0]!.text.trim()).toBe("3");
    expect(rowFor("d").spans[0]!.text.trim()).toBe("4");
    expectValidFileViewLayout(layout!, 1);
  });

  test("pure-insertion hunk at the very start of the file: old side continues from 1, not 0", () => {
    const layout = buildFullFileLayout("X\nY\nc\nd\n", parseUnifiedPatch("@@ -0,0 +1,2 @@\n+X\n+Y\n"), { columns: "split", width: 48 });
    expect(layout).not.toBeNull();
    const rowFor = (text: string) => layout!.rows.find((r) => r.spans.map((s) => s.text).join("").includes(text))!;
    expect(rowFor("c").spans[0]!.text.trim()).toBe("1");
    expectValidFileViewLayout(layout!, 1);
  });

  test("two pure-insertion hunks in sequence: the old side hands off correctly across both", () => {
    // Insert "X" after old line 1 ("a"), then "Y" after old line 2 ("b").
    const layout = buildFullFileLayout(
      "a\nX\nb\nY\n",
      parseUnifiedPatch("@@ -1,0 +2,1 @@\n+X\n@@ -2,0 +4,1 @@\n+Y\n"),
      { columns: "split", width: 48 },
    );
    expect(layout).not.toBeNull();
    const rowFor = (text: string) => layout!.rows.find((r) => r.spans.map((s) => s.text).join("").includes(text))!;
    expect(rowFor("a").spans[0]!.text.trim()).toBe("1");
    expect(rowFor("b").spans[0]!.text.trim()).toBe("2");
    expectValidFileViewLayout(layout!, 2);
  });

  test("a CJK line never pushes a split row over its declared width in display cells", () => {
    // Below MIN_SPLIT_WIDTH (48) this would fall back to single column; use the threshold itself
    // so the assertion still exercises real split rendering.
    const width = 48;
    const layout = buildFullFileLayout(
      "before\n日本語のテキスト行\nafter\n",
      parseUnifiedPatch("@@ -2,1 +2,1 @@\n-old line\n+日本語のテキスト行\n"),
      { columns: "split", width },
    );
    expect(layout).not.toBeNull();
    for (const row of layout!.rows) {
      const cells = row.spans.reduce((sum, span) => sum + textWidth(span.text), 0);
      expect(cells).toBeLessThanOrEqual(width);
    }
    expectValidFileViewLayout(layout!, 1);
  });

  test("falls back to single-column when the split layout would exceed hunk's span/char budget", () => {
    const bigLines = Array.from({ length: 5100 }, (_, i) => `line ${i + 1}`);
    bigLines[0] = "changed";
    const bigDoc = bigLines.join("\n") + "\n";
    const bigHunk = parseUnifiedPatch("@@ -1,1 +1,1 @@\n-line 1\n+changed\n");
    const wide = buildFullFileLayout(bigDoc, bigHunk, { columns: "split", width: 200 });
    expect(wide).not.toBeNull();
    // Falls back: the same rows the single-column build would produce, so no separator appears.
    expect(texts(wide!).some((t) => t.includes(" │ "))).toBe(false);
    expect(wide).toEqual(buildFullFileLayout(bigDoc, bigHunk));

    const smallDoc = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const small = buildFullFileLayout(smallDoc.replace("line 1", "changed"), bigHunk, { columns: "split", width: 200 });
    expect(small).not.toBeNull();
    expect(texts(small!).some((t) => t.includes(" │ "))).toBe(true);
  });
});

describe("buildFullFileLayout search hits", () => {
  test("single column: an empty query or no hits option leaves the merged content span untouched", () => {
    const doc = "nomatch here\n";
    const hunks = parseUnifiedPatch("@@ -1,1 +1,1 @@\n nomatch here\n");
    const withoutOption = buildFullFileLayout(doc, hunks);
    const emptyQuery = buildFullFileLayout(doc, hunks, { hits: { query: "", current: null } });
    const noMatch = buildFullFileLayout(doc, hunks, { hits: { query: "zzz", current: null } });
    expect(emptyQuery).toEqual(withoutOption);
    expect(noMatch).toEqual(withoutOption);
  });

  test("single column: a hit splits into its own accent span, bold for the current pick", () => {
    const doc = "foo bar\nbaz foo\n";
    const hunks = parseUnifiedPatch("@@ -1,2 +1,2 @@\n foo bar\n baz foo\n");
    const layout = buildFullFileLayout(doc, hunks, {
      hits: { query: "foo", current: { fileId: "x", filePath: "a.ts", side: "new", line: 2, range: [4, 7] } },
    });
    expect(layout).not.toBeNull();
    // Line 1's "foo" matches but is not the current pick (that's line 2's). The plain runs around
    // a hit reference their slice of the source line; the hit itself carries no reference, so
    // hunk's token color cannot override the accent.
    expect(layout!.rows[0]!.spans).toEqual([
      { text: "1 ", tone: "muted" },
      { text: "  " },
      { text: "foo", tone: "accent" },
      { text: " bar", syntax: { documentId: "new", line: 1, range: [3, 7] } },
    ]);
    // Line 2's "foo" is the current pick: accent and bold.
    expect(layout!.rows[1]!.spans).toEqual([
      { text: "2 ", tone: "muted" },
      { text: "  " },
      { text: "baz ", syntax: { documentId: "new", line: 2, range: [0, 4] } },
      { text: "foo", tone: "accent", attributes: ["bold"] },
    ]);
    expectValidFileViewLayout(layout!, 1);
  });

  test("split columns: a hit splits on both sides independently, bold only on the current pick's side", () => {
    const doc = "foo bar\n";
    const hunks = parseUnifiedPatch("@@ -1,1 +1,1 @@\n-old foo\n+foo bar\n");
    const layout = buildFullFileLayout(doc, hunks, {
      columns: "split",
      width: 48,
      hits: { query: "foo", current: { fileId: "x", filePath: "a.ts", side: "new", line: 1, range: [0, 3] } },
    });
    expect(layout).not.toBeNull();
    // Left (old side, "old foo" removed): a match, but not the current pick (that lives on "new").
    expect(layout!.rows[0]!.spans.slice(0, 5)).toEqual([
      { text: "1 ", tone: "muted" },
      { text: "- ", tone: "removed" },
      { text: "old ", tone: "removed" },
      { text: "foo", tone: "accent" },
      { text: "           ", tone: "removed" },
    ]);
    // Right (new side, "foo bar" added): the current pick, so bold.
    expect(layout!.rows[0]!.spans.slice(6)).toEqual([
      { text: "1 ", tone: "muted" },
      { text: "+ ", tone: "added" },
      { text: "foo", tone: "accent", attributes: ["bold"] },
      { text: " bar", tone: "added", syntax: { documentId: "new", line: 1, range: [3, 7] } },
      { text: "           ", tone: "added" },
    ]);
    expect(layout!.rows[0]!.spans[5]).toEqual({ text: " │ ", tone: "muted" });
    expectValidFileViewLayout(layout!, 1);
  });

  test("single column: hit-splitting that would exceed hunk's span cap falls back to the hit-free build", () => {
    // Every row matches "a" 50 times over (worst case: no gap between hits), so hit-splitting
    // alone pushes the exact span count well past SPLIT_MAX_SPANS (40,000) while the plain
    // 2-spans-per-row build (18,000 spans over 9,000 rows) stays comfortably under it.
    const bigLines = Array.from({ length: 9000 }, () => "a".repeat(50));
    bigLines[0] = "changed";
    const bigDoc = bigLines.join("\n") + "\n";
    const bigHunk = parseUnifiedPatch(`@@ -1,1 +1,1 @@\n-${"a".repeat(50)}\n+changed\n`);
    const withHits = buildFullFileLayout(bigDoc, bigHunk, { hits: { query: "a", current: null } });
    const withoutHits = buildFullFileLayout(bigDoc, bigHunk);
    expect(withHits).not.toBeNull();
    expect(withHits!.rows.some((row) => row.spans.some((span) => span.tone === "accent"))).toBe(false);
    expect(withHits).toEqual(withoutHits);
    expectValidFileViewLayout(withHits!, 1);
  });

  test("split columns: hit-splitting that would exceed hunk's span cap falls back to the hit-free split build (not single column)", () => {
    // Every row matches "foo" once; hit-splitting's ~11 spans/row over 4,000 rows (44,000) crosses
    // the cap, but the plain split shape (5 spans/row, 20,000) stays under it — so the fallback
    // should keep the split presentation and only drop the hit spans.
    const bigLines = Array.from({ length: 4000 }, (_, i) => `foo line ${i + 1}`);
    bigLines[0] = "changed";
    const bigDoc = bigLines.join("\n") + "\n";
    const bigHunk = parseUnifiedPatch("@@ -1,1 +1,1 @@\n-foo line 1\n+changed\n");
    const withHits = buildFullFileLayout(bigDoc, bigHunk, { columns: "split", width: 200, hits: { query: "foo", current: null } });
    const withoutHits = buildFullFileLayout(bigDoc, bigHunk, { columns: "split", width: 200 });
    expect(withHits).not.toBeNull();
    expect(texts(withHits!).some((t) => t.includes(" │ "))).toBe(true);
    expect(withHits!.rows.some((row) => row.spans.some((span) => span.tone === "accent"))).toBe(false);
    expect(withHits).toEqual(withoutHits);
    expectValidFileViewLayout(withHits!, 1);
  });
});

describe("buildFullFileLayout syntax paint (API 24)", () => {
  const oldDocument = ["line one", "line two", "line three", "line four", "line five", "line six"].join("\n") + "\n";
  const hunks = parseUnifiedPatch(patch.replace("-2,3 +2,3", "-1,3 +1,3"));

  test("single column: declares the new document; context and added rows reference it, removed rows stay flat without an old document", () => {
    const layout = buildFullFileLayout(newDocument, hunks);
    expect(layout).not.toBeNull();
    expect(layout!.codeDocuments).toEqual([{ id: "new", text: newDocument }]);
    // Context row 1: gutter, marker, text referencing new line 1.
    expect(layout!.rows[0]!.spans).toEqual([{ text: "1 ", tone: "muted" }, { text: "  " }, { text: "line one", syntax: { documentId: "new", line: 1 } }]);
    // Removed row: no old document, so no reference; tone kept on marker and text.
    expect(layout!.rows[1]!.spans).toEqual([{ text: "  ", tone: "muted" }, { text: "- ", tone: "removed" }, { text: "line two", tone: "removed" }]);
    // Added row: toned, and referencing the new line it shows.
    expect(layout!.rows[2]!.spans).toEqual([
      { text: "2 ", tone: "muted" },
      { text: "+ ", tone: "added" },
      { text: "line two changed", tone: "added", syntax: { documentId: "new", line: 2 } },
    ]);
    expect(syntaxSpans(layout!)).toHaveLength(6);
    expectValidFileViewLayout(layout!, 2);
  });

  test("with the old document, removed rows reference it; a removed line the old document does not contain stays flat", () => {
    const layout = buildFullFileLayout(newDocument, hunks, { oldDocument });
    expect(layout).not.toBeNull();
    expect(layout!.codeDocuments).toEqual([
      { id: "new", text: newDocument },
      { id: "old", text: oldDocument },
    ]);
    expect(layout!.rows[1]!.spans[2]).toEqual({ text: "line two", tone: "removed", syntax: { documentId: "old", line: 2 } });
    expectValidFileViewLayout(layout!, 2);

    // The patch says old line 2 was "line two", but this old document disagrees: no reference,
    // rather than a reference hunk would reject the layout over.
    const stale = buildFullFileLayout(newDocument, hunks, { oldDocument: oldDocument.replace("line two", "something else") });
    expect(stale).not.toBeNull();
    expect(stale!.rows[1]!.spans[2]).toEqual({ text: "line two", tone: "removed" });
    expectValidFileViewLayout(stale!, 2);
  });

  test("an empty line gets no content span", () => {
    const layout = buildFullFileLayout("a\n\nb\n", parseUnifiedPatch("@@ -1,3 +1,3 @@\n a\n \n b\n"));
    expect(layout).not.toBeNull();
    expect(layout!.rows[1]!.spans).toEqual([{ text: "2 ", tone: "muted" }, { text: "  " }]);
    expectValidFileViewLayout(layout!, 1);
  });

  test("split columns: a truncated line references its kept prefix by range and keeps the ellipsis outside the reference", () => {
    const long = "const value = someFunction(argumentOne, argumentTwo);";
    const layout = buildFullFileLayout(`${long}\nshort\n`, parseUnifiedPatch("@@ -2,1 +2,1 @@\n-old\n+short\n"), {
      columns: "split",
      width: 48,
      oldDocument: `${long}\nold\n`,
    });
    expect(layout).not.toBeNull();
    const kept = long.slice(0, 17);
    // Row 0 is the long context line on both sides. Left (old) column, contentWidth 20: marker +
    // space + 17 kept characters + "…" in the trailing span.
    expect(layout!.rows[0]!.spans.slice(1, 4)).toEqual([
      { text: "  " },
      { text: kept, syntax: { documentId: "old", line: 1, range: [0, 17] } },
      { text: "…" },
    ]);
    // Right (new) column: the same line on the new side, same shape.
    expect(layout!.rows[0]!.spans[7]).toEqual({ text: kept, syntax: { documentId: "new", line: 1, range: [0, 17] } });
    // Row 1: a removed and an added line that both fit reference their whole line, no range.
    expect(layout!.rows[1]!.spans[2]).toEqual({ text: "old", tone: "removed", syntax: { documentId: "old", line: 2 } });
    expect(layout!.rows[1]!.spans[7]).toEqual({ text: "short", tone: "added", syntax: { documentId: "new", line: 2 } });
    expectValidFileViewLayout(layout!, 1);
  });

  test("drops the old document, then all syntax paint, when hunk's aggregate document caps would reject the layout", () => {
    // 6,000 + 6,000 lines exceeds the 10,000-line aggregate: only the new side is declared.
    const bigLines = Array.from({ length: 6000 }, (_, i) => `line ${i + 1}`);
    const bigOld = bigLines.join("\n") + "\n";
    bigLines[0] = "changed";
    const bigNew = bigLines.join("\n") + "\n";
    const hunk = parseUnifiedPatch("@@ -1,1 +1,1 @@\n-line 1\n+changed\n");
    const newOnly = buildFullFileLayout(bigNew, hunk, { oldDocument: bigOld });
    expect(newOnly).not.toBeNull();
    expect(newOnly!.codeDocuments?.map((doc) => doc.id)).toEqual(["new"]);
    expect(newOnly!.rows[0]!.spans[2]).toEqual({ text: "line 1", tone: "removed" });
    expect(newOnly!.rows[1]!.spans[2]!.syntax).toEqual({ documentId: "new", line: 1 });
    expectValidFileViewLayout(newOnly!, 1);

    // A new document over 1,000,000 UTF-16 units cannot be declared at all: no documents, no references.
    const hugeNew = `changed\n${"x".repeat(1_000_000)}\n`;
    const none = buildFullFileLayout(hugeNew, hunk);
    expect(none).not.toBeNull();
    expect(none!.codeDocuments).toBeUndefined();
    expect(syntaxSpans(none!)).toHaveLength(0);
    expect(none!.rows[1]!.spans[2]).toEqual({ text: "changed", tone: "added" });
  });

  test("a document with terminal controls or lone carriage returns gets no syntax paint", () => {
    const hunk = parseUnifiedPatch("@@ -1,1 +1,1 @@\n-a\n+b\n");
    const controls = buildFullFileLayout("b\nc\x1b[31md\n", hunk);
    expect(controls).not.toBeNull();
    expect(controls!.codeDocuments).toBeUndefined();
    expect(syntaxSpans(controls!)).toHaveLength(0);
    const loneCr = buildFullFileLayout("b\nc\rd\n", hunk);
    expect(loneCr).not.toBeNull();
    expect(loneCr!.codeDocuments).toBeUndefined();
    // An unsafe old document alone only costs the old side.
    const unsafeOld = buildFullFileLayout("b\n", hunk, { oldDocument: "a\x07\n" });
    expect(unsafeOld!.codeDocuments?.map((doc) => doc.id)).toEqual(["new"]);
  });
});

import { describe, expect, test } from "bun:test";
import type { ExtensionFileViewLayout } from "hunkdiff/extension";
import { buildFullFileLayout } from "./fullFileView";
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

  test("renders two columns (old | new) separated by ' │ ', 41 wide (colWidth 19)", () => {
    const layout = buildFullFileLayout(newDocument, splitHunks, { columns: "split", width: 41 });
    expect(layout).not.toBeNull();
    expect(texts(layout!)).toEqual([
      "1   line one        │ 1   line one       ",
      "2 - line two        │ 2 + line two chang…",
      "3   line three      │ 3   line three     ",
      "4   line four       │ 4   line four      ",
      "5   line five       │ 5   line five      ",
      "6   line six        │ 6   line six       ",
    ]);
    // Confirmed against a probe run of buildFullFileLayout at width 41 (colWidth 19); see spans
    // assertions below for the exact tone split.
    // The paired change row: left carries the removed text with a "-" marker, right the added
    // text with a "+" marker.
    expect(layout!.rows[1]!.spans[1]).toEqual({ text: "- line two       ", tone: "removed" });
    expect(layout!.rows[1]!.spans[4]).toEqual({ text: "+ line two chang…", tone: "added" });
    // A context row shows the same text on both sides.
    expect(layout!.rows[0]!.spans[1]!.text.trim()).toBe("line one");
    expect(layout!.rows[0]!.spans[4]!.text.trim()).toBe("line one");
    expectValidFileViewLayout(layout!, 2);
  });

  test("a run of 2 removed + 1 added pairs index-wise; the leftover removed row's right side is blank", () => {
    const layout = buildFullFileLayout("a\nx\nd\n", parseUnifiedPatch("@@ -2,2 +2,1 @@\n-b\n-c\n+x\n"), { columns: "split", width: 41 });
    expect(layout).not.toBeNull();
    expect(texts(layout!)).toEqual([
      "1   a               │ 1   a              ",
      "2 - b               │ 2 + x              ",
      "3 - c               │                    ",
      "4   d               │ 3   d              ",
    ]);
    expect(layout!.rows[2]!.spans[3]).toEqual({ text: "  ", tone: "muted" });
    expect(layout!.rows[2]!.spans[4]).toEqual({ text: "                 " });
    expectValidFileViewLayout(layout!, 1);
  });

  test("falls back to the single-column output when the width leaves no room for two columns", () => {
    const single = buildFullFileLayout(newDocument, splitHunks);
    const tooNarrow = buildFullFileLayout(newDocument, splitHunks, { columns: "split", width: 10 });
    const missingWidth = buildFullFileLayout(newDocument, splitHunks, { columns: "split" });
    expect(tooNarrow).toEqual(single);
    expect(missingWidth).toEqual(single);
  });
});

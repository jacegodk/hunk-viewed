import { describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import { buildFoldedLayout } from "./foldedView";

function file(hunkCount: number, additions = 11, deletions = 0): ExtensionDiffFile {
  return {
    id: "1",
    path: "src/a.ts",
    patch: "",
    stats: { additions, deletions },
    metadata: {},
    agent: null,
    hunks: Array.from({ length: hunkCount }, (_, index) => ({ index, header: `@@ ${index} @@` })) as ExtensionDiffFile["hunks"],
  };
}

describe("buildFoldedLayout", () => {
  test("folds a file with hunks to one row that every hunk maps to", () => {
    const layout = buildFoldedLayout(file(3));
    expect(layout.rows.length).toBe(1);
    expect(layout.hunkRows).toEqual([
      { startRow: 0, endRow: 0 },
      { startRow: 0, endRow: 0 },
      { startRow: 0, endRow: 0 },
    ]);
    const text = layout.rows[0]!.spans.map((span) => span.text).join("");
    expect(text).toBe("✓ viewed  3 hunks  +11 -0");
    expect(layout.rows[0]!.spans[0]).toEqual({ text: "✓ ", tone: "added" });
    expect(layout.rows[0]!.spans.slice(1).every((span) => span.tone === "muted")).toBe(true);
  });

  test("uses singular hunk and shows truncated stats", () => {
    const layout = buildFoldedLayout({ ...file(1, 3, 2), statsTruncated: true });
    expect(layout.rows[0]!.spans.map((span) => span.text).join("")).toBe("✓ viewed  1 hunk  +3+ -2");
  });

  test("folds a file without hunks to nothing", () => {
    expect(buildFoldedLayout(file(0))).toEqual({ rows: [], hunkRows: [] });
  });
});

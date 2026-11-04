import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import {
  clearSearch,
  closePrompt,
  currentHit,
  editDraft,
  findLineHits,
  getSearchState,
  hasGapHitsFor,
  openPrompt,
  pruneSearchFiles,
  rebuildHits,
  resetSearchForTests,
  scanDocumentHits,
  scanGapHits,
  scanPatchHits,
  setDocumentHits,
  setFullViewFile,
  setGapHits,
  setQuery,
  stepHit,
} from "./search";

function file(id: string, path: string, patch: string): ExtensionDiffFile {
  return { id, path, patch, stats: { additions: 0, deletions: 0 }, metadata: {}, agent: null };
}

beforeEach(() => resetSearchForTests());

describe("findLineHits", () => {
  test("is case-insensitive and finds every occurrence", () => {
    expect(findLineHits("Foo foo FOO", "foo")).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ]);
  });

  test("does not overlap: 'aa' in 'aaa' is one range", () => {
    expect(findLineHits("aaa", "aa")).toEqual([[0, 2]]);
  });

  test("empty query yields no hits", () => {
    expect(findLineHits("anything", "")).toEqual([]);
  });

  test("no match yields no hits", () => {
    expect(findLineHits("hello", "xyz")).toEqual([]);
  });
});

const twoHunkPatch = [
  "@@ -1,3 +1,4 @@",
  " const a = foo;",
  "-const b = foo;",
  "+const b = foo;",
  "+const c = foo;",
  " const d = 5;",
  "@@ -10,1 +11,2 @@",
  " return foo;",
  "+return foo again;",
].join("\n");

describe("scanPatchHits", () => {
  test("attributes context/added lines to the new side and removed lines to the old side", () => {
    const f = file("f1", "a.ts", twoHunkPatch);
    const hits = scanPatchHits(f, "foo");
    expect(hits).toEqual([
      { fileId: "f1", filePath: "a.ts", side: "new", line: 1, range: [10, 13] }, // context "const a = foo;"
      { fileId: "f1", filePath: "a.ts", side: "old", line: 2, range: [10, 13] }, // removed "const b = foo;"
      { fileId: "f1", filePath: "a.ts", side: "new", line: 2, range: [10, 13] }, // added "const b = foo;"
      { fileId: "f1", filePath: "a.ts", side: "new", line: 3, range: [10, 13] }, // added "const c = foo;"
      { fileId: "f1", filePath: "a.ts", side: "new", line: 11, range: [7, 10] }, // context "return foo;"
      { fileId: "f1", filePath: "a.ts", side: "new", line: 12, range: [7, 10] }, // added "return foo again;"
    ]);
  });

  test("empty query yields no hits", () => {
    const f = file("f1", "a.ts", twoHunkPatch);
    expect(scanPatchHits(f, "")).toEqual([]);
  });

  test("empty patch yields no hits", () => {
    const f = file("f1", "a.ts", "");
    expect(scanPatchHits(f, "foo")).toEqual([]);
  });
});

describe("scanDocumentHits", () => {
  test("scans every line of the new-side document", () => {
    const f = { id: "f1", path: "a.ts" };
    const document = ["one foo", "two", "three foo foo"].join("\n") + "\n";
    expect(scanDocumentHits(f, document, "foo")).toEqual([
      { fileId: "f1", filePath: "a.ts", side: "new", line: 1, range: [4, 7] },
      { fileId: "f1", filePath: "a.ts", side: "new", line: 3, range: [6, 9] },
      { fileId: "f1", filePath: "a.ts", side: "new", line: 3, range: [10, 13] },
    ]);
  });

  test("empty query yields no hits", () => {
    const f = { id: "f1", path: "a.ts" };
    expect(scanDocumentHits(f, "foo\n", "")).toEqual([]);
  });
});

describe("scanGapHits", () => {
  const patch = [
    "@@ -2,3 +2,3 @@",
    " in hunk one",
    "+added in hunk one",
    " still hunk one",
    "@@ -6,1 +6,1 @@",
    "-old removed",
    "+in hunk two",
  ].join("\n");

  test("keeps only matches on new-side lines no hunk renders, marked outside", () => {
    const f = file("f1", "a.ts", patch);
    const document = [
      "gap before hunk one", // line 1: leading gap
      "in hunk one", // line 2: hunk one context — excluded
      "added in hunk one", // line 3: hunk one added — excluded
      "still hunk one", // line 4: hunk one context — excluded
      "gap foo after hunk one", // line 5: between the hunks
      "in hunk two", // line 6: hunk two added — excluded
      "trailing gap foo", // line 7: after the last hunk
    ].join("\n") + "\n";
    expect(scanGapHits(f, document, "foo")).toEqual([
      { fileId: "f1", filePath: "a.ts", side: "new", line: 5, range: [4, 7] },
      { fileId: "f1", filePath: "a.ts", side: "new", line: 7, range: [13, 16] },
    ]);
  });

  test("a pure-deletion hunk renders no new-side line, so the line it names is a gap", () => {
    const f = file("f1", "a.ts", "@@ -5,2 +4,0 @@\n-gone one\n-gone two\n");
    const document = ["before", "the named line gone", "after"].join("\n") + "\n";
    // New-side line 2 renders as context before the deletion hunk's rows: a gap line.
    expect(scanGapHits(f, document, "gone")).toEqual([
      { fileId: "f1", filePath: "a.ts", side: "new", line: 2, range: [15, 19] },
    ]);
  });

  test("empty query yields no hits", () => {
    const f = file("f1", "a.ts", patch);
    expect(scanGapHits(f, "anything\n", "")).toEqual([]);
  });
});

describe("prompt draft ops", () => {
  test("openPrompt, editDraft, closePrompt", () => {
    openPrompt("start");
    expect(getSearchState().prompt).toEqual({ open: true, draft: "start" });
    editDraft("started");
    expect(getSearchState().prompt).toEqual({ open: true, draft: "started" });
    closePrompt();
    expect(getSearchState().prompt.open).toBe(false);
  });
});

describe("setQuery", () => {
  test("clears hits and resets index to -1 without rebuilding", () => {
    setQuery("foo");
    expect(getSearchState()).toMatchObject({ query: "foo", hits: [], currentIndex: -1 });
  });

  test("setQuery('') equals clearSearch()", () => {
    openPrompt("foo");
    setQuery("something");
    setQuery("");
    const afterEmptyQuery = getSearchState();
    openPrompt("foo");
    setQuery("something");
    clearSearch();
    const afterClear = getSearchState();
    expect(afterEmptyQuery).toEqual(afterClear);
  });
});

describe("setFullViewFile", () => {
  test("sets membership directly instead of toggling", () => {
    setFullViewFile("f1", true);
    expect(getSearchState().fullViewFileIds.has("f1")).toBe(true);
    setFullViewFile("f1", true); // idempotent
    expect(getSearchState().fullViewFileIds.has("f1")).toBe(true);
    setFullViewFile("f1", false);
    expect(getSearchState().fullViewFileIds.has("f1")).toBe(false);
  });
});

describe("setDocumentHits", () => {
  test("returns true the first time a file reports hits", () => {
    expect(setDocumentHits("f1", [{ fileId: "f1", filePath: "a.ts", side: "new", line: 1, range: [0, 3] }])).toBe(true);
  });

  test("returns false when the reported hits are the same (by side/line/range) as before", () => {
    const hits = [{ fileId: "f1", filePath: "a.ts", side: "new" as const, line: 1, range: [0, 3] as const }];
    setDocumentHits("f1", hits);
    // A fresh array with the same side/line/range content is not a change.
    expect(setDocumentHits("f1", [{ ...hits[0]! }])).toBe(false);
  });

  test("returns true when the count or any hit's side/line/range differs", () => {
    setDocumentHits("f1", [{ fileId: "f1", filePath: "a.ts", side: "new", line: 1, range: [0, 3] }]);
    expect(setDocumentHits("f1", [])).toBe(true);
    setDocumentHits("f1", [{ fileId: "f1", filePath: "a.ts", side: "new", line: 1, range: [0, 3] }]);
    expect(setDocumentHits("f1", [{ fileId: "f1", filePath: "a.ts", side: "new", line: 2, range: [0, 3] }])).toBe(true);
  });
});

describe("pruneSearchFiles", () => {
  test("drops fullViewFileIds and document hits for files no longer in the changeset", () => {
    setFullViewFile("a", true);
    setFullViewFile("b", true);
    setDocumentHits("a", [{ fileId: "a", filePath: "a.ts", side: "new", line: 1, range: [0, 3] }]);
    setDocumentHits("b", [{ fileId: "b", filePath: "b.ts", side: "new", line: 1, range: [0, 3] }]);

    pruneSearchFiles(["b"]); // only "b" survives the reload

    expect(getSearchState().fullViewFileIds).toEqual(new Set(["b"]));
    // "a"'s document hits are gone: rebuilding with "a" back in the visible set (a fresh object,
    // as a reload would give it) reports no full-view hits for it even though it is still marked.
    setFullViewFile("a", true);
    rebuildHits([file("a", "a.ts", "@@ -1,1 +1,1 @@\n foo\n")]);
    expect(getSearchState().hits).toEqual([]);
  });

  test("is a no-op (no republish) when nothing needs pruning", () => {
    setFullViewFile("a", true);
    const before = getSearchState();
    pruneSearchFiles(["a", "b"]);
    expect(getSearchState()).toBe(before);
  });
});

describe("rebuildHits", () => {
  const fileA = file("a", "a.ts", ["@@ -1,1 +1,1 @@", "-foo", "+foo bar"].join("\n"));
  const fileB = file("b", "b.ts", ["@@ -1,1 +1,1 @@", " foo baz"].join("\n"));

  test("merges patch and document hits in visible-file order", () => {
    setFullViewFile("b", true);
    setDocumentHits("b", [{ fileId: "b", filePath: "b.ts", side: "new", line: 5, range: [0, 3] }]);
    setQuery("foo");
    rebuildHits([fileA, fileB]);
    const state = getSearchState();
    expect(state.hits).toEqual([
      { fileId: "a", filePath: "a.ts", side: "old", line: 1, range: [0, 3] },
      { fileId: "a", filePath: "a.ts", side: "new", line: 1, range: [0, 3] },
      { fileId: "b", filePath: "b.ts", side: "new", line: 5, range: [0, 3] },
    ]);
    expect(state.currentIndex).toBe(0);
  });

  test("merges a file's out-of-diff hits into its patch hits in line order", () => {
    const gapBefore = file("c", "c.ts", "@@ -3,1 +3,1 @@\n foo in hunk\n");
    setGapHits(gapBefore, "foo", [
      { fileId: "c", filePath: "c.ts", side: "new", line: 1, range: [0, 3] },
      { fileId: "c", filePath: "c.ts", side: "new", line: 9, range: [0, 3] },
    ]);
    setQuery("foo");
    rebuildHits([gapBefore]);
    expect(getSearchState().hits).toEqual([
      { fileId: "c", filePath: "c.ts", side: "new", line: 1, range: [0, 3] },
      { fileId: "c", filePath: "c.ts", side: "new", line: 3, range: [0, 3] }, // the hunk's context hit
      { fileId: "c", filePath: "c.ts", side: "new", line: 9, range: [0, 3] },
    ]);
  });

  test("a full-view file ignores its stored gap hits (documentHits already cover the document)", () => {
    const f = file("a", "a.ts", "@@ -1,1 +1,1 @@\n foo\n");
    setGapHits(f, "foo", [{ fileId: "a", filePath: "a.ts", side: "new", line: 9, range: [0, 3] }]);
    setFullViewFile("a", true);
    setDocumentHits("a", [{ fileId: "a", filePath: "a.ts", side: "new", line: 1, range: [0, 3] }]);
    setQuery("foo");
    rebuildHits([f]);
    expect(getSearchState().hits).toEqual([{ fileId: "a", filePath: "a.ts", side: "new", line: 1, range: [0, 3] }]);
  });

  test("hasGapHitsFor matches only the query and patch the hits were stored under", () => {
    const a = file("a", "a.ts", "@@ -1,1 +1,1 @@\n x\n");
    setGapHits(a, "foo", []);
    expect(hasGapHitsFor(a, "foo")).toBe(true);
    expect(hasGapHitsFor(a, "bar")).toBe(false);
    expect(hasGapHitsFor({ id: "a", patch: "@@ -1,1 +1,1 @@\n y\n" }, "foo")).toBe(false);
    expect(hasGapHitsFor({ id: "b", patch: a.patch }, "foo")).toBe(false);
  });

  test("an edited query ignores the previous query's gap hits until its own scan reports", () => {
    const a = file("a", "a.ts", "@@ -1,1 +1,1 @@\n x\n");
    setGapHits(a, "foo", [{ fileId: "a", filePath: "a.ts", side: "new", line: 9, range: [0, 3] }]);
    setQuery("bar");
    rebuildHits([a]);
    expect(getSearchState().hits).toEqual([]);
  });

  test("gap hits scanned against an older patch are ignored once the file's patch changed", () => {
    setGapHits(file("a", "a.ts", "@@ -1,1 +1,1 @@\n x\n"), "foo", [{ fileId: "a", filePath: "a.ts", side: "new", line: 9, range: [0, 3] }]);
    setQuery("foo");
    rebuildHits([file("a", "a.ts", "@@ -1,1 +1,2 @@\n x\n+y\n")]);
    expect(getSearchState().hits).toEqual([]);
  });

  test("pruneSearchFiles drops gap hits for files no longer in the changeset", () => {
    const a = file("a", "a.ts", "@@ -1,1 +1,1 @@\n x\n");
    setGapHits(a, "foo", [{ fileId: "a", filePath: "a.ts", side: "new", line: 9, range: [0, 3] }]);
    pruneSearchFiles(["b"]);
    expect(hasGapHitsFor(a, "foo")).toBe(false);
  });

  test("clearSearch drops gap hits", () => {
    const a = file("a", "a.ts", "@@ -1,1 +1,1 @@\n x\n");
    setGapHits(a, "foo", [{ fileId: "a", filePath: "a.ts", side: "new", line: 9, range: [0, 3] }]);
    clearSearch();
    expect(hasGapHitsFor(a, "foo")).toBe(false);
  });

  test("keeps the current hit across a rebuild when it still exists", () => {
    setQuery("foo");
    rebuildHits([fileA, fileB]);
    const step = stepHit(1); // move to the second hit
    expect(step).not.toBeNull();
    const pinned = currentHit();
    rebuildHits([fileB, fileA]); // reorder files; the pinned hit still exists
    expect(currentHit()).toEqual(pinned);
  });

  test("keeps the current hit across a rebuild when hunk renumbers the file's id but the path stays the same", () => {
    // Three single-hit files so a reorder plus an id change can't coincidentally land on the
    // right index by luck: a fileId-based pin would silently clamp onto a *different* file's
    // hit here, rather than following the renumbered file by its path.
    const one = file("a", "a.ts", "@@ -1,1 +1,1 @@\n foo A\n");
    const two = file("b", "b.ts", "@@ -1,1 +1,1 @@\n foo B\n");
    const three = file("c", "c.ts", "@@ -1,1 +1,1 @@\n foo C\n");
    setQuery("foo");
    rebuildHits([one, two, three]);
    stepHit(1); // move onto "b.ts"'s hit
    const pinned = currentHit();
    expect(pinned).toEqual({ fileId: "b", filePath: "b.ts", side: "new", line: 1, range: [0, 3] });

    // Reload renumbers "b.ts" to a new id and reorders the files; the same line still matches.
    const reloadedTwo = file("b-reloaded", "b.ts", two.patch);
    rebuildHits([reloadedTwo, one, three]);

    expect(currentHit()).toEqual({ fileId: "b-reloaded", filePath: "b.ts", side: "new", line: 1, range: [0, 3] });
  });

  test("clamps the index into bounds when the current hit disappears", () => {
    setQuery("foo");
    rebuildHits([fileA, fileB]);
    stepHit(1);
    stepHit(1); // now at the last hit
    rebuildHits([fileA]); // fileB's hit is gone, list shrinks
    expect(getSearchState().currentIndex).toBe(getSearchState().hits.length - 1);
  });

  test("empty hits clamp the index to -1", () => {
    setQuery("nomatch");
    rebuildHits([fileA, fileB]);
    expect(getSearchState().currentIndex).toBe(-1);
    expect(getSearchState().hits).toEqual([]);
  });
});

describe("stepHit", () => {
  const fileA = file("a", "a.ts", ["@@ -1,2 +1,2 @@", " foo one", " foo two"].join("\n"));

  test("returns null with no hits", () => {
    expect(stepHit(1)).toBeNull();
  });

  test("wraps forward past the last hit and reports wrapped", () => {
    setQuery("foo");
    rebuildHits([fileA]);
    expect(getSearchState().currentIndex).toBe(0);
    const step1 = stepHit(1);
    expect(step1?.wrapped).toBe(false);
    expect(getSearchState().currentIndex).toBe(1);
    const step2 = stepHit(1);
    expect(step2?.wrapped).toBe(true);
    expect(getSearchState().currentIndex).toBe(0);
  });

  test("wraps backward past the first hit and reports wrapped", () => {
    setQuery("foo");
    rebuildHits([fileA]);
    const step = stepHit(-1);
    expect(step?.wrapped).toBe(true);
    expect(getSearchState().currentIndex).toBe(1);
  });
});

describe("clearSearch", () => {
  test("resets query/hits/index/prompt but keeps fullViewFileIds", () => {
    setFullViewFile("f1", true);
    openPrompt("foo");
    setQuery("foo");
    clearSearch();
    expect(getSearchState()).toEqual({
      query: "",
      hits: [],
      currentIndex: -1,
      prompt: { open: false, draft: "" },
      fullViewFileIds: new Set(["f1"]),
    });
  });
});

import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import {
  clearSearch,
  closePrompt,
  currentHit,
  editDraft,
  findLineHits,
  getSearchState,
  openPrompt,
  rebuildHits,
  resetSearchForTests,
  scanDocumentHits,
  scanPatchHits,
  setDocumentHits,
  setQuery,
  stepHit,
  toggleFullViewFile,
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

describe("toggleFullViewFile", () => {
  test("adds then removes a file id", () => {
    toggleFullViewFile("f1");
    expect(getSearchState().fullViewFileIds.has("f1")).toBe(true);
    toggleFullViewFile("f1");
    expect(getSearchState().fullViewFileIds.has("f1")).toBe(false);
  });
});

describe("rebuildHits", () => {
  const fileA = file("a", "a.ts", ["@@ -1,1 +1,1 @@", "-foo", "+foo bar"].join("\n"));
  const fileB = file("b", "b.ts", ["@@ -1,1 +1,1 @@", " foo baz"].join("\n"));

  test("merges patch and document hits in visible-file order", () => {
    toggleFullViewFile("b");
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
    setQuery("foo");
    rebuildHits([fileA, fileB]);
    const pinned = currentHit();
    expect(pinned).not.toBeNull();
    // Same path, same side/line/range, but a different runtime file id, as after a reload.
    const reloadedFileA = file("a-reloaded", "a.ts", fileA.patch);
    rebuildHits([reloadedFileA, fileB]);
    expect(currentHit()).toEqual({ ...pinned!, fileId: "a-reloaded" });
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
    toggleFullViewFile("f1");
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

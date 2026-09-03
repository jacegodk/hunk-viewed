import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import {
  fileMatchesFilter,
  getReviewMirror,
  resetReviewMirrorForTests,
  setMirrorFiles,
  setMirrorFilter,
  setMirrorSelectedFileId,
  visibleFiles,
} from "./reviewMirror";

function file(id: string, path: string): ExtensionDiffFile {
  return { id, path, patch: "", stats: { additions: 0, deletions: 0 }, metadata: {}, agent: null };
}

beforeEach(() => resetReviewMirrorForTests());

describe("fileMatchesFilter", () => {
  test("empty or blank filter matches everything", () => {
    expect(fileMatchesFilter("src/a.ts", "")).toBe(true);
    expect(fileMatchesFilter("src/a.ts", "   ")).toBe(true);
  });
  test("is a case-insensitive trimmed substring match", () => {
    expect(fileMatchesFilter("src/App.tsx", " app ")).toBe(true);
    expect(fileMatchesFilter("src/App.tsx", "b.ts")).toBe(false);
  });
});

describe("reviewMirror", () => {
  test("starts empty", () => {
    expect(getReviewMirror()).toEqual({ files: [], filter: "", selectedFileId: null, filesModeActive: false });
  });

  test("visibleFiles applies the filter in review order", () => {
    setMirrorFiles([file("1", "src/a.ts"), file("2", "docs/b.md"), file("3", "src/c.ts")]);
    setMirrorFilter("src");
    expect(visibleFiles(getReviewMirror()).map((f) => f.id)).toEqual(["1", "3"]);
  });

  test("setters publish new snapshots", () => {
    const before = getReviewMirror();
    setMirrorSelectedFileId("2");
    expect(getReviewMirror()).not.toBe(before);
    expect(getReviewMirror().selectedFileId).toBe("2");
  });
});

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

function file(id: string, path: string, extra: Partial<ExtensionDiffFile> = {}): ExtensionDiffFile {
  return { id, path, patch: "", stats: { additions: 0, deletions: 0 }, metadata: {}, agent: null, ...extra };
}

beforeEach(() => resetReviewMirrorForTests());

describe("fileMatchesFilter", () => {
  test("empty or blank filter matches everything", () => {
    expect(fileMatchesFilter(file("1", "src/a.ts"), "")).toBe(true);
    expect(fileMatchesFilter(file("1", "src/a.ts"), "   ")).toBe(true);
  });
  test("is a case-insensitive trimmed substring match on the path", () => {
    expect(fileMatchesFilter(file("1", "src/App.tsx"), " app ")).toBe(true);
    expect(fileMatchesFilter(file("1", "src/App.tsx"), "b.ts")).toBe(false);
  });
  test("matches on the previous path", () => {
    expect(fileMatchesFilter(file("1", "src/b.ts", { previousPath: "src/a.ts" }), "a.ts")).toBe(true);
  });
  test("matches on the agent summary", () => {
    expect(fileMatchesFilter(file("1", "src/b.ts", { agent: { path: "src/b.ts", summary: "renamed helper", annotations: [] } }), "renamed")).toBe(
      true,
    );
  });
  test("does not match when the path, previous path, and agent summary all miss", () => {
    const f = file("1", "src/b.ts", { previousPath: "src/a.ts", agent: { path: "src/b.ts", summary: "renamed helper", annotations: [] } });
    expect(fileMatchesFilter(f, "nope")).toBe(false);
  });
});

describe("reviewMirror", () => {
  test("starts empty", () => {
    expect(getReviewMirror()).toEqual({ files: [], filter: "", selectedFileId: null });
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

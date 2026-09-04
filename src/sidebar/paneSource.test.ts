import { describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import { resolvePaneSource } from "./paneSource";

function file(id: string, path: string): ExtensionDiffFile {
  return { id, path, patch: "", stats: { additions: 0, deletions: 0 }, metadata: {}, agent: null };
}

describe("resolvePaneSource", () => {
  test("lists the host-filtered files and highlights the selection when inactive", () => {
    const files = [file("1", "a.ts"), file("2", "b.ts")];
    const result = resolvePaneSource({ active: false, targetPath: null, pendingPath: null, returnPath: null }, [], files, "2");
    expect(result).toEqual({ listFiles: files, highlightedId: "2" });
  });

  test("lists allFiles and highlights the target when active", () => {
    const allFiles = [file("1", "a.ts"), file("2", "b.ts")];
    const result = resolvePaneSource({ active: true, targetPath: "b.ts", pendingPath: null, returnPath: null }, allFiles, [allFiles[1]!], "2");
    expect(result).toEqual({ listFiles: allFiles, highlightedId: "2" });
  });

  test("highlights nothing when the target is missing from allFiles", () => {
    const allFiles = [file("1", "a.ts")];
    const result = resolvePaneSource({ active: true, targetPath: "missing.ts", pendingPath: null, returnPath: null }, allFiles, [], null);
    expect(result).toEqual({ listFiles: allFiles, highlightedId: null });
  });
});

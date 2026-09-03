import { describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import { findUnviewedNeighbor } from "./navigation";

function file(id: string): ExtensionDiffFile {
  return { id, path: `${id}.ts`, patch: "", stats: { additions: 0, deletions: 0 }, metadata: {}, agent: null };
}
const files = [file("a"), file("b"), file("c"), file("d")];
const viewed = new Set(["b", "d"]);
const isViewedFile = (f: ExtensionDiffFile) => viewed.has(f.id);

describe("findUnviewedNeighbor", () => {
  test("skips viewed files going forward", () => {
    expect(findUnviewedNeighbor(files, "a", 1, isViewedFile)?.id).toBe("c");
  });
  test("skips viewed files going backward", () => {
    expect(findUnviewedNeighbor(files, "d", -1, isViewedFile)?.id).toBe("c");
    expect(findUnviewedNeighbor(files, "c", -1, isViewedFile)?.id).toBe("a");
  });
  test("returns null at the ends without wrapping", () => {
    expect(findUnviewedNeighbor(files, "c", 1, isViewedFile)).toBeNull();
    expect(findUnviewedNeighbor(files, "a", -1, isViewedFile)).toBeNull();
  });
  test("with no selection starts from the first or last file", () => {
    expect(findUnviewedNeighbor(files, null, 1, isViewedFile)?.id).toBe("a");
    expect(findUnviewedNeighbor(files, null, -1, isViewedFile)?.id).toBe("c");
    expect(findUnviewedNeighbor(files, "missing", 1, isViewedFile)?.id).toBe("a");
  });
  test("returns null for an empty list", () => {
    expect(findUnviewedNeighbor([], null, 1, isViewedFile)).toBeNull();
  });
});

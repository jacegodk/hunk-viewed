import { describe, expect, test } from "bun:test";
import { parseUnifiedPatch } from "./unifiedPatch";

const patch = [
  "diff --git a/x.ts b/x.ts",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "@@ -10 +11,2 @@ function tail() {",
  " return 1;",
  "+return 2;",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseUnifiedPatch", () => {
  test("parses headers, counts, and line kinds, skipping file headers", () => {
    const hunks = parseUnifiedPatch(patch);
    expect(hunks.length).toBe(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 1, newCount: 4 });
    expect(hunks[0]!.lines).toEqual([
      { kind: "context", text: "const a = 1;" },
      { kind: "removed", text: "const b = 2;" },
      { kind: "added", text: "const b = 3;" },
      { kind: "added", text: "const c = 4;" },
      { kind: "context", text: "const d = 5;" },
    ]);
    expect(hunks[1]).toMatchObject({ oldStart: 10, oldCount: 1, newStart: 11, newCount: 2 });
    expect(hunks[1]!.lines).toEqual([
      { kind: "context", text: "return 1;" },
      { kind: "added", text: "return 2;" },
    ]);
  });

  test("returns an empty list without a hunk header", () => {
    expect(parseUnifiedPatch("diff --git a/x b/x\nBinary files differ\n")).toEqual([]);
    expect(parseUnifiedPatch("")).toEqual([]);
  });

  test("handles CRLF patches", () => {
    const hunks = parseUnifiedPatch("@@ -1 +1 @@\r\n-a\r\n+b\r\n");
    expect(hunks[0]!.lines).toEqual([
      { kind: "removed", text: "a" },
      { kind: "added", text: "b" },
    ]);
  });
});

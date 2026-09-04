# hunk-viewed Round 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `F` toggles a "Full file" view that shows the whole file as a unified diff with unlimited context; `J`/`K` walk every visible file outside single-file mode and skip viewed files inside it.

**Architecture:** A pure unified-patch parser (`src/unifiedPatch.ts`) and a pure layout builder (`src/fullFileView.ts`) feed a registered file view `hunk-viewed:full`; the view reads the new-side document through `readDocument("new")` and takes removed lines from the patch text. `index.tsx` registers the view, the `F` command, and changes `J`/`K` policy.

**Tech Stack:** TypeScript, Bun 1.4, React 19 / `@opentui/react` JSX, `hunkdiff@0.21.0` extension types (API 16).

**Spec:** `docs/superpowers/specs/2026-09-03-hunk-viewed-design.md`, section "Round 3 — 2026-09-04" (note: the old-side document is not needed; removed lines come from the patch — update the spec sentence in Task 3).

## Global Constraints

- Repo `~/work/hunk-viewed`, branch `feat/viewed-marks`. `bun` is not on PATH: start every bun command with `export PATH="$HOME/.bun/bin:$PATH";`. Use absolute paths or `git -C`.
- New ids: file view `full` (qualified `hunk-viewed:full`), command `fullFile` key `F`. `F` is free (the old files mode was removed in round 2).
- Full-file layout: every new-side line in order; removed lines at their hunk position, tone `removed`; added lines tone `added`; unchanged lines no tone. Gutter = new-side line number right-aligned to the width of the largest line number, then one space, then a marker column (` `, `+`, `-`), then a space, then the text. Removed rows show a blank gutter. `sourceRanges`: `{ side: "new", range: [n, n] }` for context/added rows, `{ side: "old", range: [o, o] }` for removed rows. `hunkRows[i]` spans hunk i's patch rows.
- `layout` returns `null` when: `readDocument("new")` is null; the patch has no parseable hunk; `file.statsTruncated` is true; a context line in the patch does not equal the document line it claims; the total row count exceeds 10,000; or `input.signal.aborted`.
- `J`/`K` outside single mode: next/previous **visible** file (viewed or not), no wrap, notices `"No file after this one"` / `"No file before this one"`. Inside single mode: unchanged (next/previous unviewed over `allFiles`). `v`'s jump unchanged (next unviewed).
- No runtime dependencies. Short active-voice JSDoc. One commit per task, no `Co-Authored-By`, never amend. The agent never runs the TUI.

---

### Task 1: Unified patch parser

**Files:**
- Create: `src/unifiedPatch.ts`, `src/unifiedPatch.test.ts`

**Interfaces:**
- `type PatchLineKind = "context" | "added" | "removed"`
- `interface PatchLine { kind: PatchLineKind; text: string }`
- `interface PatchHunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: PatchLine[] }`
- `parseUnifiedPatch(patch: string): PatchHunk[]` — skips everything before the first `@@` header; ignores `\ No newline at end of file` lines; a missing count defaults to 1; returns `[]` when no hunk header is found.

- [ ] **Step 1: Write the failing tests**

`src/unifiedPatch.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to see it fail**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd /home/ja/work/hunk-viewed && bun test src/unifiedPatch.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/unifiedPatch.ts`:

```ts
export type PatchLineKind = "context" | "added" | "removed";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Parse the hunks of one unified-diff patch. Skips anything before the first `@@` header
 * (git and `diff` file headers), ignores `\ No newline at end of file` markers, and treats a
 * missing count as 1. Returns an empty list when the text holds no hunk.
 */
export function parseUnifiedPatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  for (const rawLine of patch.replaceAll("\r\n", "\n").split("\n")) {
    const header = HUNK_HEADER.exec(rawLine);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const marker = rawLine[0];
    const text = rawLine.slice(1);
    if (marker === " ") current.lines.push({ kind: "context", text });
    else if (marker === "+") current.lines.push({ kind: "added", text });
    else if (marker === "-") current.lines.push({ kind: "removed", text });
    else if (rawLine === "" ) current.lines.push({ kind: "context", text: "" });
    // "\ No newline at end of file" and any other marker are ignored.
  }
  // A trailing empty string from the final newline must not become a context line.
  for (const hunk of hunks) {
    const last = hunk.lines[hunk.lines.length - 1];
    if (last && last.kind === "context" && last.text === "" && hunk.lines.length > hunk.oldCount + hunk.newCount) {
      hunk.lines.pop();
    }
  }
  return hunks;
}
```

Note: an empty line inside a hunk body is a context line whose text is empty (`git diff` emits a single space, but some tools emit nothing). The final `split("\n")` yields one trailing `""` after the last newline; the loop above pops it only when the hunk already has more lines than its counts allow. If the test "parses headers…" fails on the trailing-empty handling, prefer: drop the very last element of the split array when it is `""` before iterating, and delete the post-pass. Keep whichever makes the tests pass with the simplest code.

- [ ] **Step 4: Verify and commit**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd /home/ja/work/hunk-viewed && bun test src/unifiedPatch.test.ts && bun run typecheck`

```bash
git -C /home/ja/work/hunk-viewed add src/unifiedPatch.ts src/unifiedPatch.test.ts && git -C /home/ja/work/hunk-viewed commit -m "feat: parse unified patches into hunks"
```

---

### Task 2: Full-file layout builder

**Files:**
- Create: `src/fullFileView.ts`, `src/fullFileView.test.ts`

**Interfaces:**
- Consumes: `PatchHunk`, `parseUnifiedPatch` (Task 1); `ExtensionFileViewLayout`, `ExtensionFileViewRow` from `hunkdiff/extension`.
- Produces: `FULL_VIEW_ID = "full"`; `FULL_VIEW_MAX_ROWS = 10_000`;
  `buildFullFileLayout(newDocument: string, hunks: readonly PatchHunk[]): ExtensionFileViewLayout | null`.

- [ ] **Step 1: Write the failing tests**

`src/fullFileView.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildFullFileLayout } from "./fullFileView";
import { parseUnifiedPatch } from "./unifiedPatch";

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
    expect(layout!.rows[3]!.spans.every((span) => span.tone === undefined)).toBe(true);
    expect(layout!.rows[1]!.sourceRanges).toEqual([{ side: "old", range: [2, 2] }]);
    expect(layout!.rows[2]!.sourceRanges).toEqual([{ side: "new", range: [2, 2] }]);
    expect(layout!.hunkRows).toEqual([
      { startRow: 0, endRow: 3 },
      { startRow: 6, endRow: 6 },
    ]);
  });

  test("gutter width follows the largest line number", () => {
    const doc = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const layout = buildFullFileLayout(doc, parseUnifiedPatch("@@ -1 +1 @@\n l1\n"));
    expect(texts(layout!)[0]).toBe(" 1   l1");
    expect(texts(layout!)[11]).toBe("12   l12");
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
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd /home/ja/work/hunk-viewed && bun test src/fullFileView.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/fullFileView.ts`:

```ts
import type { ExtensionFileViewLayout, ExtensionFileViewRow, ExtensionFileViewSpan } from "hunkdiff/extension";
import type { PatchHunk } from "./unifiedPatch";

/** Id of the full-file presentation, qualified by hunk as `hunk-viewed:full`. */
export const FULL_VIEW_ID = "full";
/** Hunk's per-view row limit; a layout over it falls back to the raw diff. */
export const FULL_VIEW_MAX_ROWS = 10_000;

/** Split a document into lines, dropping the empty tail a trailing newline produces. */
function documentLines(document: string): string[] {
  const lines = document.replaceAll("\r\n", "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Rebuild the whole file as a unified diff with unlimited context.
 *
 * Walks the new-side document in order, splicing each hunk's patch lines in at its
 * `newStart`: context and added rows take the document text, removed rows take the patch text.
 * Returns null when the patch has no hunks, a context line disagrees with the document (the
 * source moved on), or the row budget is exceeded; hunk then keeps the raw diff.
 */
export function buildFullFileLayout(newDocument: string, hunks: readonly PatchHunk[]): ExtensionFileViewLayout | null {
  if (hunks.length === 0) return null;
  const lines = documentLines(newDocument);
  const gutterWidth = String(Math.max(1, lines.length)).length;
  const rows: ExtensionFileViewRow[] = [];
  const hunkRows: { startRow: number; endRow: number }[] = [];

  const push = (kind: "context" | "added" | "removed", text: string, newLine: number | null, oldLine: number | null) => {
    const number = newLine === null ? " ".repeat(gutterWidth) : String(newLine).padStart(gutterWidth);
    const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
    const tone: ExtensionFileViewSpan["tone"] | undefined = kind === "added" ? "added" : kind === "removed" ? "removed" : undefined;
    const spans: ExtensionFileViewSpan[] = [
      { text: `${number} `, tone: "muted" },
      tone ? { text: `${marker} ${text}`, tone } : { text: `${marker} ${text}` },
    ];
    const sourceRanges =
      newLine !== null
        ? [{ side: "new" as const, range: [newLine, newLine] as const }]
        : oldLine !== null
          ? [{ side: "old" as const, range: [oldLine, oldLine] as const }]
          : undefined;
    rows.push({ id: `full:${rows.length}`, spans, ...(sourceRanges ? { sourceRanges } : {}) });
  };

  let nextNew = 1; // 1-based new-side line about to be emitted
  for (const hunk of hunks) {
    const hunkNewStart = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    while (nextNew < hunkNewStart && nextNew <= lines.length) {
      push("context", lines[nextNew - 1]!, nextNew, null);
      nextNew += 1;
    }
    const startRow = rows.length;
    let oldLine = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.kind === "removed") {
        push("removed", line.text, null, oldLine);
        oldLine += 1;
        continue;
      }
      const documentText = lines[nextNew - 1];
      if (documentText === undefined) return null;
      if (line.kind === "context" && documentText !== line.text) return null;
      push(line.kind, documentText, nextNew, line.kind === "context" ? oldLine : null);
      nextNew += 1;
      if (line.kind === "context") oldLine += 1;
    }
    hunkRows.push({ startRow, endRow: Math.max(startRow, rows.length - 1) });
    if (rows.length > FULL_VIEW_MAX_ROWS) return null;
  }
  while (nextNew <= lines.length) {
    push("context", lines[nextNew - 1]!, nextNew, null);
    nextNew += 1;
  }
  if (rows.length > FULL_VIEW_MAX_ROWS) return null;
  return { rows, hunkRows };
}
```

The test expectations encode the exact gutter format: `"1   line one"` is number `1`, space, marker ` `, space, text. Make the tests pass; if a test's expectation and this code disagree on an off-by-one in `hunkNewStart` for a pure-deletion hunk (`newCount === 0`), trust the test's row order (removed line after the last kept line) and adjust the code.

- [ ] **Step 4: Verify and commit**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd /home/ja/work/hunk-viewed && bun test src/fullFileView.test.ts && bun run typecheck`

```bash
git -C /home/ja/work/hunk-viewed add src/fullFileView.ts src/fullFileView.test.ts && git -C /home/ja/work/hunk-viewed commit -m "feat: build a full-file unified layout with unlimited context"
```

---

### Task 3: Register the full view, `F`, and the J/K policy

**Files:**
- Modify: `index.tsx`, `index.test.ts`, `README.md`, `docs/superpowers/specs/2026-09-03-hunk-viewed-design.md`

- [ ] **Step 1: index.tsx**

Imports: `import { FULL_VIEW_ID, buildFullFileLayout } from "./src/fullFileView";` and `import { parseUnifiedPatch } from "./src/unifiedPatch";`.

Register after the folded view:

```ts
  hunk.registerFileView({
    id: FULL_VIEW_ID,
    title: "Full file",
    matches: (file) => !file.isBinary,
    async layout(input) {
      if (input.file.statsTruncated) return null;
      const hunks = parseUnifiedPatch(input.file.patch);
      if (hunks.length === 0) return null;
      const document = await input.readDocument("new");
      if (document === null || input.signal.aborted) return null;
      return buildFullFileLayout(document, hunks);
    },
  });

  hunk.registerCommand({ id: "fullFile", title: "Toggle full file", key: "F" }, (ctx) => {
    if (!ctx.selection.file) {
      ctx.notify("No file selected", "info");
      return;
    }
    ctx.fileViews.toggle(FULL_VIEW_ID);
  });
```

J/K policy: rename `jumpUnviewed` to `jumpFile(ctx, direction, messages)` and change the non-single branch to walk `navigationFiles(selectedFileId)` with a predicate that accepts every file:

```ts
  /** Move to the neighboring file: any visible file outside single mode, unviewed only inside it. */
  function jumpFile(ctx: ExtensionCommandContext, direction: 1 | -1) {
    const single = getSingleFileState();
    if (single.active) {
      const files = getReviewMirror().allFiles;
      const currentId = files.find((file) => file.path === single.targetPath)?.id ?? null;
      const next = findUnviewedNeighbor(files, currentId, direction, isViewedFile);
      if (next) retarget(next.path, (id) => ctx.commands.execute(id), ctx.notify);
      else ctx.notify(direction === 1 ? "No unviewed file after this one" : "No unviewed file before this one", "info");
      return;
    }
    const selectedFileId = ctx.selection.file?.id ?? null;
    const next = findUnviewedNeighbor(navigationFiles(selectedFileId), selectedFileId, direction, () => false);
    if (next) ctx.navigation.selectFile(next.id);
    else ctx.notify(direction === 1 ? "No file after this one" : "No file before this one", "info");
  }
```
(`findUnviewedNeighbor` with an always-false predicate is the plain neighbor; import `ExtensionCommandContext` as a type if not already.) Update command titles: `nextUnviewed` → title "Next file (next unviewed in single-file mode)", `previousUnviewed` → "Previous file (previous unviewed in single-file mode)". Keep the command ids unchanged so existing keybindings keep working. Update the module header comment.

- [ ] **Step 2: Tests**

In `index.test.ts`: extend the fake `fileViews` with `toggle` (record ids). Add:

```ts
describe("full file view", () => {
  test("registers the full view for non-binary files and F toggles it", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const file = makeFile("1", "a.ts", { patch: "@@ -1 +1 @@\n-a\n+b\n" });
    loadChangeset(fake, [file]);
    const view = fake.fileViews.find((v) => (v as { id: string }).id === "full") as {
      matches: (f: ExtensionDiffFile) => boolean;
      layout: (input: unknown) => Promise<{ rows: unknown[] } | null>;
    };
    expect(view.matches(file)).toBe(true);
    expect(view.matches({ ...file, isBinary: true })).toBe(false);
    const layout = await view.layout({ file, width: 80, signal: new AbortController().signal, changes: [], readDocument: async () => "b\n" });
    expect(layout?.rows.length).toBe(2);
    const missing = await view.layout({ file, width: 80, signal: new AbortController().signal, changes: [], readDocument: async () => null });
    expect(missing).toBeNull();
    const calls = createCalls();
    fake.commands.get("fullFile")!.handler(commandContext(file, [], [], calls));
    expect(calls.fileViewToggles).toEqual(["full"]);
  });
});

describe("J/K policy", () => {
  test("outside single mode J/K walk every visible file, viewed or not", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[1]!, new Date());
    const selected: string[] = [];
    fake.commands.get("nextUnviewed")!.handler(commandContext(files[0]!, selected, [], createCalls()));
    expect(selected).toEqual(["2"]);
    const notified: Array<[string, string | undefined]> = [];
    fake.commands.get("nextUnviewed")!.handler(commandContext(files[2]!, [], notified, createCalls()));
    expect(notified[0]?.[0]).toBe("No file after this one");
  });
});
```
Update the existing `nextUnviewed`/`previousUnviewed` normal-mode tests to the new policy (they previously asserted skipping). Keep the single-mode tests as they are (skipping still applies there).

- [ ] **Step 3: Docs**

README: Keys table — add `F` "Toggle full file: the whole file as a diff with unlimited context; `F` again returns to the normal diff"; change `J`/`K` rows to "Next / previous file. In single-file mode: next / previous unviewed file." Known limitations — add "The full-file view needs a readable source (not a piped patch) and falls back to the normal diff over 10,000 rows or when the file changed since the diff was taken."
Spec Round 3 section D: replace the `readDocument("old")` sentence with "removed lines come from the patch text; only the new-side document is read".

- [ ] **Step 4: Verify and commit**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd /home/ja/work/hunk-viewed && bun run typecheck && bun test`

```bash
git -C /home/ja/work/hunk-viewed add -A && git -C /home/ja/work/hunk-viewed commit -m "feat: add the full-file view on F and walk all files with J/K"
```

- [ ] **Step 5: Manual TTY checklist (human)**

```bash
cd ~/work/hunk && hunk diff --extension ~/work/hunk-viewed HEAD~3
```
1. `F` on a file shows the whole file: numbered lines, red removed lines at the right place, green added lines. `[`/`]` still stop at each hunk. `F` again returns to the normal diff.
2. `F` on a folded viewed file shows the full file; `v` clears the mark and returns to raw.
3. `J`/`K` land on viewed files too; `v` on one clears it.
4. In single-file mode (`o`), `J`/`K` still skip viewed files.
5. `git diff | hunk patch -`, then `F`: nothing changes (raw diff stays).

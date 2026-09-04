# hunk-viewed Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brighter check marks, viewed files folded to one line in the review stream, and a single-file mode that shows one file while the pane keeps listing all of them.

**Architecture:** A registered file view (`hunk-viewed:viewed`) folds viewed files; `v` selects it on the file it marks. Single-file mode is a keyboard mode plus a changeset transform: the transform keeps only the target file and the mode drives `hunk.app.refresh`. A new `singleFile` store holds the target; the mirror gains the untransformed `allFiles` list for the pane.

**Tech Stack:** TypeScript, Bun 1.4 (`bun test`, `tsc --noEmit`), React 19 with `@opentui/react` JSX, `hunkdiff@0.21.0` extension types (API version 16).

**Spec:** `docs/superpowers/specs/2026-09-03-hunk-viewed-design.md`, section "Round 2 — 2026-09-04".

## Global Constraints

- Repo `~/work/hunk-viewed`, branch `feat/viewed-marks`. `bun` is not on PATH: start every bun command with `export PATH="$HOME/.bun/bin:$PATH";`.
- Extension id `hunk-viewed`. New ids: file view `viewed` (qualified `hunk-viewed:viewed`), keyboard mode `single` (`hunk-viewed:single`), commands `foldViewed` (no key) and `singleFile` (key `o`). Remove command `filesMode` (`F`) and keyboard mode `files`.
- Check mark color in the pane: `theme.badgeAdded`. In the folded row: span tone `"added"`.
- Folded layout: one row for files with hunks, `hunkRows` entry `{ startRow: 0, endRow: 0 }` per hunk; zero rows and zero hunkRows for files without hunks.
- Single-file mode: `,`/`.` inside the mode move the target over `allFiles`; `enter` loads `pendingPath`; every other key passes. `o` toggles the mode on and off. Each target change runs `hunk.app.refresh`.
- Never use `f`, `j`, `k`, `tab`, `space`, `,`, `.` as extension default keys (they are hunk built-ins); intercepting `,`/`.` inside a keyboard mode is allowed.
- No runtime dependencies. Short active-voice JSDoc on exports. One commit per task, no `Co-Authored-By`, never amend.
- Tests: `index.test.ts` uses the existing fake-hunk helpers; extend them rather than duplicating.
- The agent never runs the TUI. The manual TTY checklist goes to the human.

---

## File structure

| File | Change |
| --- | --- |
| `src/sidebar/rows.tsx` | check mark color `badgeAdded` |
| `src/reviewMirror.ts` | remove `filesModeActive`; add `allFiles` + `setMirrorAllFiles` |
| `src/sidebar/FilesPane.tsx` | title always muted; single-mode source list, highlight, counter, click behavior |
| `src/foldedView.ts` (new) | `buildFoldedLayout(file)` pure |
| `src/singleFile.ts` (new) | target state store, `applySingleFileTransform`, `neighborPath` |
| `index.tsx` | remove F mode; register file view; `v` fold/unfold; `foldViewed`; transform; `o` + `single` mode; J/K/v single-mode branches |
| `index.test.ts` | update F-mode tests; add fold, transform, single-mode tests |
| `README.md` | keys and limits |

---

### Task 1: Brighter check mark and remove the F files mode

**Files:**
- Modify: `src/sidebar/rows.tsx`, `src/reviewMirror.ts`, `src/reviewMirror.test.ts`, `src/sidebar/FilesPane.tsx`, `index.tsx`, `index.test.ts`

**Interfaces:**
- Removes: `setMirrorFilesModeActive`, `ReviewMirror.filesModeActive`, command `filesMode`, keyboard mode `files`.
- Produces: nothing new; `FilesPane` title color is always `theme.muted`.

- [ ] **Step 1: Update tests first**

In `src/reviewMirror.test.ts`, change the "starts empty" expectation to `{ files: [], filter: "", selectedFileId: null }`.

In `index.test.ts`: in "registers the pane, commands, and keyboard mode", drop the assertions about `filesMode` / key `F` and the `files` keyboard mode, and assert `fake.keyboardModes.size` is `0` for now (Task 4 raises it to 1). Delete the whole `describe("files keyboard mode", ...)` block.

- [ ] **Step 2: Run tests to see them fail**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/reviewMirror.test.ts index.test.ts`
Expected: FAIL (mirror still has `filesModeActive`; keyboard mode still registered).

- [ ] **Step 3: Implement**

`src/sidebar/rows.tsx`: change the check-mark span to `<text fg={theme.badgeAdded}>{viewed ? "✓ " : "  "}</text>`.

`src/reviewMirror.ts`: remove `filesModeActive` from the interface, from `initial`, and delete `setMirrorFilesModeActive`. Update the JSDoc.

`src/sidebar/FilesPane.tsx`: remove `useReviewMirror` usage for `filesModeActive`; render the title with `fg={theme.muted}`. Keep the `useReviewMirror` import only if still used (Task 4 uses it again; if unused now, remove it and re-add later).

`index.tsx`: delete the `registerKeyboardMode({ id: FILES_MODE_ID, ... })` block, the `filesMode` command, the `setMirrorFilesModeActive` import, the `matchesKey` and `ExtensionKeyEvent` imports (Task 4 re-adds them), and rename `FILES_MODE_ID` to `FILES_PANE_ID = "files"`. Update the module header comment: drop the `F` sentence.

- [ ] **Step 4: Verify**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun run typecheck && bun test`
Expected: clean, all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/work/hunk-viewed && git add -A && git commit -m "feat: brighten the check mark and drop the files keyboard mode"
```

---

### Task 2: Folded file view for viewed files

**Files:**
- Create: `src/foldedView.ts`, `src/foldedView.test.ts`
- Modify: `index.tsx`, `index.test.ts`

**Interfaces:**
- Produces: `buildFoldedLayout(file: ExtensionDiffFile): ExtensionFileViewLayout`; `FOLDED_VIEW_ID = "viewed"`.
- `index.tsx` registers the file view and the `foldViewed` command; `toggleViewed` calls `ctx.fileViews.select(FOLDED_VIEW_ID)` after marking and `ctx.fileViews.select(null)` after clearing.

- [ ] **Step 1: Write the failing layout tests**

`src/foldedView.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to see it fail**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/foldedView.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the layout**

`src/foldedView.ts`:

```ts
import type { ExtensionDiffFile, ExtensionFileViewLayout } from "hunkdiff/extension";

/** Id of the folded presentation, qualified by hunk as `hunk-viewed:viewed`. */
export const FOLDED_VIEW_ID = "viewed";

/**
 * Build the one-row "folded" presentation for a viewed file: a green check, the word viewed,
 * the hunk count, and the line stats. Every hunk maps to that row so hunk navigation still
 * stops at the file. A file without hunks folds to its header alone.
 */
export function buildFoldedLayout(file: ExtensionDiffFile): ExtensionFileViewLayout {
  const hunkCount = file.hunks?.length ?? 0;
  if (hunkCount === 0) return { rows: [], hunkRows: [] };
  const plus = `+${file.stats.additions}${file.statsTruncated ? "+" : ""}`;
  const minus = `-${file.stats.deletions}`;
  return {
    rows: [
      {
        id: "folded",
        spans: [
          { text: "✓ ", tone: "added" },
          { text: "viewed", tone: "muted" },
          { text: `  ${hunkCount} ${hunkCount === 1 ? "hunk" : "hunks"}  ${plus} ${minus}`, tone: "muted" },
        ],
      },
    ],
    hunkRows: Array.from({ length: hunkCount }, () => ({ startRow: 0, endRow: 0 })),
  };
}
```

- [ ] **Step 4: Wire it into index.tsx**

Add imports: `import { FOLDED_VIEW_ID, buildFoldedLayout } from "./src/foldedView";`.

After `registerPane`, register the view:

```ts
  hunk.registerFileView({
    id: FOLDED_VIEW_ID,
    title: "Viewed",
    matches: (file) => isViewed(getViewedState(), file),
    layout: ({ file }) => buildFoldedLayout(file),
  });
```

Change `toggleViewed`:

```ts
    const result = toggleViewed(file, new Date());
    if (result === "cleared") {
      ctx.fileViews.select(null);
      return;
    }
    ctx.fileViews.select(FOLDED_VIEW_ID);
    const next = findUnviewedNeighbor(navigationFiles(file.id), file.id, 1, isViewedFile);
    if (next) ctx.navigation.selectFile(next.id);
    else ctx.notify("No unviewed file after this one", "info");
```

Add the fold-all command after `clearRepo`:

```ts
  hunk.registerCommand({ id: "foldViewed", title: "Fold viewed files" }, (ctx) => {
    const state = getViewedState();
    const viewedVisible = visibleFiles(getReviewMirror()).filter((file) => isViewed(state, file));
    if (viewedVisible.length === 0) {
      ctx.notify("No viewed files to fold", "info");
      return;
    }
    const selected = ctx.selection.file;
    // The bulk command only runs when the selected file already presents the view, so anchor
    // on a viewed file first and come back afterwards.
    const anchor = selected && isViewed(state, selected) ? selected : viewedVisible[0]!;
    if (anchor.id !== selected?.id) ctx.navigation.selectFile(anchor.id);
    ctx.fileViews.select(FOLDED_VIEW_ID);
    ctx.commands.execute("hunk.view.applyFilePresentationToAllMatching");
    if (selected && anchor.id !== selected.id) ctx.navigation.selectFile(selected.id);
  });
```

- [ ] **Step 5: Extend index.test.ts**

Extend `createFakeHunk` with `fileViews: unknown[]` and `registerFileView: (view: unknown) => fileViews.push(view)`. Extend `commandContext` to accept an optional `calls` recorder and add `fileViews: { select: (id) => calls.fileViewSelects.push(id) }` and `commands: { execute: (id) => { calls.executed.push(id); return true; } }`. Define `interface CommandCalls { fileViewSelects: Array<string | null>; executed: string[] }` and a `createCalls()` helper.

Add tests:

```ts
describe("folded file view", () => {
  test("registers the viewed file view that matches viewed files and folds them", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { hunks: [{ index: 0, header: "@@" }] as never }), makeFile("2", "b.ts")];
    loadChangeset(fake, files);
    const view = fake.fileViews[0] as { id: string; matches: (f: ExtensionDiffFile) => boolean; layout: (input: { file: ExtensionDiffFile }) => { rows: unknown[] } };
    expect(view.id).toBe("viewed");
    expect(view.matches(files[0]!)).toBe(false);
    storeToggleViewed(files[0]!, new Date());
    expect(view.matches(files[0]!)).toBe(true);
    expect(view.layout({ file: files[0]! }).rows.length).toBe(1);
  });

  test("toggleViewed selects the folded view when marking and raw when clearing", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts")];
    loadChangeset(fake, files);
    const calls = createCalls();
    const toggle = fake.commands.get("toggleViewed")!.handler;
    toggle(commandContext(files[0]!, [], [], calls));
    expect(calls.fileViewSelects).toEqual(["viewed"]);
    toggle(commandContext(files[0]!, [], [], calls));
    expect(calls.fileViewSelects).toEqual(["viewed", null]);
  });

  test("foldViewed anchors on a viewed file, applies to all matching, and restores the selection", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[1]!, new Date());
    const calls = createCalls();
    const selected: string[] = [];
    fake.commands.get("foldViewed")!.handler(commandContext(files[0]!, selected, [], calls));
    expect(selected).toEqual(["2", "1"]);
    expect(calls.fileViewSelects).toEqual(["viewed"]);
    expect(calls.executed).toEqual(["hunk.view.applyFilePresentationToAllMatching"]);
  });

  test("foldViewed notifies when nothing is viewed", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    loadChangeset(fake, [makeFile("1", "a.ts")]);
    const notified: Array<[string, string | undefined]> = [];
    fake.commands.get("foldViewed")!.handler(commandContext(null, [], notified));
    expect(notified[0]?.[0]).toBe("No viewed files to fold");
  });
});
```

Update the existing `toggleViewed` test's `commandContext` calls so the stub has `fileViews` (pass a `createCalls()` recorder) — otherwise `ctx.fileViews.select` throws.

- [ ] **Step 6: Verify**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun run typecheck && bun test`
Expected: clean, all pass. If `registerFileView`'s `layout` type complains about the sync return, wrap as `layout: ({ file }) => buildFoldedLayout(file)` returning `ExtensionFileViewLayout` — the union accepts it.

- [ ] **Step 7: Commit**

```bash
cd ~/work/hunk-viewed && git add -A && git commit -m "feat: fold viewed files to one line with a file view"
```

---

### Task 3: Single-file state, transform, and neighbor helper

**Files:**
- Create: `src/singleFile.ts`, `src/singleFile.test.ts`
- Modify: `src/reviewMirror.ts`, `src/reviewMirror.test.ts`

**Interfaces:**
- reviewMirror: `allFiles: readonly ExtensionDiffFile[]` (initial `[]`), `setMirrorAllFiles(files)`.
- singleFile:
  - `interface SingleFileState { active: boolean; targetPath: string | null; pendingPath: string | null }`
  - `getSingleFileState()`, `subscribeSingleFile(listener)`, `useSingleFileState()`
  - `enterSingleFile(targetPath: string | null)`, `exitSingleFile()`, `setSingleFileTarget(path: string)`, `setSingleFilePending(path: string | null)`
  - `applySingleFileTransform(changeset: ExtensionChangeset, state: SingleFileState): ExtensionChangeset` (pure)
  - `neighborPath(files: readonly ExtensionDiffFile[], targetPath: string | null, direction: 1 | -1): string | null` — wraps? No: no wrap; null target → first/last.
  - `resetSingleFileForTests()`

- [ ] **Step 1: Write failing tests**

Add to `src/reviewMirror.test.ts`:

```ts
  test("setMirrorAllFiles records the untransformed list separately from files", () => {
    const all = [file("1", "a.ts"), file("2", "b.ts")];
    setMirrorAllFiles(all);
    setMirrorFiles([all[0]!]);
    expect(getReviewMirror().allFiles.length).toBe(2);
    expect(getReviewMirror().files.length).toBe(1);
  });
```
and update the "starts empty" expectation to include `allFiles: []`.

`src/singleFile.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionChangeset, ExtensionDiffFile } from "hunkdiff/extension";
import {
  applySingleFileTransform,
  enterSingleFile,
  exitSingleFile,
  getSingleFileState,
  neighborPath,
  resetSingleFileForTests,
  setSingleFilePending,
  setSingleFileTarget,
  subscribeSingleFile,
} from "./singleFile";

function file(id: string, path: string): ExtensionDiffFile {
  return { id, path, patch: "", stats: { additions: 0, deletions: 0 }, metadata: {}, agent: null };
}
const files = [file("1", "a.ts"), file("2", "b.ts"), file("3", "c.ts")];
const changeset: ExtensionChangeset = { id: "cs", sourceLabel: "t", title: "t", files };

beforeEach(() => resetSingleFileForTests());

describe("single-file state", () => {
  test("starts inactive", () => {
    expect(getSingleFileState()).toEqual({ active: false, targetPath: null, pendingPath: null });
  });
  test("enter, retarget, pending, exit publish new snapshots", () => {
    let notified = 0;
    subscribeSingleFile(() => notified++);
    enterSingleFile("a.ts");
    expect(getSingleFileState()).toEqual({ active: true, targetPath: "a.ts", pendingPath: null });
    setSingleFileTarget("b.ts");
    setSingleFilePending("c.ts");
    expect(getSingleFileState()).toEqual({ active: true, targetPath: "b.ts", pendingPath: "c.ts" });
    exitSingleFile();
    expect(getSingleFileState()).toEqual({ active: false, targetPath: null, pendingPath: null });
    expect(notified).toBe(4);
  });
});

describe("applySingleFileTransform", () => {
  test("returns the changeset unchanged when inactive", () => {
    expect(applySingleFileTransform(changeset, getSingleFileState())).toBe(changeset);
  });
  test("keeps only the target file when active", () => {
    const out = applySingleFileTransform(changeset, { active: true, targetPath: "b.ts", pendingPath: null });
    expect(out.files.map((f) => f.id)).toEqual(["2"]);
    expect(out.id).toBe("cs");
  });
  test("returns the changeset unchanged when the target is missing", () => {
    expect(applySingleFileTransform(changeset, { active: true, targetPath: "zzz", pendingPath: null })).toBe(changeset);
  });
});

describe("neighborPath", () => {
  test("moves without wrapping", () => {
    expect(neighborPath(files, "a.ts", 1)).toBe("b.ts");
    expect(neighborPath(files, "c.ts", 1)).toBeNull();
    expect(neighborPath(files, "a.ts", -1)).toBeNull();
    expect(neighborPath(files, "b.ts", -1)).toBe("a.ts");
  });
  test("null or unknown target starts at an end", () => {
    expect(neighborPath(files, null, 1)).toBe("a.ts");
    expect(neighborPath(files, "missing", -1)).toBe("c.ts");
    expect(neighborPath([], null, 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/singleFile.test.ts src/reviewMirror.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/reviewMirror.ts`: add `allFiles: readonly ExtensionDiffFile[]` to the interface (JSDoc: "Every file the changeset transform saw before single-file mode dropped any; equals `files` outside that mode."), `allFiles: []` to `initial`, and:

```ts
/** Record the untransformed changeset from inside the changeset transform. */
export function setMirrorAllFiles(files: readonly ExtensionDiffFile[]): void {
  publish({ allFiles: files });
}
```

`src/singleFile.ts`:

```ts
import { useSyncExternalStore } from "react";
import type { ExtensionChangeset, ExtensionDiffFile } from "hunkdiff/extension";

/** Single-file mode: which file the review shows while the mode is active. */
export interface SingleFileState {
  active: boolean;
  /** Path of the one file the changeset transform keeps. */
  targetPath: string | null;
  /** Path a pane click chose; `enter` inside the mode loads it. */
  pendingPath: string | null;
}

const initial: SingleFileState = { active: false, targetPath: null, pendingPath: null };
let state: SingleFileState = initial;
const listeners = new Set<() => void>();

function publish(next: SingleFileState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Return the current immutable snapshot. */
export function getSingleFileState(): SingleFileState {
  return state;
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeSingleFile(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the snapshot from a React component. */
export function useSingleFileState(): SingleFileState {
  return useSyncExternalStore(subscribeSingleFile, getSingleFileState);
}

/** Turn the mode on with the given target. */
export function enterSingleFile(targetPath: string | null): void {
  publish({ active: true, targetPath, pendingPath: null });
}

/** Turn the mode off and forget the target. */
export function exitSingleFile(): void {
  publish(initial);
}

/** Point the mode at another file. */
export function setSingleFileTarget(path: string): void {
  publish({ ...state, targetPath: path, pendingPath: null });
}

/** Remember a pane click until `enter` loads it. */
export function setSingleFilePending(path: string | null): void {
  publish({ ...state, pendingPath: path });
}

/** Keep only the target file while the mode is active; otherwise return the changeset as is. */
export function applySingleFileTransform(changeset: ExtensionChangeset, current: SingleFileState): ExtensionChangeset {
  if (!current.active || current.targetPath === null) return changeset;
  const kept = changeset.files.filter((file) => file.path === current.targetPath);
  if (kept.length === 0) return changeset;
  return { ...changeset, files: kept };
}

/** Path of the file before/after `targetPath` in `files`, no wrap; null/unknown target starts at an end. */
export function neighborPath(
  files: readonly ExtensionDiffFile[],
  targetPath: string | null,
  direction: 1 | -1,
): string | null {
  const index = targetPath === null ? -1 : files.findIndex((file) => file.path === targetPath);
  const next = index === -1 ? (direction === 1 ? 0 : files.length - 1) : index + direction;
  return files[next]?.path ?? null;
}

/** Reset module state between tests. */
export function resetSingleFileForTests(): void {
  state = initial;
  listeners.clear();
}
```

- [ ] **Step 4: Verify and commit**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun run typecheck && bun test`
Expected: clean, all pass.

```bash
cd ~/work/hunk-viewed && git add -A && git commit -m "feat: add single-file mode state and changeset transform"
```

---

### Task 4: Wire single-file mode (command, keyboard mode, transform, pane)

**Files:**
- Modify: `index.tsx`, `src/sidebar/FilesPane.tsx`, `index.test.ts`

**Interfaces:**
- Consumes Task 3 exports and `setMirrorAllFiles`.
- Produces: command `singleFile` (key `o`), keyboard mode `single`, `hunk.transformChangeset` registration; pane behavior in single mode.

- [ ] **Step 1: index.tsx changes**

Imports: re-add `import { matchesKey } from "hunkdiff/extension";` and `type ExtensionKeyEvent`; add `setMirrorAllFiles` to the mirror import; add
`import { applySingleFileTransform, enterSingleFile, exitSingleFile, getSingleFileState, neighborPath, setSingleFileTarget } from "./src/singleFile";`.
Add `const SINGLE_MODE_ID = "single";`.

Transform, registered right after the event handlers:

```ts
  hunk.transformChangeset((changeset) => {
    setMirrorAllFiles(changeset.files);
    return applySingleFileTransform(changeset, getSingleFileState());
  });
```

A helper used by the mode and by J/K/v in single mode:

```ts
  /** Point single-file mode at `path` and reload so the transform applies. */
  function retarget(path: string, execute: (commandId: string) => boolean) {
    setSingleFileTarget(path);
    execute("hunk.app.refresh");
  }
```

Single-mode branches in the three commands. In `toggleViewed`, after marking (the `"marked"` path), replace the jump with:

```ts
    if (getSingleFileState().active) {
      const next = findUnviewedNeighbor(getReviewMirror().allFiles, file.id, 1, isViewedFile);
      if (next) retarget(next.path, (id) => ctx.commands.execute(id));
      else ctx.notify("No unviewed file after this one", "info");
      return;
    }
```
(keep `ctx.fileViews.select(FOLDED_VIEW_ID)` before it). In `nextUnviewed` / `previousUnviewed`, when `getSingleFileState().active`, search `getReviewMirror().allFiles` using the current target's file id (find the file whose `path === targetPath`, else `null`) and `retarget(next.path, ...)` instead of `selectFile`.

Keyboard mode and command:

```ts
  hunk.registerKeyboardMode({
    id: SINGLE_MODE_ID,
    title: "Single file",
    onEnter(ctx) {
      const mirror = getReviewMirror();
      const selected = mirror.files.find((file) => file.id === mirror.selectedFileId) ?? mirror.files[0];
      enterSingleFile(selected?.path ?? null);
      ctx.commands.execute("hunk.app.refresh");
    },
    onExit(ctx) {
      exitSingleFile();
      ctx.commands.execute("hunk.app.refresh");
    },
    onKey(key: ExtensionKeyEvent, ctx) {
      const { targetPath, pendingPath } = getSingleFileState();
      const files = getReviewMirror().allFiles;
      if (matchesKey(".", key) || matchesKey(",", key)) {
        const next = neighborPath(files, targetPath, matchesKey(".", key) ? 1 : -1);
        if (next) retarget(next, (id) => ctx.commands.execute(id));
        return "handled";
      }
      if (matchesKey("enter", key)) {
        if (pendingPath) retarget(pendingPath, (id) => ctx.commands.execute(id));
        return "handled";
      }
      return "pass";
    },
  });

  hunk.registerCommand({ id: "singleFile", title: "Single-file mode (o toggles, Esc exits)", key: "o" }, (ctx) => {
    if (ctx.keyboardModes.isActive(SINGLE_MODE_ID)) ctx.keyboardModes.exitMode();
    else ctx.keyboardModes.enterMode(SINGLE_MODE_ID);
  });
```

Update the module header comment to describe `o`, `,`/`.`, `Enter`, and the fold behavior.

- [ ] **Step 2: FilesPane changes**

Import `useReviewMirror` (again) and `useSingleFileState`, `setSingleFilePending` from `../singleFile`, and `basename` from `node:path/posix`.

```tsx
  const single = useSingleFileState();
  const mirror = useReviewMirror();
  const listFiles = single.active ? mirror.allFiles : files;
  const highlightedId = single.active
    ? (listFiles.find((file) => file.path === single.targetPath)?.id ?? null)
    : selectedFileId;
```
Use `listFiles` everywhere the pane used `files` (entries, viewedByFileId, counter, scroll effect) and `highlightedId` where it used `selectedFileId`. Row click:

```tsx
  const onSelectFile = (fileId: string) => {
    if (!single.active) {
      actions.selectFile(fileId);
      return;
    }
    const file = listFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    setSingleFilePending(file.path);
    actions.notify(`Enter loads ${basename(file.path)}`, "info");
  };
```
Title: when single mode is active, prefix ` Single ` in `theme.accent`? Keep it simple: the host shows the mode badge; the title stays ` Files  n/m viewed` with `listFiles.length` as `m`.

- [ ] **Step 3: Tests in index.test.ts**

Extend `createFakeHunk` with `transforms: Array<(c: ExtensionChangeset) => ExtensionChangeset>` and `transformChangeset: (fn) => transforms.push(fn)`. Extend `commandContext` with `keyboardModes: { isActive: () => calls.modeActive, enterMode: () => { calls.modeActive = true; return true; }, exitMode: () => { calls.modeActive = false; return true; } }` (add `modeActive: boolean` to `CommandCalls`). Add a `modeContext(calls)` helper returning `{ commands: { execute } } as unknown as ExtensionKeyboardModeContext`.

```ts
describe("single-file mode", () => {
  test("o toggles the mode; enter sets the target and refreshes; exit restores", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    fake.events.get("selection_changed")!({ fileId: "2", hunkIndex: null }, eventContext(repoDir));
    const calls = createCalls();
    const single = fake.commands.get("singleFile")!.handler;
    single(commandContext(files[1]!, [], [], calls));
    expect(calls.modeActive).toBe(true);
    const mode = fake.keyboardModes.get("single")!;
    mode.onEnter!(modeContext(calls));
    expect(getSingleFileState()).toEqual({ active: true, targetPath: "b.ts", pendingPath: null });
    expect(calls.executed).toEqual(["hunk.app.refresh"]);
    single(commandContext(files[1]!, [], [], calls));
    expect(calls.modeActive).toBe(false);
    mode.onExit!(modeContext(calls));
    expect(getSingleFileState().active).toBe(false);
    expect(calls.executed).toEqual(["hunk.app.refresh", "hunk.app.refresh"]);
  });

  test("the transform records allFiles and keeps only the target while active", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts")];
    const transform = fake.transforms[0]!;
    expect(transform(makeChangeset(files)).files.length).toBe(2);
    expect(getReviewMirror().allFiles.length).toBe(2);
    enterSingleFile("b.ts");
    expect(transform(makeChangeset(files)).files.map((f) => f.id)).toEqual(["2"]);
  });

  test(", and . retarget with a refresh; enter loads the pending file; other keys pass", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    fake.transforms[0]!(makeChangeset(files));
    enterSingleFile("a.ts");
    const calls = createCalls();
    const mode = fake.keyboardModes.get("single")!;
    expect(mode.onKey({ name: "." } as ExtensionKeyEvent, modeContext(calls))).toBe("handled");
    expect(getSingleFileState().targetPath).toBe("b.ts");
    expect(mode.onKey({ name: "," } as ExtensionKeyEvent, modeContext(calls))).toBe("handled");
    expect(getSingleFileState().targetPath).toBe("a.ts");
    setSingleFilePending("c.ts");
    expect(mode.onKey({ name: "enter" } as ExtensionKeyEvent, modeContext(calls))).toBe("handled");
    expect(getSingleFileState().targetPath).toBe("c.ts");
    expect(mode.onKey({ name: "v" } as ExtensionKeyEvent, modeContext(calls))).toBe("pass");
    expect(calls.executed.filter((id) => id === "hunk.app.refresh").length).toBe(3);
  });

  test("J and K retarget over all files while the mode is active", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    fake.transforms[0]!(makeChangeset(files));
    loadChangeset(fake, [files[0]!]);
    enterSingleFile("a.ts");
    storeToggleViewed(files[1]!, new Date());
    const calls = createCalls();
    const selected: string[] = [];
    fake.commands.get("nextUnviewed")!.handler(commandContext(files[0]!, selected, [], calls));
    expect(selected).toEqual([]);
    expect(getSingleFileState().targetPath).toBe("c.ts");
    expect(calls.executed).toEqual(["hunk.app.refresh"]);
  });
});
```
Import `enterSingleFile`, `getSingleFileState`, `resetSingleFileForTests`, `setSingleFilePending` from `./src/singleFile`; call `resetSingleFileForTests()` in `beforeEach`. Update the "registers…" test: `fake.keyboardModes.size` is `1` with id `single`; commands include `singleFile` with key `o` and `foldViewed` without key.

- [ ] **Step 4: Verify and commit**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun run typecheck && bun test`
Expected: clean, all pass.

```bash
cd ~/work/hunk-viewed && git add -A && git commit -m "feat: add single-file mode driven by a changeset transform"
```

---

### Task 5: README and manual checklist

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

Keys table: remove the `F` row; add `o` — "Single-file mode: shows only the current file. Inside it `,`/`.` switch files, `Enter` loads a file clicked in the pane, `o` or `Esc` leaves." Add a line under the table: "**Extensions → Fold viewed files** folds every viewed file to one line; `v` folds and unfolds the file it marks." Update the keybinding example (`hunk-viewed.singleFile = "o"`, drop `filesMode`). In "Known limitations" add: "Folding is per loaded file, so after a reload run Fold viewed files again. The header bar of a folded file keeps its normal colors. Single-file mode reloads the review on every switch and starts at the top of the file."

- [ ] **Step 2: Commit**

```bash
cd ~/work/hunk-viewed && git add README.md && git commit -m "docs: describe folding and single-file mode"
```

- [ ] **Step 3: Manual TTY checklist (for the human)**

```bash
cd ~/work/hunk && hunk diff --extension ~/work/hunk-viewed HEAD~3
```
1. Check marks in the pane are green.
2. `v` folds the file to `✓ viewed  N hunks  +a -d` under its header and jumps on. `v` on it again unfolds and clears.
3. Restart: marks are back but files are unfolded; Extensions → Fold viewed files folds them all and the selection stays put.
4. `o` shows the "Single file" badge and only the current file. `,`/`.` switch files; the pane highlights the target and lists all files. Click a pane row, press `Enter`: that file loads. `o` again or `Esc` restores all files.
5. `J`/`K`/`v` inside single-file mode switch to the next unviewed file.
6. `F` no longer does anything.

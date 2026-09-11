# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [hunk](https://hunk.dev) extension (hunk 0.21, extension API 16) that adds GitLab-style "viewed" marks,
a replacement files pane, single-file mode, a full-file view, and content search. No build step: hunk
imports `index.tsx` directly. No runtime dependencies; `react`, `@opentui/*`, and `hunkdiff/extension`
come from the host. Dev dependencies exist only for types and tests.

## Commands

`bun` is not on PATH by default. Prefix with `export PATH="$HOME/.bun/bin:$PATH";` (Bun 1.4).

```bash
bun install
bun run typecheck                      # tsc --noEmit, strict + noUncheckedIndexedAccess
bun test                               # all tests (bun:test, colocated *.test.ts)
bun test src/search.test.ts            # one file
bun test -t "wraps"                    # tests whose name matches
hunk diff --extension ~/work/hunk-viewed   # manual TTY check against a real diff (uncommitted changes count)
bun run <hunk-checkout>/packages/hunk/src/main.tsx diff --extension ~/work/hunk-viewed   # against hunk from source (e.g. a PR worktree)
```

There is no linter or formatter configured.

## Where the API contract lives

- `node_modules/hunkdiff/dist/npm/extension/index.d.ts`: exact types for `HunkExtensionAPI`, contexts, events.
- `src/hunkdiff-api24.d.ts` augments those with the API 24 file-view syntax fields (`codeDocuments`,
  `span.syntax`) that the pinned `hunkdiff@0.21.0` predates. Delete it when the dev dependency ships them.
- `node_modules/hunkdiff/skills/hunk-extensions/SKILL.md`: hunk's own authoring guide and links.
- Command, keyboard-mode and event contexts expose different subsets. Keyboard modes have `commands`,
  `highlights`, `keyboardModes`, `notify` but no `navigation`/`panes`/`fileViews`. Event contexts have
  `navigation`, `panes`, `dialogs` but no `highlights`/`fileViews`. Only command handlers get everything,
  so all host side effects are driven from commands.

## Architecture

`index.tsx` is the only file that talks to hunk. It registers every pane, file view, command, keyboard
mode, line highlighter, changeset transform, and event handler, and does all host side effects
(`fileViews.refresh`, `highlights.refresh`, `revealLine`, `panes.open/close`, `hunk.app.refresh`).
Everything under `src/` is pure state and pure functions, testable without a host.

### Stores (module singletons, `useSyncExternalStore`)

Each store exposes `getXState()`, `subscribeX()`, `useX()`, mutators, and `resetXForTests()`. Stores
never call the host.

| Store | Holds |
| --- | --- |
| `src/reviewMirror.ts` | Mirror of the live review built from lifecycle events: `files` (filtered changeset), `allFiles` (untransformed changeset seen by the transform), `filter`, `selectedFileId`, `resolvedLayout`. `visibleFiles()` reimplements hunk's filter rule. |
| `src/viewedStore.ts` | Marks for the current repo. A file is viewed when the stored sha256 of its patch matches (`src/patchHash.ts`). Every publish calls the persist callback. |
| `src/singleFile.ts` | `active`, `targetPath`, `pendingPath` (pane click awaiting Enter), `returnPath` (file to reselect after exit). Also the pure changeset transform. |
| `src/expandAll.ts` | Expand-all flag and the set of files whose full view must decline (`collapsedFileIds`). Hunk can reset only the selected file to raw, so "collapse all" works by declining layouts and refreshing; `F` lifts a decline. |
| `src/search.ts` | Query, merged hits, current index, prompt draft, `fullViewFileIds`. Diff-file hits come from `parseUnifiedPatch(file.patch)`; full-view hits are reported by the full view's layout pass via `setDocumentHits`. |

### Persistence

`src/viewedFile.ts` owns the state file `$XDG_STATE_HOME/hunk/viewed.json` (`~/.local/state/...`,
`%LOCALAPPDATA%` on Windows). Save rereads the file, replaces only this repo's record, prunes entries
older than 30 days, and renames a temp file over the target. Repo key is the realpath of hunk's `cwd`.

### Presentation layers

- `src/foldedView.ts`: one-row "✓ viewed" file view, selected for viewed files by `V`.
- `src/fullFileView.ts` + `src/unifiedPatch.ts`: rebuilds the whole file as a unified diff from the
  new-side document plus the patch's removed lines. Single column or split (old | new). Returns `null`
  to fall back to the raw diff over 10,000 rows, when hunks disagree with the document, or when hunk's
  layout-validator span/char caps would be exceeded. Declares the new (and, when readable, old) document
  as `codeDocuments` and gives each context code span a `syntax` reference so hunk paints tokens; added and
  removed spans keep their solid tone, since token colors override `tone` and hunk paints no change
  background on file views. Every reference is verified against the document text first, because one
  mismatch makes hunk reject the whole layout.
- `src/sidebar/`: the replacement files pane (`replaces: "hunk:files"`), ported from hunk's bundled
  sidebar (MIT, Modem Labs). `paneSource.ts` picks `allFiles` vs `files` depending on single-file mode.
  `SearchBar.tsx` is the one-row bottom pane.

### Non-obvious host behaviors the code works around

- The changeset transform sees files without `changeType`/`hunks`; `index.tsx` caches the projected
  payload from `changeset_loaded`/`session_reload` by path and merges it back into `allFiles`.
- `layout_changed` fires only on changes after startup, so the full view guesses split at body width
  ≥ 116 until an event arrives.
- Bulk presentation changes go through `hunk.view.applyFilePresentationToAllMatching`, which applies the
  selected file's current view to every file that view's `matches` accepts and enables only after that
  file rendered it (`foldViewed`, `expandAll`). There is no bulk reset to raw.
- `fileViews.select`/`toggle` and `navigation.selectFile` only dispatch state. Handlers that depend on
  the result poll with `waitFor` (16 ms × 20) instead of assuming it applied.
- Single-file mode works by reloading (`hunk.app.refresh`) with a filtering transform, so it needs a
  reloadable input and every switch is a reload.
- The search prompt is a keyboard mode that swallows every key; the `search` command awaits a promise
  the mode resolves on Enter (draft) or exit (`null`).

## Testing conventions

- `index.test.ts` drives the factory through a fake `HunkExtensionAPI` (`createFakeHunk`) against the
  real store singletons; `beforeEach` calls every `reset*ForTests()`. Extend that fake when a new
  context method is used.
- Store and layout modules have colocated unit tests. Keep new logic in `src/` so it can be tested
  without the host.

## Docs

- `README.md` is the user-facing reference (keys, limitations). Update it when behavior changes.
- `docs/superpowers/specs/2026-09-03-hunk-viewed-design.md` is the design record, appended per round.
  `docs/superpowers/plans/` holds the implementation plans that produced each round.
- Command ids `nextUnviewed`/`previousUnviewed` are historical: they move to the next/previous file
  and never skip viewed files. `U` (`skipToUnviewed`) skips.
- Defaults avoid every key hunk 0.22 (`main` at the time) binds itself: `v`, `N`, `n` are taken there, so
  the extension uses `V`, `U`, `ctrl+n`/`ctrl+p`. Check hunk's `commandCatalog.ts` before adding a key.

## Git

- Default branch is `main`. Feature work happens on `feat/*` branches. Releases are tagged `vX.Y.Z`
  and bump `version` in `package.json` (`chore: release X.Y.Z`).
- Commit subjects use conventional prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

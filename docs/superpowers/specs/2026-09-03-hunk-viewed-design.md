# hunk-viewed — design

Date: 2026-09-03. Target: hunk 0.21.0, extension API version 16.

## Goal

A user extension for hunk that copies the "viewed" workflow from the GitLab merge-request diff
viewer: mark a file as viewed, see the mark next to the file, skip viewed files when moving
through the review, and keep the marks between hunk runs.

## Non-goals

- No core changes to hunk. Everything uses the public extension API.
- No hiding of viewed files. They stay in the review stream and in the files pane.
- No per-hunk marks.
- No single-file scroll clamp. The API gives no scroll control.
- No row windowing in the pane. A plain scrollbox is enough for normal changesets.

## API facts that shape the design

- Extensions can register commands with default keys, but a default key that clashes with a
  built-in is refused. `v`, `J`, `K`, and `F` are free.
- Extensions cannot decorate rows in the built-in files pane. They can replace the pane with
  `replaces: "hunk:files"`. The bundled pane's `s` key and View menu entry then follow ours.
- Extensions cannot hide files at runtime and cannot control scrolling. Navigation is limited
  to `selectFile`, `selectHunk`, and `revealLine`.
- A keyboard mode (`registerKeyboardMode`) receives keys before the command table. Its context
  has `commands.execute` for public `hunk.*` commands, but no navigation or selection access.
- Command handlers get `selection`, `navigation`, `review`, and `dialogs`.
- There is no storage API. The API docs accept that extensions use `node:fs`.
- The bundled sidebar code is MIT licensed and lives in `src/ui/lib/files.ts`,
  `src/ui/components/panes/FileListItem.tsx`, and `src/extensions/default/ui/sidebar/`.

## Behavior

### Commands

| Id                            | Key  | Menu | Action                                                            |
| ----------------------------- | ---- | ---- | ----------------------------------------------------------------- |
| `hunk-viewed.toggleViewed`    | `v`  | yes  | Unviewed file: mark it, then select the next unviewed file. Viewed file: clear the mark, stay. |
| `hunk-viewed.nextUnviewed`    | `J`  | yes  | Select the next unviewed visible file after the selection. No wrap. |
| `hunk-viewed.previousUnviewed`| `K`  | yes  | Select the previous unviewed visible file. No wrap.               |
| `hunk-viewed.filesMode`       | `F`  | yes  | Enter the files keyboard mode.                                    |
| `hunk-viewed.clearRepo`       | none | yes  | Confirm, then clear all marks for the current repo.               |

When no file is selected, or no unviewed file exists in the requested direction, the command
shows an info notice and does nothing else.

"Visible" means the file passes hunk's filter: lowercased trimmed substring match on the path.
`selectFile` refuses hidden ids, so the extension never targets them.

### Files keyboard mode

Title: `Files`. Hunk shows the mode badge while it is active.

| Key            | Result                                                 |
| -------------- | ------------------------------------------------------ |
| `j`, `down`    | handled: run `hunk.review.nextFile`                    |
| `k`, `up`      | handled: run `hunk.review.previousFile`                |
| `enter`        | exit                                                   |
| `esc`          | exit (host owned)                                      |
| everything else| pass                                                   |

`v`, `J`, and `K` pass through the mode and reach the extension's own commands with a full
command context. This keeps one implementation per action. The files pane draws its title row
in the accent color while the mode is active.

### Files pane

Registered with `replaces: "hunk:files"`, `placement: "left"`, `width: { preferred: 34, min: 22 }`,
the same size as the bundled pane.

Layout, top to bottom:

1. Title row: ` Files  3/12 viewed`. Accent color while the files mode is active, muted otherwise.
2. Entry rows in review order. Tree mode when the text width is 32 columns or more, flat mode
   below that. This is the bundled rule.
   - Directory rows (tree) and group headers (flat): ported from the bundled pane.
   - File rows: `▌` selection stripe or space, `✓` or space, status glyph (`A`, `D`, `R`, `M`, `?`),
     file name fitted to the width, right-aligned `+n -n` stats.
   - Viewed file: `✓` in `accentMuted`, name and stats in `muted`.
   - Selected file: stripe in `accent`, background `panelAlt`.
3. Clicking a file row selects it. The pane scrolls the selected row into view when the
   selection changes.

Colors come from the pane theme tokens the host passes as props.

## Architecture

```text
~/work/hunk-viewed/
  package.json                 name, version, "hunk": { apiVersion: 16, extensions: ["./index.tsx"] }
  index.tsx                    factory: register pane, commands, mode, event handlers
  src/reviewMirror.ts          files, filter, selectedFileId, filesModeActive; useSyncExternalStore hook
  src/viewedStore.ts           marks for the current repo; pure helpers; useSyncExternalStore hook
  src/viewedFile.ts            state file path, load, save (atomic), gc, merge
  src/patchHash.ts             sha256 of the patch text
  src/navigation.ts            nextUnviewed / previousUnviewed over visible files
  src/sidebar/entries.ts       ported flat and tree entry builders
  src/sidebar/rows.tsx         FileRow, DirectoryRow, GroupHeader
  src/sidebar/FilesPane.tsx    pane component
  *.test.ts                    colocated bun tests
  README.md                    install, keys, state file location, attribution
  LICENSE                      MIT
```

Runtime dependencies: none. `react`, `@opentui/*`, and `hunkdiff/extension` come from the host.
Dev dependencies for types and tests: `hunkdiff@0.21.0`, `react`, `@types/react`,
`@opentui/core`, `@opentui/react`, `typescript`.

### Data flow

```text
startup { cwd }             -> viewedFile.load(repoKey) -> viewedStore
changeset_loaded / session_reload -> reviewMirror.files; viewedStore.reconcile(files)
selection_changed           -> reviewMirror.selectedFileId
filter_changed              -> reviewMirror.filter
files mode onEnter/onExit   -> reviewMirror.filesModeActive
command v/J/K               -> viewedStore + ctx.navigation.selectFile
viewedStore change          -> viewedFile.save(repoKey, record)  (every change)
FilesPane                   -> reads reviewMirror + viewedStore via useSyncExternalStore
```

The pane also receives `files` and `selectedFileId` as props. It uses the props for rendering
and the stores only for viewed marks and the mode flag.

### Viewed identity

- Repo key: canonical real path of the startup `cwd`.
- File key: `file.path`.
- A file is viewed when the record holds its path and the stored hash equals
  `sha256(file.patch)`. A changed patch makes the file unviewed again, as in GitLab.
- `reconcile(files)` drops record entries whose path is present but whose hash no longer
  matches. Entries for paths not in the current changeset stay, so a filtered changeset
  (`hunk diff -- src/`) does not erase marks for other files.

### State file

Path: `$XDG_STATE_HOME/hunk/viewed.json`, default `~/.local/state/hunk/viewed.json`.
On Windows `%LOCALAPPDATA%\hunk\viewed.json`. Created with mode `0600`.

```json
{
  "version": 1,
  "repos": {
    "/home/ja/work/knox": {
      "files": {
        "src/a.ts": { "hash": "sha256 hex", "at": "2026-09-03T14:00:00.000Z" }
      }
    }
  }
}
```

Save: read the current file again, replace only this repo's record, drop entries whose `at` is
older than 30 days, write to a temp sibling, rename over the target. Rereading before writing
keeps two hunk sessions in different repos from erasing each other's marks. Two sessions in the
same repo still race; the last save wins, which is acceptable.

Load errors (missing file, bad JSON, wrong version) log a warning through `hunk.log` and start
with an empty record. Save errors show one warning notice and keep the in-memory state.

## Error handling

- Commands with no selection or no target: info notice, no state change.
- `selectFile` on a hidden id is impossible by construction; if the host still refuses, the
  host warning is enough.
- Thrown errors in handlers are contained by hunk and attributed to the extension. Handlers do
  no I/O except the state file save.

## Testing

- `bun test` covers `viewedStore`, `viewedFile` (load, save, gc, merge, corrupt input, XDG
  resolution), `patchHash`, `navigation`, and `sidebar/entries` (flat and tree, ported cases).
- Manual TTY check from the hunk checkout on a real diff:
  `hunk diff --extension ~/work/hunk-viewed`. Verify: pane replaces the files pane, `v` marks and
  jumps, `J`/`K` skip, `F` mode moves with `j`/`k`, marks survive a restart, a changed file loses
  its mark.

## Install

Development: `hunk diff --extension ~/work/hunk-viewed`.
Permanent: `hunk extension install ~/work/hunk-viewed`, or a symlink at
`~/.config/hunk/extensions/hunk-viewed`.

---

# Round 2 — 2026-09-04

Changes after the first smoke run. Everything above stays valid unless this section says otherwise.

## A. Brighter check mark

The pane's `✓` uses `theme.badgeAdded` (the `+N` green) instead of `accentMuted`.

## B. Folded viewed files (replaces the `F` files mode)

- The extension registers a file view `hunk-viewed:viewed` titled `Viewed`. `matches(file)` is
  "the file is viewed". `layout` returns one row, `✓ viewed  <n> hunks  +a -d` (check tone
  `added`, rest `muted`), with every hunk mapped to row 0. A file with no hunks returns zero rows
  and folds to its header alone.
- `v` on an unviewed file: mark, `ctx.fileViews.select("viewed")` on the selected file (skipped
  in single-file mode, since retargeting drops the file from the changeset anyway), then jump
  to the next unviewed file. `v` on a viewed file: clear the mark, `ctx.fileViews.select(null)`,
  stay.
- `layout` re-checks `isViewed` itself and returns `null` when the file is not viewed, rather
  than trusting `matches` to have gated every call: hunk can ask a view to re-derive a stale
  presentation (e.g. right after `clearRepo`), and a declined layout falls back to the raw diff.
- `clearRepo` calls `ctx.fileViews.refresh("viewed")` after clearing, so every row still
  presenting the folded view redraws raw instead of showing a stale "✓ viewed" line.
- New menu command `hunk-viewed.foldViewed`, "Fold viewed files", no key. `ctx.fileViews.select`
  and `ctx.navigation.selectFile` only dispatch React state; the bulk command
  (`hunk.view.applyFilePresentationToAllMatching`) only enables once the selected file has
  actually rendered that presentation, which does not happen synchronously within the handler.
  So the precondition is stricter than "select any viewed file for the user": the file already
  selected when the command runs must already be viewed (notice otherwise), and single-file mode
  must be inactive (notice otherwise, since retargeting empties the changeset before a fold could
  apply to more than one file). The handler is `async`: it selects the view, then polls
  `ctx.commands.isEnabled(...)` every 16 ms (up to 20 tries) until the bulk command is enabled,
  then executes it — a warning notice if the wait times out or the execute call itself fails.
- The `F` command and the `files` keyboard mode are removed. `filesModeActive` leaves the mirror.
- Limits: the host header bar keeps its normal colors; folding is per runtime file id, so a
  reload can unfold files until "Fold viewed files" runs again.

## C. Single-file mode

- New command `hunk-viewed.singleFile`, key `o`, title "Single-file mode". If the mode is
  already active it exits. Otherwise it guards on a reloadable input
  (`ctx.commands.isEnabled("hunk.app.refresh")`; a notice and no state change if that is false,
  e.g. a piped patch) and, only once that passes, seeds the target itself
  (`ctx.selection.file?.path`, falling back to the mirror's first file) before entering the
  keyboard mode `hunk-viewed:single` ("Single file"). Seeding happens in the command rather than
  the mode's `onEnter` because the host's selection can be debounced by the time `onEnter` runs;
  the command's own `ctx.selection.file` is the fresh value. `Esc` also exits (host owned).
- State module `src/singleFile.ts`: `{ active: boolean; targetPath: string | null;
  pendingPath: string | null }` with a subscribe hook; `setSingleFileTarget`/`setSingleFilePending`
  are no-ops when the value would not change. `reviewMirror` gains `allFiles`, the full changeset
  the transform saw before dropping files.
- `hunk.transformChangeset`: always records `allFiles`; when active with a target, returns the
  changeset with only the file whose `path` equals the target. If the target is missing, it
  returns the changeset unchanged. The transform's own `changeset.files` never carries
  `changeType`/`hunks` (hunk fills those in later, on the read-only payload lifecycle events
  carry), so `allFiles` is light-projected: a `changeset_loaded`/`session_reload` handler caches
  that payload by path (skipped while single-file mode is active, since a mode-driven reload only
  ever renders the one target file) and the transform merges `changeType`/`hunks` back in from
  that cache when it records `allFiles`.
- Mode `onEnter` only runs `hunk.app.refresh` — the target is already set by the `singleFile`
  command. `onExit`: `active = false`, target and pending cleared, refresh.
- Mode keys: `,` / `.` move the target to the previous / next file in `allFiles` (viewed or not)
  and refresh, or notify ("No file before/after this one") at either end; `enter` loads
  `pendingPath` and refreshes if set, otherwise passes through untouched; everything else passes.
  Every retarget that reloads (`,`/`.`, `enter`, and `J`/`K`/`v` below) warns
  "This input cannot be reloaded, so single-file mode is unavailable" if the refresh command
  itself returns `false`.
- In single mode, `J`, `K`, and `v` compute their target over `allFiles` and switch by setting
  the target and refreshing instead of `selectFile`.
- Pane in single mode: rows come from `allFiles`; the highlighted row is the target; the counter
  is over `allFiles`; a click records `pendingPath` and shows the notice
  `Enter loads <name>`.
- Cost: each toggle and switch is a reload. Scroll starts at the top of the file.

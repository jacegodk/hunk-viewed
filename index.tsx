/**
 * hunk-viewed: GitLab-style "viewed" marks for hunk.
 *
 * `v` marks the selected file, folds it, and stays selected; on a viewed file it clears the
 * mark, unfolds it, and stays. `F` toggles the full-file view: the whole file as a diff with
 * unlimited context. `J` / `K` move to the next/previous file, walking every visible file in
 * every mode; viewed files are never skipped. `o` toggles single-file mode, which shows only
 * one file at a time; inside it `,`/`.` retarget the previous/next file and `Enter` loads a file
 * clicked in the pane, with `J`/`K` retargeting instead of jumping the full review. Marks
 * persist per repo in the XDG state dir and reset when a file's patch changes. The pane replaces
 * hunk's files pane and shows marks and progress.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionCommandContext, ExtensionContext, ExtensionDiffFile, ExtensionKeyEvent, HunkExtensionAPI } from "hunkdiff/extension";
import { matchesKey } from "hunkdiff/extension";
import { FOLDED_VIEW_ID, buildFoldedLayout } from "./src/foldedView";
import { FULL_VIEW_ID, buildFullFileLayout } from "./src/fullFileView";
import { findUnviewedNeighbor } from "./src/navigation";
import {
  getReviewMirror,
  setMirrorAllFiles,
  setMirrorFiles,
  setMirrorFilter,
  setMirrorResolvedLayout,
  setMirrorSelectedFileId,
  visibleFiles,
} from "./src/reviewMirror";
import {
  applySingleFileTransform,
  clearSingleFileReturn,
  enterSingleFile,
  exitSingleFile,
  getSingleFileState,
  neighborPath,
  setSingleFileTarget,
} from "./src/singleFile";
import { FilesPane } from "./src/sidebar/FilesPane";
import { parseUnifiedPatch } from "./src/unifiedPatch";
import { readRepoFiles, resolveViewedFilePath, writeRepoFiles } from "./src/viewedFile";
import { clearRepo, getViewedState, isViewed, loadRepo, reconcileViewed, setPersist, toggleViewed } from "./src/viewedStore";

const FILES_PANE_ID = "files";
const SINGLE_MODE_ID = "single";

/** Poll `check` every 16 ms until it passes or `tries` runs out; returns whether it passed. */
async function waitFor(check: () => boolean, tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return false;
}

/** Register the hunk-viewed pane, commands, keyboard mode, and event handlers. */
export default function (hunk: HunkExtensionAPI) {
  const stateFilePath = resolveViewedFilePath(process.env, process.platform, homedir());
  let saveFailureNotified = false;

  /**
   * Load the marks for `cwd`'s repo when it differs from the one currently loaded, and wire
   * persistence to `notify`. A reload into a different repo (a new `startup` on the same
   * module instance) must reload marks and re-point saves at the new caller's `notify`,
   * not keep serving the previous repo's state under the new repo's identity.
   */
  function ensureRepoLoaded(cwd: string, notify: ExtensionContext["notify"]) {
    let repoKey: string;
    try {
      repoKey = realpathSync(cwd);
    } catch {
      repoKey = cwd;
    }
    if (getViewedState().repoKey !== repoKey) {
      loadRepo(repoKey, readRepoFiles(stateFilePath, repoKey, hunk.log));
    }
    setPersist((key, files) => {
      try {
        writeRepoFiles(stateFilePath, key, files, new Date(), hunk.log);
        saveFailureNotified = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        hunk.log(`hunk-viewed: could not save ${stateFilePath}: ${message}`);
        if (!saveFailureNotified) {
          saveFailureNotified = true;
          notify(`hunk-viewed: could not save ${stateFilePath}: ${message}`, "warning");
        }
      }
    });
  }

  /**
   * Files to search for the next/previous unviewed neighbor around `selectedFileId`.
   *
   * Normally the mirrored, filtered visible set — but the mirror's filter is derived from
   * events and can lag the host's own filter state for one frame (e.g. right after a hard
   * session reload). If the selection the host gave us is not in that derived set, fall back
   * to the full file list so the jump still walks forward from the real selection instead of
   * `findUnviewedNeighbor` treating it as "not found" and restarting from index 0.
   */
  function navigationFiles(selectedFileId: string | null): ExtensionDiffFile[] {
    const visible = visibleFiles(getReviewMirror());
    if (selectedFileId !== null && !visible.some((file) => file.id === selectedFileId)) {
      return [...getReviewMirror().files];
    }
    return visible;
  }

  // The changeset transform only ever sees hunk's internal, unprojected files (no `changeType`
  // or `hunks`); those fields are filled in later, on the read-only payload the lifecycle events
  // carry. Cache that payload by path here so the transform can merge the fields back in when it
  // records `allFiles`. Left alone while single-file mode is active, since a mode-driven reload
  // only ever renders the one target file and would otherwise erase every other file's fields.
  let projectedByPath = new Map<string, ExtensionDiffFile>();
  function refreshProjectedFiles(files: readonly ExtensionDiffFile[]) {
    if (getSingleFileState().active) return;
    projectedByPath = new Map(files.map((file) => [file.path, file]));
  }

  hunk.on("startup", ({ cwd }, ctx) => ensureRepoLoaded(cwd, ctx.notify));
  hunk.on("changeset_loaded", ({ changeset }, ctx) => {
    ensureRepoLoaded(ctx.cwd, ctx.notify);
    setMirrorFiles(changeset.files);
    reconcileViewed(changeset.files);
    refreshProjectedFiles(changeset.files);
  });
  hunk.on("session_reload", ({ changeset }, ctx) => {
    setMirrorFiles(changeset.files);
    reconcileViewed(changeset.files);
    refreshProjectedFiles(changeset.files);
    // The reload that follows leaving single-file mode: reselect the file that mode was showing,
    // scrolled to the top, instead of leaving the selection wherever it lands by default.
    const { returnPath } = getSingleFileState();
    if (returnPath) {
      const file = changeset.files.find((f) => f.path === returnPath);
      clearSingleFileReturn();
      // `session_reload` fires after every child layout effect for the new changeset has
      // committed, so a synchronous `selectFile` here would already resolve against the right
      // state. What is not settled yet is the *scroll*: folded/full file-view render plans
      // re-prepare asynchronously after a reload, so the header's top-of-file reveal can still
      // move after this handler returns. Select twice — once deferred past the current tick, and
      // once more once those plans have had time to resolve — since selecting an already-selected
      // file still bumps hunk's file-top reveal token and re-aligns the header. `ctx.navigation`
      // is a live guard, safe to call after the handler returns.
      if (file) {
        setTimeout(() => ctx.navigation.selectFile(file.id), 0);
        setTimeout(() => {
          // Only re-align if the user is still on the file this reselect is for: `,`/`.`/`J`/`K`
          // between the two timeouts already moved `selection_changed` on, and firing here
          // unconditionally would yank the selection back to the file they left.
          const { selectedFileId } = getReviewMirror();
          if (selectedFileId === null || selectedFileId === file.id) ctx.navigation.selectFile(file.id);
        }, 60);
      }
    }
  });
  hunk.on("selection_changed", ({ fileId }) => setMirrorSelectedFileId(fileId));
  hunk.on("filter_changed", ({ filter }) => setMirrorFilter(filter));
  hunk.on("layout_changed", ({ layout }) => setMirrorResolvedLayout(layout));

  hunk.transformChangeset((changeset) => {
    setMirrorAllFiles(
      changeset.files.map((file) => {
        const projected = projectedByPath.get(file.path);
        return {
          id: file.id,
          path: file.path,
          previousPath: file.previousPath,
          patch: file.patch,
          stats: file.stats,
          statsTruncated: file.statsTruncated,
          isUntracked: file.isUntracked,
          isBinary: file.isBinary,
          agent: file.agent ?? null,
          metadata: {},
          changeType: projected?.changeType,
          hunks: projected?.hunks,
        } satisfies ExtensionDiffFile;
      }),
    );
    return applySingleFileTransform(changeset, getSingleFileState());
  });

  /**
   * Point single-file mode at `path` and reload so the transform applies. Warns instead of
   * silently doing nothing when the current input cannot be reloaded (e.g. a piped patch).
   */
  function retarget(path: string, execute: (commandId: string) => boolean, notify: ExtensionContext["notify"]) {
    setSingleFileTarget(path);
    if (!execute("hunk.app.refresh")) {
      notify("This input cannot be reloaded, so single-file mode is unavailable", "warning");
    }
  }

  hunk.registerPane({
    id: FILES_PANE_ID,
    title: "Files (viewed)",
    placement: "left",
    replaces: "hunk:files",
    width: { preferred: 34, min: 22 },
    component: FilesPane,
  });

  hunk.registerFileView({
    id: FOLDED_VIEW_ID,
    title: "Viewed",
    matches: (file) => isViewed(getViewedState(), file),
    // `matches` gates which files can select this view, but hunk can still ask `layout` to
    // re-derive a stale presentation (e.g. after a refresh cleared the mark); decline it there too.
    layout: ({ file }) => (isViewed(getViewedState(), file) ? buildFoldedLayout(file) : null),
  });

  hunk.registerFileView({
    id: FULL_VIEW_ID,
    title: "Full file",
    matches: (file) => !file.isBinary && !file.isTooLarge && (file.hunks?.length ?? 0) > 0 && file.changeType !== "deleted",
    async layout(input) {
      if (input.file.statsTruncated) return null;
      const hunks = parseUnifiedPatch(input.file.patch);
      if (hunks.length === 0) return null;
      // The row-parity guard that keeps this view from lying about a file hunk didn't parse:
      // decline before reading the document so a mismatch falls back to the raw diff.
      if (hunks.length !== (input.file.hunks?.length ?? 0)) return null;
      const document = await input.readDocument("new");
      if (document === null || input.signal.aborted) return null;
      // hunk only announces its resolved layout on a change after startup (`layout_changed`), so
      // this heuristic applies for the whole session whenever hunk has not reported one, not just
      // until a first event arrives. hunk's own `auto` mode splits at terminal width >= 120; the
      // file view itself gets `reviewBounds.width - 2`, and the sidebar (34 cols) disappears below
      // terminal width 160 — so the file-view body width at the split threshold is 116.
      const layout = getReviewMirror().resolvedLayout ?? (input.width >= 116 ? "split" : "stack");
      return buildFullFileLayout(document, hunks, { columns: layout === "split" ? "split" : "single", width: input.width });
    },
  });

  hunk.registerCommand({ id: "fullFile", title: "Toggle full file", key: "F" }, (ctx) => {
    if (!ctx.selection.file) {
      ctx.notify("No file selected", "info");
      return;
    }
    ctx.fileViews.toggle(FULL_VIEW_ID);
  });

  hunk.registerCommand({ id: "toggleViewed", title: "Toggle viewed on the selected file", key: "v" }, (ctx) => {
    const file = ctx.selection.file;
    if (!file) {
      ctx.notify("No file selected", "info");
      return;
    }
    const result = toggleViewed(file, new Date());
    ctx.fileViews.select(result === "cleared" ? null : FOLDED_VIEW_ID);
  });

  /**
   * Move to the neighboring file: any visible file, viewed or not, both outside and inside
   * single mode. Shared by `nextUnviewed` and `previousUnviewed`, which only differ in direction.
   */
  function jumpFile(ctx: ExtensionCommandContext, direction: 1 | -1) {
    const single = getSingleFileState();
    if (single.active) {
      const next = neighborPath(getReviewMirror().allFiles, single.targetPath, direction);
      if (next) retarget(next, (id) => ctx.commands.execute(id), ctx.notify);
      else ctx.notify(direction === 1 ? "No file after this one" : "No file before this one", "info");
      return;
    }
    const selectedFileId = ctx.selection.file?.id ?? null;
    const next = findUnviewedNeighbor(navigationFiles(selectedFileId), selectedFileId, direction, () => false);
    if (next) ctx.navigation.selectFile(next.id);
    else ctx.notify(direction === 1 ? "No file after this one" : "No file before this one", "info");
  }

  hunk.registerCommand({ id: "nextUnviewed", title: "Next file", key: "J" }, (ctx) => jumpFile(ctx, 1));

  hunk.registerCommand({ id: "previousUnviewed", title: "Previous file", key: "K" }, (ctx) =>
    jumpFile(ctx, -1),
  );

  hunk.registerCommand({ id: "clearRepo", title: "Clear viewed marks for this repo" }, async (ctx) => {
    const count = Object.keys(getViewedState().files).length;
    const confirmed = await ctx.dialogs.confirm({
      title: "Clear viewed marks",
      body: `Remove ${count} viewed mark${count === 1 ? "" : "s"} for this repo?`,
      confirmLabel: "Clear",
    });
    if (!confirmed) return;
    clearRepo();
    // Every row still presenting the folded view now fails `matches`; ask hunk to redraw them
    // raw instead of leaving a stale "✓ viewed" row on screen.
    ctx.fileViews.refresh(FOLDED_VIEW_ID);
  });

  hunk.registerCommand({ id: "foldViewed", title: "Fold viewed files" }, async (ctx) => {
    if (getSingleFileState().active) {
      ctx.notify("Leave single-file mode to fold all files", "info");
      return;
    }
    const file = ctx.selection.file;
    if (!file || !isViewed(getViewedState(), file)) {
      ctx.notify("Select a viewed file, then fold", "info");
      return;
    }
    // The bulk command only applies to files presenting the view, so select it on the already-
    // viewed selection first, then wait for the render that follows to catch up before running it.
    ctx.fileViews.select(FOLDED_VIEW_ID);
    const ready = await waitFor(() => ctx.commands.isEnabled("hunk.view.applyFilePresentationToAllMatching"));
    if (!ready || !ctx.commands.execute("hunk.view.applyFilePresentationToAllMatching")) {
      ctx.notify("Could not fold every viewed file", "warning");
    }
  });

  hunk.registerKeyboardMode({
    id: SINGLE_MODE_ID,
    title: "Single file",
    // The target is seeded by the `singleFile` command before entry (selection can be debounced
    // by the time onEnter runs), so entry only needs to reload with that target in effect.
    onEnter(ctx) {
      ctx.commands.execute("hunk.app.refresh");
    },
    onExit(ctx) {
      const { targetPath } = getSingleFileState();
      exitSingleFile(targetPath);
      ctx.commands.execute("hunk.app.refresh");
    },
    onKey(key: ExtensionKeyEvent, ctx) {
      const { targetPath, pendingPath } = getSingleFileState();
      const files = getReviewMirror().allFiles;
      if (matchesKey(".", key) || matchesKey(",", key)) {
        const direction = matchesKey(".", key) ? 1 : -1;
        const next = neighborPath(files, targetPath, direction);
        if (next) retarget(next, (id) => ctx.commands.execute(id), ctx.notify);
        else ctx.notify(direction === 1 ? "No file after this one" : "No file before this one", "info");
        return "handled";
      }
      if (matchesKey("enter", key)) {
        if (!pendingPath) return "pass";
        retarget(pendingPath, (id) => ctx.commands.execute(id), ctx.notify);
        return "handled";
      }
      return "pass";
    },
  });

  hunk.registerCommand({ id: "singleFile", title: "Single-file mode (o toggles, Esc exits)", key: "o" }, (ctx) => {
    if (ctx.keyboardModes.isActive(SINGLE_MODE_ID)) {
      ctx.keyboardModes.exitMode();
      return;
    }
    if (!ctx.commands.isEnabled("hunk.app.refresh")) {
      ctx.notify("Single-file mode needs a reloadable input", "info");
      return;
    }
    enterSingleFile(ctx.selection.file?.path ?? getReviewMirror().files[0]?.path ?? null);
    ctx.keyboardModes.enterMode(SINGLE_MODE_ID);
  });
}

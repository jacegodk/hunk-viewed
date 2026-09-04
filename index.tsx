/**
 * hunk-viewed: GitLab-style "viewed" marks for hunk.
 *
 * `v` marks the selected file and jumps to the next unviewed one, or clears a viewed file.
 * `J` / `K` jump between unviewed files. `o` toggles single-file mode, which shows only one
 * file at a time; inside it `,`/`.` retarget the previous/next file and `Enter` loads a file
 * clicked in the pane, with `v`/`J`/`K` retargeting instead of jumping the full review. Marks
 * persist per repo in the XDG state dir and reset when a file's patch changes. The pane
 * replaces hunk's files pane and shows marks and progress.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionContext, ExtensionDiffFile, ExtensionKeyEvent, HunkExtensionAPI } from "hunkdiff/extension";
import { matchesKey } from "hunkdiff/extension";
import { FOLDED_VIEW_ID, buildFoldedLayout } from "./src/foldedView";
import { findUnviewedNeighbor } from "./src/navigation";
import {
  getReviewMirror,
  setMirrorAllFiles,
  setMirrorFiles,
  setMirrorFilter,
  setMirrorSelectedFileId,
  visibleFiles,
} from "./src/reviewMirror";
import { applySingleFileTransform, enterSingleFile, exitSingleFile, getSingleFileState, neighborPath, setSingleFileTarget } from "./src/singleFile";
import { FilesPane } from "./src/sidebar/FilesPane";
import { readRepoFiles, resolveViewedFilePath, writeRepoFiles } from "./src/viewedFile";
import { clearRepo, getViewedState, isViewed, loadRepo, reconcileViewed, setPersist, toggleViewed } from "./src/viewedStore";

const FILES_PANE_ID = "files";
const SINGLE_MODE_ID = "single";

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

  const isViewedFile = (file: ExtensionDiffFile) => isViewed(getViewedState(), file);

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

  hunk.on("startup", ({ cwd }, ctx) => ensureRepoLoaded(cwd, ctx.notify));
  hunk.on("changeset_loaded", ({ changeset }, ctx) => {
    ensureRepoLoaded(ctx.cwd, ctx.notify);
    setMirrorFiles(changeset.files);
    reconcileViewed(changeset.files);
  });
  hunk.on("session_reload", ({ changeset }) => {
    setMirrorFiles(changeset.files);
    reconcileViewed(changeset.files);
  });
  hunk.on("selection_changed", ({ fileId }) => setMirrorSelectedFileId(fileId));
  hunk.on("filter_changed", ({ filter }) => setMirrorFilter(filter));

  hunk.transformChangeset((changeset) => {
    setMirrorAllFiles(changeset.files);
    return applySingleFileTransform(changeset, getSingleFileState());
  });

  /** Point single-file mode at `path` and reload so the transform applies. */
  function retarget(path: string, execute: (commandId: string) => boolean) {
    setSingleFileTarget(path);
    execute("hunk.app.refresh");
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
    layout: ({ file }) => buildFoldedLayout(file),
  });

  hunk.registerCommand({ id: "toggleViewed", title: "Toggle viewed on the selected file", key: "v" }, (ctx) => {
    const file = ctx.selection.file;
    if (!file) {
      ctx.notify("No file selected", "info");
      return;
    }
    const result = toggleViewed(file, new Date());
    if (result === "cleared") {
      ctx.fileViews.select(null);
      return;
    }
    ctx.fileViews.select(FOLDED_VIEW_ID);
    if (getSingleFileState().active) {
      const next = findUnviewedNeighbor(getReviewMirror().allFiles, file.id, 1, isViewedFile);
      if (next) retarget(next.path, (id) => ctx.commands.execute(id));
      else ctx.notify("No unviewed file after this one", "info");
      return;
    }
    const next = findUnviewedNeighbor(navigationFiles(file.id), file.id, 1, isViewedFile);
    if (next) ctx.navigation.selectFile(next.id);
    else ctx.notify("No unviewed file after this one", "info");
  });

  hunk.registerCommand({ id: "nextUnviewed", title: "Next unviewed file", key: "J" }, (ctx) => {
    if (getSingleFileState().active) {
      const { targetPath } = getSingleFileState();
      const files = getReviewMirror().allFiles;
      const currentId = files.find((file) => file.path === targetPath)?.id ?? null;
      const next = findUnviewedNeighbor(files, currentId, 1, isViewedFile);
      if (next) retarget(next.path, (id) => ctx.commands.execute(id));
      else ctx.notify("No unviewed file after this one", "info");
      return;
    }
    const selectedFileId = ctx.selection.file?.id ?? null;
    const next = findUnviewedNeighbor(navigationFiles(selectedFileId), selectedFileId, 1, isViewedFile);
    if (next) ctx.navigation.selectFile(next.id);
    else ctx.notify("No unviewed file after this one", "info");
  });

  hunk.registerCommand({ id: "previousUnviewed", title: "Previous unviewed file", key: "K" }, (ctx) => {
    if (getSingleFileState().active) {
      const { targetPath } = getSingleFileState();
      const files = getReviewMirror().allFiles;
      const currentId = files.find((file) => file.path === targetPath)?.id ?? null;
      const previous = findUnviewedNeighbor(files, currentId, -1, isViewedFile);
      if (previous) retarget(previous.path, (id) => ctx.commands.execute(id));
      else ctx.notify("No unviewed file before this one", "info");
      return;
    }
    const selectedFileId = ctx.selection.file?.id ?? null;
    const previous = findUnviewedNeighbor(navigationFiles(selectedFileId), selectedFileId, -1, isViewedFile);
    if (previous) ctx.navigation.selectFile(previous.id);
    else ctx.notify("No unviewed file before this one", "info");
  });

  hunk.registerCommand({ id: "clearRepo", title: "Clear viewed marks for this repo" }, async (ctx) => {
    const count = Object.keys(getViewedState().files).length;
    const confirmed = await ctx.dialogs.confirm({
      title: "Clear viewed marks",
      body: `Remove ${count} viewed mark${count === 1 ? "" : "s"} for this repo?`,
      confirmLabel: "Clear",
    });
    if (confirmed) clearRepo();
  });

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

}

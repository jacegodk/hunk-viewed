/**
 * hunk-viewed: GitLab-style "viewed" marks for hunk.
 *
 * `v` marks the selected file and jumps to the next unviewed one, or clears a viewed file.
 * `J` / `K` jump between unviewed files. `F` enters a files mode where `j`/`k` and the arrows
 * move over every file. Marks persist per repo in the XDG state dir and reset when a file's
 * patch changes. The pane replaces hunk's files pane and shows marks and progress.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionContext, ExtensionDiffFile, ExtensionKeyEvent, HunkExtensionAPI } from "hunkdiff/extension";
import { matchesKey } from "hunkdiff/extension";
import { findUnviewedNeighbor } from "./src/navigation";
import {
  getReviewMirror,
  setMirrorFiles,
  setMirrorFilesModeActive,
  setMirrorFilter,
  setMirrorSelectedFileId,
  visibleFiles,
} from "./src/reviewMirror";
import { FilesPane } from "./src/sidebar/FilesPane";
import { readRepoFiles, resolveViewedFilePath, writeRepoFiles } from "./src/viewedFile";
import { clearRepo, getViewedState, isViewed, loadRepo, reconcileViewed, setPersist, toggleViewed } from "./src/viewedStore";

const FILES_MODE_ID = "files";

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

  hunk.registerPane({
    id: FILES_MODE_ID,
    title: "Files (viewed)",
    placement: "left",
    replaces: "hunk:files",
    width: { preferred: 34, min: 22 },
    component: FilesPane,
  });

  hunk.registerCommand({ id: "toggleViewed", title: "Toggle viewed on the selected file", key: "v" }, (ctx) => {
    const file = ctx.selection.file;
    if (!file) {
      ctx.notify("No file selected", "info");
      return;
    }
    const result = toggleViewed(file, new Date());
    if (result === "cleared") return;
    const next = findUnviewedNeighbor(navigationFiles(file.id), file.id, 1, isViewedFile);
    if (next) ctx.navigation.selectFile(next.id);
    else ctx.notify("No unviewed file after this one", "info");
  });

  hunk.registerCommand({ id: "nextUnviewed", title: "Next unviewed file", key: "J" }, (ctx) => {
    const selectedFileId = ctx.selection.file?.id ?? null;
    const next = findUnviewedNeighbor(navigationFiles(selectedFileId), selectedFileId, 1, isViewedFile);
    if (next) ctx.navigation.selectFile(next.id);
    else ctx.notify("No unviewed file after this one", "info");
  });

  hunk.registerCommand({ id: "previousUnviewed", title: "Previous unviewed file", key: "K" }, (ctx) => {
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

  hunk.registerKeyboardMode({
    id: FILES_MODE_ID,
    title: "Files",
    onEnter: () => setMirrorFilesModeActive(true),
    onExit: () => setMirrorFilesModeActive(false),
    onKey(key: ExtensionKeyEvent, ctx) {
      // Some terminals report a shifted letter without the shift flag (hunk's
      // `src/extension-api/keys.test.ts:122-123`), so check the extension's own commands first
      // or a misreported J/K/v could be swallowed here instead of reaching them.
      if (matchesKey("J", key) || matchesKey("K", key) || matchesKey("v", key)) return "pass";
      if (matchesKey("j", key) || matchesKey("down", key)) {
        ctx.commands.execute("hunk.review.nextFile");
        return "handled";
      }
      if (matchesKey("k", key) || matchesKey("up", key)) {
        ctx.commands.execute("hunk.review.previousFile");
        return "handled";
      }
      if (matchesKey("enter", key)) return "exit";
      return "pass";
    },
  });

  hunk.registerCommand({ id: "filesMode", title: "Files mode (j/k move between files)", key: "F" }, (ctx) => {
    if (ctx.keyboardModes.isActive(FILES_MODE_ID)) ctx.keyboardModes.exitMode();
    else ctx.keyboardModes.enterMode(FILES_MODE_ID);
  });
}

import type { HunkExtensionAPI } from "hunkdiff/extension";

/** Register the hunk-viewed pane, commands, keyboard mode, and event handlers. */
export default function (hunk: HunkExtensionAPI) {
  hunk.log("hunk-viewed loaded");
}

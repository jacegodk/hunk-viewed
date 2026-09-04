/**
 * Wiring test for the extension factory in index.tsx: registration, lifecycle events, and
 * command/keyboard-mode behavior, driven through a fake HunkExtensionAPI against the real
 * viewedStore and reviewMirror singletons.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionChangeset,
  ExtensionCommand,
  ExtensionCommandContext,
  ExtensionCommandHandler,
  ExtensionDiffFile,
  ExtensionEventContext,
  ExtensionEventHandler,
  ExtensionEventName,
  ExtensionKeyboardMode,
  ExtensionKeyboardModeContext,
  ExtensionKeyEvent,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { HUNK_EXTENSION_API_VERSION } from "hunkdiff/extension";
import registerExtension from "./index";
import { getReviewMirror, resetReviewMirrorForTests, setMirrorFilter } from "./src/reviewMirror";
import { enterSingleFile, getSingleFileState, resetSingleFileForTests, setSingleFilePending } from "./src/singleFile";
import { getViewedState, isViewed, resetViewedStoreForTests, toggleViewed as storeToggleViewed } from "./src/viewedStore";

/** What the fake `hunk` object recorded during one factory call. */
interface FakeHunk {
  hunk: HunkExtensionAPI;
  panes: unknown[];
  commands: Map<string, { command: ExtensionCommand; handler: ExtensionCommandHandler }>;
  keyboardModes: Map<string, ExtensionKeyboardMode>;
  events: Map<ExtensionEventName, ExtensionEventHandler>;
  logs: string[];
  fileViews: unknown[];
  transforms: Array<(changeset: ExtensionChangeset) => ExtensionChangeset>;
}

/** Build a minimal HunkExtensionAPI stub that records every registration call. */
function createFakeHunk(): FakeHunk {
  const panes: unknown[] = [];
  const commands: FakeHunk["commands"] = new Map();
  const keyboardModes: FakeHunk["keyboardModes"] = new Map();
  const events: FakeHunk["events"] = new Map();
  const logs: string[] = [];
  const fileViews: unknown[] = [];
  const transforms: FakeHunk["transforms"] = [];
  const hunk = {
    apiVersion: HUNK_EXTENSION_API_VERSION,
    log: (message: string) => logs.push(message),
    registerPane: (pane: unknown) => panes.push(pane),
    registerCommand: (command: ExtensionCommand, handler: ExtensionCommandHandler) => commands.set(command.id, { command, handler }),
    registerKeyboardMode: (mode: ExtensionKeyboardMode) => keyboardModes.set(mode.id, mode),
    on: (event: ExtensionEventName, handler: ExtensionEventHandler) => events.set(event, handler),
    registerFileView: (view: unknown) => fileViews.push(view),
    transformChangeset: (fn: (changeset: ExtensionChangeset) => ExtensionChangeset) => transforms.push(fn),
  } as unknown as HunkExtensionAPI;
  return { hunk, panes, commands, keyboardModes, events, logs, fileViews, transforms };
}

function makeFile(id: string, path: string, extra: Partial<ExtensionDiffFile> = {}): ExtensionDiffFile {
  return { id, path, patch: `patch-${id}`, stats: { additions: 1, deletions: 0 }, metadata: {}, agent: null, ...extra };
}

function makeChangeset(files: ExtensionDiffFile[]): ExtensionChangeset {
  return { id: "cs", sourceLabel: "test", title: "test changeset", files };
}

function eventContext(cwd: string, notify: (message: string, type?: string) => void = () => {}): ExtensionEventContext {
  return {
    cwd,
    notify,
    panes: {},
    sidebars: {},
    navigation: {},
    dialogs: {},
    events: { emit: () => {} },
  } as unknown as ExtensionEventContext;
}

/** Calls a command handler made against `ctx.fileViews.select`, `ctx.commands.execute`, and `ctx.keyboardModes`. */
interface CommandCalls {
  fileViewSelects: Array<string | null>;
  executed: string[];
  modeActive: boolean;
}

/** Build an empty `CommandCalls` recorder for a `commandContext`. */
function createCalls(): CommandCalls {
  return { fileViewSelects: [], executed: [], modeActive: false };
}

function commandContext(
  selectedFile: ExtensionDiffFile | null,
  selectedIds: string[],
  notified: Array<[string, string | undefined]> = [],
  calls: CommandCalls = createCalls(),
): ExtensionCommandContext {
  return {
    selection: { file: selectedFile, hunkIndex: null, currentLine: null },
    navigation: { selectFile: (id: string) => selectedIds.push(id) },
    notify: (message: string, type?: string) => notified.push([message, type]),
    fileViews: { select: (id: string | null) => calls.fileViewSelects.push(id) },
    commands: {
      execute: (id: string) => {
        calls.executed.push(id);
        return true;
      },
    },
    keyboardModes: {
      isActive: () => calls.modeActive,
      enterMode: () => {
        calls.modeActive = true;
        return true;
      },
      exitMode: () => {
        calls.modeActive = false;
        return true;
      },
    },
  } as unknown as ExtensionCommandContext;
}

/** Build a keyboard-mode context whose `commands.execute` records into `calls`. */
function modeContext(calls: CommandCalls): ExtensionKeyboardModeContext {
  return {
    commands: {
      execute: (id: string) => {
        calls.executed.push(id);
        return true;
      },
    },
  } as unknown as ExtensionKeyboardModeContext;
}

let repoDir: string;
let stateDir: string;
let originalXdgStateHome: string | undefined;

beforeEach(() => {
  resetViewedStoreForTests();
  resetReviewMirrorForTests();
  resetSingleFileForTests();
  repoDir = mkdtempSync(join(tmpdir(), "hunk-viewed-repo-"));
  stateDir = mkdtempSync(join(tmpdir(), "hunk-viewed-state-"));
  originalXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateDir;
});

afterEach(() => {
  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

/** Fire `startup` then `changeset_loaded` with the given files, as hunk does on load. */
function loadChangeset(fake: FakeHunk, files: ExtensionDiffFile[]): void {
  fake.events.get("startup")!({ cwd: repoDir }, eventContext(repoDir));
  fake.events.get("changeset_loaded")!({ changeset: makeChangeset(files) }, eventContext(repoDir));
}

describe("registration", () => {
  test("registers the pane, commands, and keyboard mode", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);

    expect(fake.panes).toHaveLength(1);
    expect((fake.panes[0] as { replaces?: string }).replaces).toBe("hunk:files");

    expect(fake.commands.get("toggleViewed")?.command.key).toBe("v");
    expect(fake.commands.get("nextUnviewed")?.command.key).toBe("J");
    expect(fake.commands.get("previousUnviewed")?.command.key).toBe("K");
    expect(fake.commands.get("clearRepo")?.command.key).toBeUndefined();
    expect(fake.commands.get("foldViewed")?.command.key).toBeUndefined();
    expect(fake.commands.get("singleFile")?.command.key).toBe("o");

    expect(fake.keyboardModes.size).toBe(1);
    expect(fake.keyboardModes.get("single")).toBeDefined();
  });
});

describe("lifecycle events", () => {
  test("startup then changeset_loaded loads the repo and mirrors the changeset", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);

    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);

    expect(getReviewMirror().files).toEqual(files);
    expect(getViewedState().repoKey).toBe(realpathSync(repoDir));
  });
});

describe("toggleViewed", () => {
  test("marks the selected file and selects the next unviewed one, then clears on a second call", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);

    const selected: string[] = [];
    const ctx = commandContext(files[0]!, selected);
    fake.commands.get("toggleViewed")!.handler(ctx);

    expect(isViewed(getViewedState(), files[0]!)).toBe(true);
    expect(selected).toEqual(["2"]);

    fake.commands.get("toggleViewed")!.handler(ctx);

    expect(isViewed(getViewedState(), files[0]!)).toBe(false);
    expect(selected).toEqual(["2"]);
  });
});

describe("nextUnviewed / previousUnviewed", () => {
  test("nextUnviewed notifies when nothing is left after the selection", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[1]!, new Date());
    storeToggleViewed(files[2]!, new Date());

    const selected: string[] = [];
    const notified: Array<[string, string | undefined]> = [];
    fake.commands.get("nextUnviewed")!.handler(commandContext(files[0]!, selected, notified));

    expect(notified).toEqual([["No unviewed file after this one", "info"]]);
    expect(selected).toEqual([]);
  });

  test("previousUnviewed selects the last unviewed file when nothing is selected", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[1]!, new Date());
    storeToggleViewed(files[2]!, new Date());

    const selected: string[] = [];
    fake.commands.get("previousUnviewed")!.handler(commandContext(null, selected));

    expect(selected).toEqual(["1"]);
  });

  test("falls back to the full file list when the selection is outside the mirrored filter", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    // Only file 3 matches; the mirror's derived visible set excludes the selected file 1.
    setMirrorFilter("c.ts");

    const selected: string[] = [];
    fake.commands.get("nextUnviewed")!.handler(commandContext(files[0]!, selected));

    expect(selected).toEqual(["2"]);
  });
});

describe("clearRepo", () => {
  test("clears marks only when the user confirms", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[0]!, new Date());

    let confirmed = false;
    const ctx = { dialogs: { confirm: async () => confirmed } } as unknown as ExtensionCommandContext;

    await fake.commands.get("clearRepo")!.handler(ctx);
    expect(Object.keys(getViewedState().files)).toEqual(["a.ts"]);

    confirmed = true;
    await fake.commands.get("clearRepo")!.handler(ctx);
    expect(Object.keys(getViewedState().files)).toEqual([]);
  });
});

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

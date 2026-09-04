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

/** Build an event context; `selectedIds`, if given, records every `navigation.selectFile` call. */
function eventContext(cwd: string, notify: (message: string, type?: string) => void = () => {}, selectedIds: string[] = []): ExtensionEventContext {
  return {
    cwd,
    notify,
    panes: {},
    sidebars: {},
    navigation: { selectFile: (id: string) => selectedIds.push(id) },
    dialogs: {},
    events: { emit: () => {} },
  } as unknown as ExtensionEventContext;
}

/** Calls a command handler made against `ctx.fileViews`, `ctx.commands`, and `ctx.keyboardModes`. */
interface CommandCalls {
  fileViewSelects: Array<string | null>;
  fileViewRefreshes: string[];
  fileViewToggles: string[];
  executed: string[];
  modeActive: boolean;
  /**
   * Queue of `commands.isEnabled` results: each call consumes the front entry until one is left,
   * which then repeats forever. Defaults to always-enabled.
   */
  isEnabledResults: boolean[];
  /** Value `commands.execute` returns; defaults to true (the command ran). */
  executeResult: boolean;
}

/** Build an empty `CommandCalls` recorder for a `commandContext`. */
function createCalls(): CommandCalls {
  return { fileViewSelects: [], fileViewRefreshes: [], fileViewToggles: [], executed: [], modeActive: false, isEnabledResults: [true], executeResult: true };
}

/** Consume one queued `isEnabled` result, repeating the last entry once the queue is down to one. */
function nextIsEnabled(calls: CommandCalls): boolean {
  if (calls.isEnabledResults.length > 1) return calls.isEnabledResults.shift()!;
  return (calls.isEnabledResults[0] ??= true);
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
    fileViews: {
      select: (id: string | null) => calls.fileViewSelects.push(id),
      refresh: (id: string) => calls.fileViewRefreshes.push(id),
      toggle: (id: string) => calls.fileViewToggles.push(id),
    },
    commands: {
      isEnabled: () => nextIsEnabled(calls),
      execute: (id: string) => {
        calls.executed.push(id);
        return calls.executeResult;
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

/** Build a keyboard-mode context whose `commands` and `notify` record into `calls`/`notified`. */
function modeContext(calls: CommandCalls, notified: Array<[string, string | undefined]> = []): ExtensionKeyboardModeContext {
  return {
    commands: {
      isEnabled: () => nextIsEnabled(calls),
      execute: (id: string) => {
        calls.executed.push(id);
        return calls.executeResult;
      },
    },
    notify: (message: string, type?: string) => notified.push([message, type]),
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
  test("marks the selected file and selects the folded view, staying on it; clears on a second call", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);

    const selected: string[] = [];
    const calls = createCalls();
    const ctx = commandContext(files[0]!, selected, [], calls);
    fake.commands.get("toggleViewed")!.handler(ctx);

    expect(isViewed(getViewedState(), files[0]!)).toBe(true);
    expect(calls.fileViewSelects).toEqual(["viewed"]);
    expect(selected).toEqual([]);
    expect(calls.executed).toEqual([]);

    fake.commands.get("toggleViewed")!.handler(ctx);

    expect(isViewed(getViewedState(), files[0]!)).toBe(false);
    expect(calls.fileViewSelects).toEqual(["viewed", null]);
    expect(selected).toEqual([]);
    expect(calls.executed).toEqual([]);
  });
});

describe("nextUnviewed / previousUnviewed", () => {
  test("nextUnviewed moves to the very next file without skipping viewed ones", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[1]!, new Date());
    storeToggleViewed(files[2]!, new Date());

    const selected: string[] = [];
    const notified: Array<[string, string | undefined]> = [];
    fake.commands.get("nextUnviewed")!.handler(commandContext(files[0]!, selected, notified));

    expect(selected).toEqual(["2"]);
    expect(notified).toEqual([]);
  });

  test("previousUnviewed selects the last file when nothing is selected", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[1]!, new Date());
    storeToggleViewed(files[2]!, new Date());

    const selected: string[] = [];
    fake.commands.get("previousUnviewed")!.handler(commandContext(null, selected));

    expect(selected).toEqual(["3"]);
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
  test("clears marks only when the user confirms, and refreshes the folded view", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[0]!, new Date());

    let confirmed = false;
    const calls = createCalls();
    const ctx = { ...commandContext(null, [], [], calls), dialogs: { confirm: async () => confirmed } } as unknown as ExtensionCommandContext;

    await fake.commands.get("clearRepo")!.handler(ctx);
    expect(Object.keys(getViewedState().files)).toEqual(["a.ts"]);
    expect(calls.fileViewRefreshes).toEqual([]);

    confirmed = true;
    await fake.commands.get("clearRepo")!.handler(ctx);
    expect(Object.keys(getViewedState().files)).toEqual([]);
    expect(calls.fileViewRefreshes).toEqual(["viewed"]);
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

  test("layout declines a file that is not viewed", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    const view = fake.fileViews[0] as { layout: (input: { file: ExtensionDiffFile }) => unknown };
    expect(view.layout({ file: files[0]! })).toBeNull();
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

  test("foldViewed notifies when the selected file is not viewed", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    const calls = createCalls();
    const notified: Array<[string, string | undefined]> = [];
    await fake.commands.get("foldViewed")!.handler(commandContext(files[0]!, [], notified, calls));
    expect(notified).toEqual([["Select a viewed file, then fold", "info"]]);
    expect(calls.executed).toEqual([]);
  });

  test("foldViewed notifies when single-file mode is active", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[0]!, new Date());
    enterSingleFile("a.ts");
    const calls = createCalls();
    const notified: Array<[string, string | undefined]> = [];
    await fake.commands.get("foldViewed")!.handler(commandContext(files[0]!, [], notified, calls));
    expect(notified).toEqual([["Leave single-file mode to fold all files", "info"]]);
    expect(calls.executed).toEqual([]);
  });

  test("foldViewed waits for the bulk command to become enabled, then runs it once", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[0]!, new Date());
    const calls = createCalls();
    calls.isEnabledResults = [false, false, true];
    const notified: Array<[string, string | undefined]> = [];
    await fake.commands.get("foldViewed")!.handler(commandContext(files[0]!, [], notified, calls));
    expect(calls.fileViewSelects).toEqual(["viewed"]);
    expect(calls.executed).toEqual(["hunk.view.applyFilePresentationToAllMatching"]);
    expect(notified).toEqual([]);
  });

  test("foldViewed warns when the bulk command never becomes enabled", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[0]!, new Date());
    const calls = createCalls();
    calls.isEnabledResults = [false];
    const notified: Array<[string, string | undefined]> = [];
    await fake.commands.get("foldViewed")!.handler(commandContext(files[0]!, [], notified, calls));
    expect(calls.executed).toEqual([]);
    expect(notified).toEqual([["Could not fold every viewed file", "warning"]]);
  });
});

describe("single-file mode", () => {
  test("o seeds the target and enters the mode; onEnter refreshes; exit restores", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    fake.events.get("selection_changed")!({ fileId: "2", hunkIndex: null }, eventContext(repoDir));
    const calls = createCalls();
    const single = fake.commands.get("singleFile")!.handler;
    single(commandContext(files[1]!, [], [], calls));
    // The command itself seeds the target from the (possibly debounced) selection at invocation
    // time, so it is already set before the mode's onEnter ever runs.
    expect(calls.modeActive).toBe(true);
    expect(getSingleFileState()).toEqual({ active: true, targetPath: "b.ts", pendingPath: null, returnPath: null });
    const mode = fake.keyboardModes.get("single")!;
    mode.onEnter!(modeContext(calls));
    expect(calls.executed).toEqual(["hunk.app.refresh"]);
    single(commandContext(files[1]!, [], [], calls));
    expect(calls.modeActive).toBe(false);
    mode.onExit!(modeContext(calls));
    expect(getSingleFileState()).toEqual({ active: false, targetPath: null, pendingPath: null, returnPath: "b.ts" });
    expect(calls.executed).toEqual(["hunk.app.refresh", "hunk.app.refresh"]);
  });

  test("a plain changeset_loaded (first load, no returnPath) selects nothing", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    const selectedIds: string[] = [];
    fake.events.get("startup")!({ cwd: repoDir }, eventContext(repoDir));
    fake.events.get("changeset_loaded")!({ changeset: makeChangeset(files) }, eventContext(repoDir, () => {}, selectedIds));

    expect(selectedIds).toEqual([]);
    expect(getSingleFileState().returnPath).toBeNull();
  });

  test("leaving the mode reselects the file it was showing, once the exit reload's changeset_loaded and session_reload both land", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    enterSingleFile("b.ts");
    const mode = fake.keyboardModes.get("single")!;
    mode.onExit!(modeContext(createCalls()));
    expect(getSingleFileState().returnPath).toBe("b.ts");

    // hunk fires changeset_loaded then session_reload back-to-back, synchronously, on every
    // non-initial reload; returnPath must survive the first and be consumed by the second.
    const selectedIds: string[] = [];
    const ctx = eventContext(repoDir, () => {}, selectedIds);
    fake.events.get("changeset_loaded")!({ changeset: makeChangeset(files) }, ctx);
    fake.events.get("session_reload")!({ changeset: makeChangeset(files), reason: "manual" }, ctx);

    expect(selectedIds).toEqual(["2"]);
    expect(getSingleFileState().returnPath).toBeNull();
  });

  test("o notifies when the current input cannot be reloaded, and does not enter the mode", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    const calls = createCalls();
    calls.isEnabledResults = [false];
    const notified: Array<[string, string | undefined]> = [];
    fake.commands.get("singleFile")!.handler(commandContext(files[0]!, [], notified, calls));
    expect(notified).toEqual([["Single-file mode needs a reloadable input", "info"]]);
    expect(calls.modeActive).toBe(false);
    expect(getSingleFileState().active).toBe(false);
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

  test("the transform light-projects allFiles from the last full-render payload", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    // changeset_loaded carries the projected file (changeType/hunks filled in).
    const projected = [makeFile("1", "a.ts", { changeType: "new", hunks: [{ index: 0, header: "@@" }] as never })];
    loadChangeset(fake, projected);
    // The transform's own input is hunk's internal changeset, which never carries those fields.
    const internal = [makeFile("1", "a.ts", { metadata: { internal: true } })];
    fake.transforms[0]!(makeChangeset(internal));
    expect(getReviewMirror().allFiles[0]?.changeType).toBe("new");
    expect(getReviewMirror().allFiles[0]?.metadata).toEqual({});
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

  test("enter passes through with nothing pending; , and . notify at the ends", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts")];
    fake.transforms[0]!(makeChangeset(files));
    enterSingleFile("a.ts");
    const calls = createCalls();
    const mode = fake.keyboardModes.get("single")!;
    let notified: Array<[string, string | undefined]> = [];
    expect(mode.onKey({ name: "enter" } as ExtensionKeyEvent, modeContext(calls, notified))).toBe("pass");
    expect(mode.onKey({ name: "," } as ExtensionKeyEvent, modeContext(calls, notified))).toBe("handled");
    expect(notified).toEqual([["No file before this one", "info"]]);
    enterSingleFile("b.ts");
    notified = [];
    expect(mode.onKey({ name: "." } as ExtensionKeyEvent, modeContext(calls, notified))).toBe("handled");
    expect(notified).toEqual([["No file after this one", "info"]]);
  });

  test("retarget warns when the reload fails", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts")];
    fake.transforms[0]!(makeChangeset(files));
    enterSingleFile("a.ts");
    const calls = createCalls();
    calls.executeResult = false;
    const notified: Array<[string, string | undefined]> = [];
    const mode = fake.keyboardModes.get("single")!;
    expect(mode.onKey({ name: "." } as ExtensionKeyEvent, modeContext(calls, notified))).toBe("handled");
    expect(getSingleFileState().targetPath).toBe("b.ts");
    expect(notified).toEqual([["This input cannot be reloaded, so single-file mode is unavailable", "warning"]]);
  });

  test("J retargets to the very next file in single-file mode without skipping viewed ones", () => {
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
    expect(getSingleFileState().targetPath).toBe("b.ts");
    expect(calls.executed).toEqual(["hunk.app.refresh"]);
  });

  test("K retargets to the very previous file in single-file mode without skipping viewed ones", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    fake.transforms[0]!(makeChangeset(files));
    loadChangeset(fake, [files[2]!]);
    enterSingleFile("c.ts");
    storeToggleViewed(files[1]!, new Date());
    const calls = createCalls();
    const selected: string[] = [];
    fake.commands.get("previousUnviewed")!.handler(commandContext(files[2]!, selected, [], calls));
    expect(selected).toEqual([]);
    expect(getSingleFileState().targetPath).toBe("b.ts");
    expect(calls.executed).toEqual(["hunk.app.refresh"]);
  });

  test("toggleViewed marks and folds the file in single-file mode, staying on it", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    fake.transforms[0]!(makeChangeset(files));
    loadChangeset(fake, [files[0]!]);
    enterSingleFile("a.ts");
    const calls = createCalls();
    fake.commands.get("toggleViewed")!.handler(commandContext(files[0]!, [], [], calls));
    expect(isViewed(getViewedState(), files[0]!)).toBe(true);
    expect(calls.fileViewSelects).toEqual(["viewed"]);
    expect(getSingleFileState().targetPath).toBe("a.ts");
    expect(calls.executed).toEqual([]);
  });
});

describe("full file view", () => {
  test("registers the full view for non-binary files and F toggles it", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const file = makeFile("1", "a.ts", { patch: "@@ -1 +1 @@\n-a\n+b\n", hunks: [{ index: 0, header: "@@" }] as never });
    loadChangeset(fake, [file]);
    const view = fake.fileViews.find((v) => (v as { id: string }).id === "full") as {
      matches: (f: ExtensionDiffFile) => boolean;
      layout: (input: unknown) => Promise<{ rows: unknown[] } | null>;
    };
    expect(view.matches(file)).toBe(true);
    expect(view.matches({ ...file, isBinary: true })).toBe(false);
    expect(view.matches({ ...file, isTooLarge: true })).toBe(false);
    expect(view.matches({ ...file, changeType: "deleted" })).toBe(false);
    expect(view.matches({ ...file, hunks: [] })).toBe(false);
    expect(view.matches(makeFile("2", "b.ts"))).toBe(false);
    const layout = await view.layout({ file, width: 80, signal: new AbortController().signal, changes: [], readDocument: async () => "b\n" });
    expect(layout?.rows.length).toBe(2);
    const missing = await view.layout({ file, width: 80, signal: new AbortController().signal, changes: [], readDocument: async () => null });
    expect(missing).toBeNull();
    const calls = createCalls();
    fake.commands.get("fullFile")!.handler(commandContext(file, [], [], calls));
    expect(calls.fileViewToggles).toEqual(["full"]);
  });

  test("F notifies when no file is selected", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const notified: Array<[string, string | undefined]> = [];
    const calls = createCalls();
    fake.commands.get("fullFile")!.handler(commandContext(null, [], notified, calls));
    expect(notified).toEqual([["No file selected", "info"]]);
    expect(calls.fileViewToggles).toEqual([]);
  });

  test("layout declines a file whose parsed hunk count does not match input.file.hunks", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const file = makeFile("1", "a.ts", {
      patch: "@@ -1 +1 @@\n-a\n+b\n",
      hunks: [
        { index: 0, header: "@@" },
        { index: 1, header: "@@" },
      ] as never,
    });
    loadChangeset(fake, [file]);
    const view = fake.fileViews.find((v) => (v as { id: string }).id === "full") as {
      layout: (input: unknown) => Promise<{ rows: unknown[] } | null>;
    };
    const layout = await view.layout({ file, width: 80, signal: new AbortController().signal, changes: [], readDocument: async () => "b\n" });
    expect(layout).toBeNull();
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

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
  ExtensionLineHighlighter,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { HUNK_EXTENSION_API_VERSION } from "hunkdiff/extension";
import registerExtension from "./index";
import { getReviewMirror, resetReviewMirrorForTests, setMirrorFilter, visibleFiles } from "./src/reviewMirror";
import { getSearchState, rebuildHits, resetSearchForTests, setFullViewFile, setQuery, stepHit } from "./src/search";
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
  lineHighlighters: Map<string, ExtensionLineHighlighter>;
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
  const lineHighlighters: FakeHunk["lineHighlighters"] = new Map();
  const hunk = {
    apiVersion: HUNK_EXTENSION_API_VERSION,
    log: (message: string) => logs.push(message),
    registerPane: (pane: unknown) => panes.push(pane),
    registerCommand: (command: ExtensionCommand, handler: ExtensionCommandHandler) => commands.set(command.id, { command, handler }),
    registerKeyboardMode: (mode: ExtensionKeyboardMode) => keyboardModes.set(mode.id, mode),
    on: (event: ExtensionEventName, handler: ExtensionEventHandler) => events.set(event, handler),
    registerFileView: (view: unknown) => fileViews.push(view),
    registerLineHighlighter: (highlighter: ExtensionLineHighlighter) => lineHighlighters.set(highlighter.id, highlighter),
    transformChangeset: (fn: (changeset: ExtensionChangeset) => ExtensionChangeset) => transforms.push(fn),
  } as unknown as HunkExtensionAPI;
  return { hunk, panes, commands, keyboardModes, events, logs, fileViews, transforms, lineHighlighters };
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

/** Calls a command handler made against `ctx.fileViews`, `ctx.commands`, `ctx.keyboardModes`, `ctx.panes`, `ctx.highlights`, and `ctx.navigation`. */
interface CommandCalls {
  fileViewSelects: Array<string | null>;
  /** `"<viewId>"`, or `"<viewId>:<fileId>"` for a scoped `refresh(id, { fileId })` call. */
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
  paneOpens: string[];
  paneCloses: string[];
  /** `"<highlighterId>"`, or `"<highlighterId>:<fileId>"` for a scoped `refresh(id, { fileId })` call. */
  highlightRefreshes: string[];
  enteredModes: string[];
  revealed: Array<{ fileId: string; side: string; line: number }>;
  /** What `fileViews.isActive(FULL_VIEW_ID)` reports; `toggle` flips it unless `fileViewToggleRefused`. */
  fileViewActive: boolean;
  /** Simulates hunk declining the toggle (the view's `matches`/`layout` refuses it): `toggle` becomes a no-op. */
  fileViewToggleRefused: boolean;
  /** Value `keyboardModes.enterMode` returns; `false` simulates the mode failing to start. */
  enterModeResult: boolean;
}

/** Build an empty `CommandCalls` recorder for a `commandContext`. */
function createCalls(): CommandCalls {
  return {
    fileViewSelects: [],
    fileViewRefreshes: [],
    fileViewToggles: [],
    executed: [],
    modeActive: false,
    isEnabledResults: [true],
    executeResult: true,
    paneOpens: [],
    paneCloses: [],
    highlightRefreshes: [],
    enteredModes: [],
    revealed: [],
    fileViewActive: false,
    fileViewToggleRefused: false,
    enterModeResult: true,
  };
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
    navigation: {
      selectFile: (id: string) => selectedIds.push(id),
      revealLine: (fileId: string, side: string, line: number) => calls.revealed.push({ fileId, side, line }),
    },
    notify: (message: string, type?: string) => notified.push([message, type]),
    fileViews: {
      select: (id: string | null) => calls.fileViewSelects.push(id),
      refresh: (id: string, options?: { fileId?: string }) => calls.fileViewRefreshes.push(options?.fileId ? `${id}:${options.fileId}` : id),
      toggle: (id: string) => {
        calls.fileViewToggles.push(id);
        if (!calls.fileViewToggleRefused) calls.fileViewActive = !calls.fileViewActive;
      },
      isActive: () => calls.fileViewActive,
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
      enterMode: (id: string) => {
        calls.enteredModes.push(id);
        if (!calls.enterModeResult) return false;
        calls.modeActive = true;
        return true;
      },
      exitMode: () => {
        calls.modeActive = false;
        return true;
      },
    },
    highlights: {
      refresh: (id: string, options?: { fileId?: string }) => calls.highlightRefreshes.push(options?.fileId ? `${id}:${options.fileId}` : id),
    },
    panes: {
      open: (id: string) => calls.paneOpens.push(id),
      close: (id: string) => calls.paneCloses.push(id),
      toggle: () => {},
      isOpen: () => false,
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
  resetSearchForTests();
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

    expect(fake.panes).toHaveLength(2);
    expect((fake.panes[0] as { replaces?: string }).replaces).toBe("hunk:files");
    expect((fake.panes[1] as { id?: string; placement?: string }).id).toBe("search");
    expect((fake.panes[1] as { id?: string; placement?: string }).placement).toBe("bottom");

    expect(fake.commands.get("toggleViewed")?.command.key).toBe("V");
    expect(fake.commands.get("nextUnviewed")?.command.key).toBe("J");
    expect(fake.commands.get("previousUnviewed")?.command.key).toBe("K");
    expect(fake.commands.get("skipToUnviewed")?.command.key).toBe("U");
    expect(fake.commands.get("clearRepo")?.command.key).toBeUndefined();
    expect(fake.commands.get("foldViewed")?.command.key).toBeUndefined();
    expect(fake.commands.get("singleFile")?.command.key).toBe("o");
    expect(fake.commands.get("search")?.command.key).toEqual(["ctrl+f", "f3"]);
    expect(fake.commands.get("searchNext")?.command.key).toBe("ctrl+n");
    expect(fake.commands.get("searchPrevious")?.command.key).toEqual(["ctrl+p", "shift+f3", "ctrl+shift+f"]);
    expect(fake.commands.get("searchEdit")?.command.key).toBeUndefined();
    expect(fake.commands.get("searchClear")?.command.key).toBeUndefined();

    expect(fake.keyboardModes.size).toBe(2);
    expect(fake.keyboardModes.get("single")).toBeDefined();
    expect(fake.keyboardModes.get("search-prompt")).toBeDefined();

    expect(fake.lineHighlighters.get("search")).toBeDefined();
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

describe("skipToUnviewed", () => {
  test("N selects the next unviewed file after the selection, skipping viewed ones", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[1]!, new Date());

    const selected: string[] = [];
    const notified: Array<[string, string | undefined]> = [];
    fake.commands.get("skipToUnviewed")!.handler(commandContext(files[0]!, selected, notified));

    expect(selected).toEqual(["3"]);
    expect(notified).toEqual([]);
  });

  test("notifies when no unviewed file follows the selection, without selecting", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    storeToggleViewed(files[1]!, new Date());

    const selected: string[] = [];
    const notified: Array<[string, string | undefined]> = [];
    fake.commands.get("skipToUnviewed")!.handler(commandContext(files[2]!, selected, notified));

    expect(selected).toEqual([]);
    expect(notified).toEqual([["No unviewed file after this one", "info"]]);
  });

  test("in single-file mode, retargets to the next unviewed file and refreshes, without selecting", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    fake.transforms[0]!(makeChangeset(files));
    loadChangeset(fake, [files[0]!]);
    enterSingleFile("a.ts");
    storeToggleViewed(files[1]!, new Date());

    const calls = createCalls();
    const selected: string[] = [];
    fake.commands.get("skipToUnviewed")!.handler(commandContext(files[0]!, selected, [], calls));

    expect(selected).toEqual([]);
    expect(getSingleFileState().targetPath).toBe("c.ts");
    expect(calls.executed).toEqual(["hunk.app.refresh"]);
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

  test("leaving the mode reselects the file it was showing, once the exit reload's changeset_loaded and session_reload both land", async () => {
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

    expect(getSingleFileState().returnPath).toBeNull();

    // The handler selects the file twice: once deferred past the current tick, and once more
    // after file-view render plans have had time to resolve, to re-align the header's scroll.
    await new Promise((r) => setTimeout(r, 70));

    expect(selectedIds).toEqual(["2", "2"]);
  });

  test("the settle reselect skips itself if the user already moved off the shown file", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts"), makeFile("3", "c.ts")];
    loadChangeset(fake, files);
    enterSingleFile("b.ts");
    const mode = fake.keyboardModes.get("single")!;
    mode.onExit!(modeContext(createCalls()));

    const selectedIds: string[] = [];
    const ctx = eventContext(repoDir, () => {}, selectedIds);
    fake.events.get("changeset_loaded")!({ changeset: makeChangeset(files) }, ctx);
    fake.events.get("session_reload")!({ changeset: makeChangeset(files), reason: "manual" }, ctx);

    // Past the first (0 ms) reselect, the user moves on — e.g. J/K/,/. — before the 60 ms settle
    // call fires. The settle call must not yank the selection back to the file it was for.
    await new Promise((r) => setTimeout(r, 0));
    fake.events.get("selection_changed")!({ fileId: "3", hunkIndex: null }, ctx);

    await new Promise((r) => setTimeout(r, 70));

    expect(selectedIds).toEqual(["2"]);
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
    expect(mode.onKey({ name: "V", shift: true } as ExtensionKeyEvent, modeContext(calls))).toBe("pass");
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

  test("layout_changed sets the mirror, and the full view follows hunk's resolved layout", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const file = makeFile("1", "a.ts", { patch: "@@ -1 +1 @@\n-a\n+b\n", hunks: [{ index: 0, header: "@@" }] as never });
    loadChangeset(fake, [file]);
    const view = fake.fileViews.find((v) => (v as { id: string }).id === "full") as {
      layout: (input: unknown) => Promise<{ rows: { spans: { text: string }[] }[] } | null>;
    };

    fake.events.get("layout_changed")!({ mode: "auto", layout: "split" }, eventContext(repoDir));
    const split = await view.layout({ file, width: 48, signal: new AbortController().signal, changes: [], readDocument: async () => "b\n" });
    expect(split!.rows.some((row) => row.spans.map((s) => s.text).join("").includes(" │ "))).toBe(true);

    fake.events.get("layout_changed")!({ mode: "auto", layout: "stack" }, eventContext(repoDir));
    const stacked = await view.layout({ file, width: 48, signal: new AbortController().signal, changes: [], readDocument: async () => "b\n" });
    expect(stacked!.rows.some((row) => row.spans.map((s) => s.text).join("").includes(" │ "))).toBe(false);
  });

  test("F applied: waits for the presented state to settle, then records full-view membership from it", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const file = makeFile("1", "a.ts", { patch: "@@ -1 +1 @@\n foo\n", hunks: [{ index: 0, header: "@@" }] as never });
    loadChangeset(fake, [file]);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));
    const beforeHits = getSearchState().hits;

    const calls = createCalls();
    await fake.commands.get("fullFile")!.handler(commandContext(file, [], [], calls));

    expect(calls.fileViewToggles).toEqual(["full"]);
    // The store now treats "1" as a full-view file: a rebuild reads its (still empty, since no
    // `layout` call reported document hits here) document hits instead of scanning the patch, so
    // its patch-scanned hit disappears from the merged list.
    expect(getSearchState().hits).not.toEqual(beforeHits);
    expect(getSearchState().hits).toEqual([]);
  });

  test("F refused: full-view membership is not recorded when the toggle never takes effect", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const file = makeFile("1", "a.ts", { patch: "@@ -1 +1 @@\n foo\n", hunks: [{ index: 0, header: "@@" }] as never });
    loadChangeset(fake, [file]);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));
    const beforeHits = getSearchState().hits;

    const calls = createCalls();
    calls.fileViewToggleRefused = true;
    await fake.commands.get("fullFile")!.handler(commandContext(file, [], [], calls));

    expect(calls.fileViewToggles).toEqual(["full"]);
    // The toggle never took effect, so search still scans the patch for "1" — nothing changed.
    expect(getSearchState().hits).toEqual(beforeHits);
  }, 1000);

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

describe("search", () => {
  test("search with no active query opens the prompt, and Enter submits and runs it", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [
      makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n-x\n+foo bar\n" }),
      makeFile("2", "b.ts", { patch: "@@ -1,1 +1,1 @@\n x\n+another foo\n" }),
    ];
    loadChangeset(fake, files);

    const calls = createCalls();
    const pending = fake.commands.get("search")!.handler(commandContext(files[0]!, [], [], calls));
    expect(calls.paneOpens).toEqual(["search"]);
    expect(calls.enteredModes).toEqual(["search-prompt"]);
    expect(getSearchState().prompt).toEqual({ open: true, draft: "" });

    const mode = fake.keyboardModes.get("search-prompt")!;
    expect(mode.onKey({ sequence: "f" }, modeContext(calls))).toBe("handled");
    expect(mode.onKey({ sequence: "o" }, modeContext(calls))).toBe("handled");
    expect(mode.onKey({ sequence: "o" }, modeContext(calls))).toBe("handled");
    expect(getSearchState().prompt.draft).toBe("foo");
    expect(mode.onKey({ name: "enter" }, modeContext(calls))).toBe("exit");

    await pending;

    expect(getSearchState().query).toBe("foo");
    expect(getSearchState().hits).toHaveLength(2);
    expect(calls.highlightRefreshes).toEqual(["search"]);
    expect(calls.fileViewRefreshes).toEqual(["full"]);
    expect(calls.revealed).toEqual([{ fileId: "1", side: "new", line: 1 }]);
  });

  test("backspace edits the draft", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    const calls = createCalls();
    void fake.commands.get("search")!.handler(commandContext(files[0]!, [], [], calls));
    const mode = fake.keyboardModes.get("search-prompt")!;
    mode.onKey({ sequence: "f" }, modeContext(calls));
    mode.onKey({ sequence: "o" }, modeContext(calls));
    expect(mode.onKey({ name: "backspace" }, modeContext(calls))).toBe("handled");
    expect(getSearchState().prompt.draft).toBe("f");
  });

  test("a ctrl/meta chord is swallowed, not appended; a plain printable character is", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    const calls = createCalls();
    void fake.commands.get("search")!.handler(commandContext(files[0]!, [], [], calls));
    const mode = fake.keyboardModes.get("search-prompt")!;
    expect(mode.onKey({ sequence: "c", ctrl: true }, modeContext(calls))).toBe("handled");
    expect(mode.onKey({ sequence: "{" }, modeContext(calls))).toBe("handled");
    expect(mode.onKey({ name: "up" }, modeContext(calls))).toBe("handled");
    expect(getSearchState().prompt.draft).toBe("{");
  });

  test("a multi-character sequence (a terminal paste) appends in full, not just its first character", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    const calls = createCalls();
    void fake.commands.get("search")!.handler(commandContext(files[0]!, [], [], calls));
    const mode = fake.keyboardModes.get("search-prompt")!;
    expect(mode.onKey({ sequence: "hello" }, modeContext(calls))).toBe("handled");
    expect(getSearchState().prompt.draft).toBe("hello");
    // A pasted sequence containing a control character is still swallowed whole.
    expect(mode.onKey({ sequence: "a\tb" }, modeContext(calls))).toBe("handled");
    expect(getSearchState().prompt.draft).toBe("hello");
  });

  test("OpenTUI's 'return' key name also submits the draft", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" })];
    loadChangeset(fake, files);
    const calls = createCalls();
    const pending = fake.commands.get("search")!.handler(commandContext(files[0]!, [], [], calls));
    const mode = fake.keyboardModes.get("search-prompt")!;
    mode.onKey({ sequence: "f" }, modeContext(calls));
    mode.onKey({ sequence: "o" }, modeContext(calls));
    mode.onKey({ sequence: "o" }, modeContext(calls));
    expect(mode.onKey({ name: "return" }, modeContext(calls))).toBe("exit");

    await pending;

    expect(getSearchState().query).toBe("foo");
  });

  test("Esc cancels the prompt: onExit resolves null, no query, and the pane closes when none was active", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    const calls = createCalls();
    const pending = fake.commands.get("search")!.handler(commandContext(files[0]!, [], [], calls));
    const mode = fake.keyboardModes.get("search-prompt")!;
    mode.onExit!(modeContext(calls));

    await pending;

    expect(getSearchState().query).toBe("");
    expect(getSearchState().prompt.open).toBe(false);
    expect(calls.paneCloses).toEqual(["search"]);
  });

  test("calling search again while the prompt is already open is a no-op; the first prompt still resolves normally", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" })];
    loadChangeset(fake, files);
    const calls = createCalls();
    const first = fake.commands.get("search")!.handler(commandContext(files[0]!, [], [], calls));
    expect(calls.paneOpens).toEqual(["search"]);
    expect(calls.enteredModes).toEqual(["search-prompt"]);

    // Re-entering while the prompt is open (e.g. "Edit search" pressed again mid-edit) must not
    // open a second pane, enter the mode again, or disturb the still-pending first prompt.
    const second = fake.commands.get("search")!.handler(commandContext(files[0]!, [], [], calls));
    expect(calls.paneOpens).toEqual(["search"]);
    expect(calls.enteredModes).toEqual(["search-prompt"]);

    const mode = fake.keyboardModes.get("search-prompt")!;
    mode.onKey({ sequence: "f" }, modeContext(calls));
    mode.onKey({ sequence: "o" }, modeContext(calls));
    mode.onKey({ sequence: "o" }, modeContext(calls));
    mode.onKey({ name: "enter" }, modeContext(calls));

    await Promise.all([first, second]);

    expect(getSearchState().query).toBe("foo");
    expect(calls.paneCloses).toEqual([]);
  });

  test("enterMode failing to start the prompt closes the prompt state and pane, and warns", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts")];
    loadChangeset(fake, files);
    const calls = createCalls();
    calls.enterModeResult = false;
    const notified: Array<[string, string | undefined]> = [];

    await fake.commands.get("search")!.handler(commandContext(files[0]!, [], notified, calls));

    expect(calls.paneOpens).toEqual(["search"]);
    expect(calls.paneCloses).toEqual(["search"]);
    expect(getSearchState().prompt.open).toBe(false);
    expect(notified).toEqual([["Could not open the search prompt", "warning"]]);
    expect(getSearchState().query).toBe("");
  });

  test("search with an active query advances to the next hit and reveals it", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,2 +1,2 @@\n foo one\n foo two\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));
    expect(getSearchState().currentIndex).toBe(0);

    const calls = createCalls();
    fake.commands.get("search")!.handler(commandContext(files[0]!, [], [], calls));

    expect(getSearchState().currentIndex).toBe(1);
    expect(calls.revealed).toEqual([{ fileId: "1", side: "new", line: 2 }]);
    expect(calls.paneOpens).toEqual([]);
    expect(calls.enteredModes).toEqual([]);
  });

  test("moveHit refreshes only the file the pick left and the file it landed on, not every file", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [
      makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" }),
      makeFile("2", "b.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" }),
      makeFile("3", "c.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" }),
    ];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));
    expect(getSearchState().hits.map((h) => h.fileId)).toEqual(["1", "2", "3"]);

    const calls = createCalls();
    // Moves from file "1" (index 0) to file "2" (index 1): only those two files' marks changed.
    fake.commands.get("searchNext")!.handler(commandContext(files[0]!, [], [], calls));

    expect(calls.highlightRefreshes.sort()).toEqual(["search:1", "search:2"]);
    expect(calls.fileViewRefreshes.sort()).toEqual(["full:1", "full:2"]);
  });

  test("moveHit within a single-hit file (the pick leaves and lands on the same file) refreshes it once", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));

    const calls = createCalls();
    fake.commands.get("searchNext")!.handler(commandContext(files[0]!, [], [], calls));

    expect(calls.highlightRefreshes).toEqual(["search:1"]);
    expect(calls.fileViewRefreshes).toEqual(["full:1"]);
  });

  test("searchPrevious wraps to the last hit with a notice", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,2 +1,2 @@\n foo one\n foo two\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));

    const notified: Array<[string, string | undefined]> = [];
    fake.commands.get("searchPrevious")!.handler(commandContext(files[0]!, [], notified, createCalls()));

    expect(getSearchState().currentIndex).toBe(1);
    expect(notified).toEqual([["Wrapped to the last hit", "info"]]);
  });

  test("searchNext notifies when there are no hits", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n nomatch\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));

    const notified: Array<[string, string | undefined]> = [];
    fake.commands.get("searchNext")!.handler(commandContext(files[0]!, [], notified, createCalls()));

    expect(notified).toEqual([["No hits", "info"]]);
  });

  test("searchClear applies clear and closes the pane", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));

    const calls = createCalls();
    fake.commands.get("searchClear")!.handler(commandContext(files[0]!, [], [], calls));

    expect(getSearchState().query).toBe("");
    expect(calls.paneCloses).toEqual(["search"]);
    expect(calls.highlightRefreshes).toEqual(["search"]);
    expect(calls.fileViewRefreshes).toEqual(["full"]);
  });

  test("searchEdit reopens the prompt prefilled with the current query", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));

    const calls = createCalls();
    void fake.commands.get("searchEdit")!.handler(commandContext(files[0]!, [], [], calls));

    expect(getSearchState().prompt).toEqual({ open: true, draft: "foo" });
    expect(calls.paneOpens).toEqual(["search"]);
    // Editing does not touch the query itself until submitted; that stays the driver of the
    // "search with an active query moves to the next hit" branch of the `search` command.
    expect(getSearchState().query).toBe("foo");
  });

  test("the search highlighter marks match/current per patch line, and skips a full-view file", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,2 +1,2 @@\n foo one\n foo two\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));

    const highlighter = fake.lineHighlighters.get("search")!;
    const input = { file: files[0]!, signal: new AbortController().signal, readDocument: async () => null };
    expect(highlighter.highlight(input)).toEqual([
      { side: "new", line: 1, range: [0, 3], tone: "current" },
      { side: "new", line: 2, range: [0, 3], tone: "match" },
    ]);

    setFullViewFile("1", true);
    expect(highlighter.highlight(input)).toEqual([]);
  });

  test("the search highlighter returns no marks for a viewed file", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));
    storeToggleViewed(files[0]!, new Date());

    const highlighter = fake.lineHighlighters.get("search")!;
    const input = { file: files[0]!, signal: new AbortController().signal, readDocument: async () => null };
    expect(highlighter.highlight(input)).toEqual([]);
  });

  test("a viewed file is excluded from the scan; unmarking it with v rebuilds hits and refreshes its marks", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [
      makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" }),
      makeFile("2", "b.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" }),
      makeFile("3", "c.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" }),
    ];
    loadChangeset(fake, files);
    storeToggleViewed(files[1]!, new Date()); // "b.ts" is viewed before the search even starts

    const calls = createCalls();
    const pending = fake.commands.get("search")!.handler(commandContext(files[0]!, [], [], calls));
    const mode = fake.keyboardModes.get("search-prompt")!;
    mode.onKey({ sequence: "f" }, modeContext(calls));
    mode.onKey({ sequence: "o" }, modeContext(calls));
    mode.onKey({ sequence: "o" }, modeContext(calls));
    mode.onKey({ name: "enter" }, modeContext(calls));
    await pending;

    expect(getSearchState().hits.map((h) => h.fileId)).toEqual(["1", "3"]); // "2" (viewed) excluded

    // `V` unmarks "b.ts": the query is active, so the command rebuilds and refreshes just that file.
    const unmarkCalls = createCalls();
    fake.commands.get("toggleViewed")!.handler(commandContext(files[1]!, [], [], unmarkCalls));

    expect(isViewed(getViewedState(), files[1]!)).toBe(false);
    expect(getSearchState().hits.map((h) => h.fileId)).toEqual(["1", "2", "3"]);
    expect(unmarkCalls.highlightRefreshes).toEqual(["search:2"]);
  });

  test("marking a file viewed while a query is active drops its hits and refreshes its marks", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" }), makeFile("2", "b.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));
    expect(getSearchState().hits.map((h) => h.fileId)).toEqual(["1", "2"]);

    const calls = createCalls();
    fake.commands.get("toggleViewed")!.handler(commandContext(files[1]!, [], [], calls));

    expect(isViewed(getViewedState(), files[1]!)).toBe(true);
    expect(getSearchState().hits.map((h) => h.fileId)).toEqual(["1"]);
    expect(calls.highlightRefreshes).toEqual(["search:2"]);
  });

  test("a full-view file's document hits merge into the count once its layout reports them, and drop out again when the query changes them away", async () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const patchFile = makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n nomatch\n" });
    const fullViewFile = makeFile("2", "b.ts", { patch: "@@ -1,1 +1,1 @@\n nomatch\n", hunks: [{ index: 0, header: "@@" }] as never });
    loadChangeset(fake, [patchFile, fullViewFile]);
    setFullViewFile("2", true);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));
    expect(getSearchState().hits).toEqual([]); // neither file's patch matches "foo" yet

    const view = fake.fileViews.find((v) => (v as { id: string }).id === "full") as {
      layout: (input: unknown) => Promise<unknown>;
    };
    await view.layout({
      file: fullViewFile,
      width: 80,
      signal: new AbortController().signal,
      changes: [],
      readDocument: async () => "foo\n",
    });

    // The view's own `layout` pass is the only place that ever learns "b.ts" (as a full-view
    // file) has a hit; without it rebuilding the merged list itself, the count would stay 0.
    expect(getSearchState().hits).toEqual([{ fileId: "2", filePath: "b.ts", side: "new", line: 1, range: [0, 3] }]);

    // Change the document so the same file's hits actually change; the merged list follows.
    await view.layout({
      file: fullViewFile,
      width: 80,
      signal: new AbortController().signal,
      changes: [],
      readDocument: async () => "nomatch\n",
    });
    expect(getSearchState().hits).toEqual([]);
  });

  test("filter_changed drops the hidden file's hits and clamps the current index", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" }), makeFile("2", "b.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));
    stepHit(1);
    expect(getSearchState().currentIndex).toBe(1);

    fake.events.get("filter_changed")!({ filter: "a.ts" }, eventContext(repoDir));

    expect(getSearchState().hits).toHaveLength(1);
    expect(getSearchState().currentIndex).toBe(0);
  });

  test("entering single-file mode restricts the hit count to the shown file; leaving it restores the rest", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" }), makeFile("2", "b.ts", { patch: "@@ -1,1 +1,1 @@\n foo\n" })];
    loadChangeset(fake, files);
    setQuery("foo");
    rebuildHits(visibleFiles(getReviewMirror()));
    expect(getSearchState().hits.map((h) => h.fileId)).toEqual(["1", "2"]);

    enterSingleFile("a.ts");
    // A single-file-mode reload's changeset only ever carries the one target file.
    const ctx = eventContext(repoDir);
    fake.events.get("changeset_loaded")!({ changeset: makeChangeset([files[0]!]) }, ctx);
    fake.events.get("session_reload")!({ changeset: makeChangeset([files[0]!]), reason: "manual" }, ctx);

    expect(getSearchState().hits.map((h) => h.fileId)).toEqual(["1"]);

    // Leaving the mode reloads the full changeset again.
    fake.keyboardModes.get("single")!.onExit!(modeContext(createCalls()));
    fake.events.get("changeset_loaded")!({ changeset: makeChangeset(files) }, ctx);
    fake.events.get("session_reload")!({ changeset: makeChangeset(files), reason: "manual" }, ctx);

    expect(getSearchState().hits.map((h) => h.fileId)).toEqual(["1", "2"]);
  });

  test("changeset_loaded prunes full-view membership for files no longer present", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts")];
    loadChangeset(fake, files);
    setFullViewFile("1", true);
    setFullViewFile("2", true);

    // A fresh load only carries "2" onward (as if "1" no longer exists in the new changeset).
    loadChangeset(fake, [makeFile("2", "b.ts")]);

    expect(getSearchState().fullViewFileIds).toEqual(new Set(["2"]));
  });

  test("session_reload prunes full-view membership for files no longer present", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    const files = [makeFile("1", "a.ts"), makeFile("2", "b.ts")];
    loadChangeset(fake, files);
    setFullViewFile("1", true);
    setFullViewFile("2", true);

    fake.events.get("session_reload")!({ changeset: makeChangeset([makeFile("2", "b.ts")]), reason: "manual" }, eventContext(repoDir));

    expect(getSearchState().fullViewFileIds).toEqual(new Set(["2"]));
  });

  test("the highlighter caps marks at 100 per line and 2,000 per file", () => {
    const fake = createFakeHunk();
    registerExtension(fake.hunk);
    // One line with 150 occurrences of "a" (over the 100/line cap), and enough repeated single-hit
    // lines to push the file well past the 2,000/file cap.
    const denseLine = "a".repeat(150);
    const manyLines = Array.from({ length: 2100 }, () => " a").join("\n");
    const patch = `@@ -1,2102 +1,2102 @@\n ${denseLine}\n${manyLines}\n`;
    const file = makeFile("1", "a.ts", { patch });
    loadChangeset(fake, [file]);
    setQuery("a");
    rebuildHits(visibleFiles(getReviewMirror()));

    const highlighter = fake.lineHighlighters.get("search")!;
    const marks = highlighter.highlight({ file, signal: new AbortController().signal, readDocument: async () => null }) as unknown[];

    expect(marks.length).toBeLessThanOrEqual(2000);
    const onFirstLine = marks.filter((m) => (m as { line: number }).line === 1);
    expect(onFirstLine.length).toBeLessThanOrEqual(100);
  });
});

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
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { HUNK_EXTENSION_API_VERSION } from "hunkdiff/extension";
import registerExtension from "./index";
import { getReviewMirror, resetReviewMirrorForTests, setMirrorFilter } from "./src/reviewMirror";
import { getViewedState, isViewed, resetViewedStoreForTests, toggleViewed as storeToggleViewed } from "./src/viewedStore";

/** What the fake `hunk` object recorded during one factory call. */
interface FakeHunk {
  hunk: HunkExtensionAPI;
  panes: unknown[];
  commands: Map<string, { command: ExtensionCommand; handler: ExtensionCommandHandler }>;
  keyboardModes: Map<string, ExtensionKeyboardMode>;
  events: Map<ExtensionEventName, ExtensionEventHandler>;
  logs: string[];
}

/** Build a minimal HunkExtensionAPI stub that records every registration call. */
function createFakeHunk(): FakeHunk {
  const panes: unknown[] = [];
  const commands: FakeHunk["commands"] = new Map();
  const keyboardModes: FakeHunk["keyboardModes"] = new Map();
  const events: FakeHunk["events"] = new Map();
  const logs: string[] = [];
  const hunk = {
    apiVersion: HUNK_EXTENSION_API_VERSION,
    log: (message: string) => logs.push(message),
    registerPane: (pane: unknown) => panes.push(pane),
    registerCommand: (command: ExtensionCommand, handler: ExtensionCommandHandler) => commands.set(command.id, { command, handler }),
    registerKeyboardMode: (mode: ExtensionKeyboardMode) => keyboardModes.set(mode.id, mode),
    on: (event: ExtensionEventName, handler: ExtensionEventHandler) => events.set(event, handler),
  } as unknown as HunkExtensionAPI;
  return { hunk, panes, commands, keyboardModes, events, logs };
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

function commandContext(
  selectedFile: ExtensionDiffFile | null,
  selectedIds: string[],
  notified: Array<[string, string | undefined]> = [],
): ExtensionCommandContext {
  return {
    selection: { file: selectedFile, hunkIndex: null, currentLine: null },
    navigation: { selectFile: (id: string) => selectedIds.push(id) },
    notify: (message: string, type?: string) => notified.push([message, type]),
  } as unknown as ExtensionCommandContext;
}

let repoDir: string;
let stateDir: string;
let originalXdgStateHome: string | undefined;

beforeEach(() => {
  resetViewedStoreForTests();
  resetReviewMirrorForTests();
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

    expect(fake.keyboardModes.size).toBe(0);
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

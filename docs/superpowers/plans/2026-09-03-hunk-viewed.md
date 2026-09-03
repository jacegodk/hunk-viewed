# hunk-viewed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hunk extension that marks files as viewed, shows the mark in a replacement files pane, skips viewed files with `J`/`K`, and keeps marks in `~/.local/state/hunk/viewed.json`.

**Architecture:** A folder extension with no runtime dependencies. Two module-local stores (`reviewMirror`, `viewedStore`) are fed by hunk lifecycle events and read by a React pane through `useSyncExternalStore`. Commands and one keyboard mode call hunk's public navigation. Persistence is a small JSON file written atomically on every change.

**Tech Stack:** TypeScript, Bun 1.4 (`bun test`, `tsc --noEmit`), React 19 with `@opentui/react` JSX, `hunkdiff@0.21.0` extension types (API version 16).

**Spec:** `docs/superpowers/specs/2026-09-03-hunk-viewed-design.md`

## Global Constraints

- Repo: `~/work/hunk-viewed`. Every path below is relative to it.
- Extension id is the folder name: `hunk-viewed`. Command ids are `hunk-viewed.<id>`, the mode id is `hunk-viewed:files`.
- `bun` is not on the Bash tool PATH. Start every bun command with `export PATH="$HOME/.bun/bin:$PATH";`.
- No `dependencies` in `package.json`. `react`, `@opentui/*`, and `hunkdiff/extension` come from the host at runtime; they are `devDependencies` for types and tests only.
- Default keys: `v`, `J`, `K`, `F`. Never `f`, `j`, `k`, `tab` as defaults; hunk refuses them.
- State file: `$XDG_STATE_HOME/hunk/viewed.json`, default `~/.local/state/hunk/viewed.json`; Windows `%LOCALAPPDATA%\hunk\viewed.json`. Mode `0o600`. Entries expire after 30 days.
- Viewed identity: repo key = `realpathSync(cwd)`, file key = `file.path`, hash = sha256 hex of `file.patch`.
- Viewed files are never hidden and never removed from navigation by the host. Only `J`/`K` and `v` skip them.
- Ported sidebar code (entries, rows) comes from hunk (MIT, Modem Labs Inc.). Keep the attribution in `LICENSE` and `README.md`.
- Comment style: short JSDoc on each exported function, active voice, first sentence says what it does.
- Commits: one per task, no `Co-Authored-By` line, never amend.
- Manual verification runs from `~/work/hunk` on a real diff: `hunk diff --extension ~/work/hunk-viewed` in a real TTY. The agent never runs the TUI itself; it asks the user to run it.

---

## File structure

| File | Responsibility |
| --- | --- |
| `package.json` | manifest: name, version, `hunk.apiVersion` 16, `hunk.extensions`, scripts, devDependencies |
| `tsconfig.json` | strict TS, `jsx: react-jsx`, `jsxImportSource: @opentui/react`, bun + react types |
| `index.tsx` | factory: register pane, commands, keyboard mode, event handlers; wire persistence |
| `src/patchHash.ts` | `hashPatch(patch)` sha256 hex |
| `src/viewedFile.ts` | state file path, read, write (merge, gc, atomic) |
| `src/viewedStore.ts` | current repo's marks, toggle/reconcile/clear, subscribe hook, persistence callback |
| `src/reviewMirror.ts` | files, filter, selectedFileId, filesModeActive from events; visible files helper; hook |
| `src/navigation.ts` | `findUnviewedNeighbor(files, selectedFileId, direction, isViewed)` |
| `src/sidebar/text.ts` | `fitText`, `padText`, `formatTerminalPath` (simplified ports) |
| `src/sidebar/entries.ts` | ported flat and tree entry builders, stats helpers, mode by width |
| `src/sidebar/rows.tsx` | `FileRow`, `DirectoryRow`, `GroupHeader` |
| `src/sidebar/FilesPane.tsx` | pane component: title row + scrollbox of rows |
| `README.md`, `LICENSE`, `.gitignore` | docs and license |

---

### Task 1: Scaffold the folder extension

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `index.tsx`

**Interfaces:**
- Produces: a loadable, typechecking extension with id `hunk-viewed` that registers nothing yet.

- [ ] **Step 1: Write the manifest**

`package.json`:

```json
{
  "name": "hunk-viewed",
  "version": "0.1.0",
  "description": "Mark files as viewed in hunk, GitLab style: check marks in the files pane, skip viewed files, marks persist between runs.",
  "license": "MIT",
  "private": true,
  "type": "module",
  "hunk": {
    "apiVersion": 16,
    "extensions": ["./index.tsx"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "devDependencies": {
    "@opentui/core": "^0.5.6",
    "@opentui/react": "^0.5.6",
    "@types/bun": "1.3.14",
    "@types/react": "^19.2.14",
    "hunkdiff": "0.21.0",
    "react": "^19.2.4",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 2: Write tsconfig**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "types": ["bun", "react"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["index.tsx", "src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 3: Write .gitignore and LICENSE**

`.gitignore`:

```text
node_modules/
bun.lock
```

`LICENSE`:

```text
MIT License

Copyright (c) 2026 Jens Andersen

Portions of src/sidebar/ are adapted from hunk (https://github.com/modem-dev/hunk),
Copyright (c) Modem Labs Inc., MIT License.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Write an empty factory**

`index.tsx`:

```tsx
import type { HunkExtensionAPI } from "hunkdiff/extension";

/** Register the hunk-viewed pane, commands, keyboard mode, and event handlers. */
export default function (hunk: HunkExtensionAPI) {
  hunk.log("hunk-viewed loaded");
}
```

- [ ] **Step 5: Install and typecheck**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun install && bun run typecheck`
Expected: install succeeds, `tsc` prints nothing and exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/work/hunk-viewed && git add -A && git commit -m "chore: scaffold hunk-viewed folder extension"
```

---

### Task 2: Patch hash

**Files:**
- Create: `src/patchHash.ts`, `src/patchHash.test.ts`

**Interfaces:**
- Produces: `hashPatch(patch: string): string` — lowercase sha256 hex of the UTF-8 patch text.

- [ ] **Step 1: Write the failing test**

`src/patchHash.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { hashPatch } from "./patchHash";

describe("hashPatch", () => {
  test("returns the sha256 hex of the patch text", () => {
    expect(hashPatch("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hashPatch("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("differs when the patch differs", () => {
    expect(hashPatch("+a\n")).not.toBe(hashPatch("+b\n"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/patchHash.test.ts`
Expected: FAIL, cannot find module `./patchHash`.

- [ ] **Step 3: Implement**

`src/patchHash.ts`:

```ts
import { createHash } from "node:crypto";

/** Return the sha256 hex digest of one file's patch text; the viewed mark is tied to it. */
export function hashPatch(patch: string): string {
  return createHash("sha256").update(patch, "utf8").digest("hex");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/patchHash.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
cd ~/work/hunk-viewed && git add src/patchHash.ts src/patchHash.test.ts && git commit -m "feat: hash file patches for viewed identity"
```

---

### Task 3: State file read and write

**Files:**
- Create: `src/viewedFile.ts`, `src/viewedFile.test.ts`

**Interfaces:**
- Produces:
  - `interface ViewedEntry { hash: string; at: string }` (`at` is an ISO timestamp)
  - `type RepoFiles = Record<string, ViewedEntry>` (key: file path)
  - `interface ViewedFileDocument { version: 1; repos: Record<string, { files: RepoFiles }> }`
  - `resolveViewedFilePath(env: NodeJS.ProcessEnv, platform: string, homeDir: string): string`
  - `readRepoFiles(filePath: string, repoKey: string, log: (message: string) => void): RepoFiles`
  - `writeRepoFiles(filePath: string, repoKey: string, files: RepoFiles, now: Date): void`
  - `const VIEWED_TTL_MS = 30 * 24 * 60 * 60 * 1000`

- [ ] **Step 1: Write the failing tests**

`src/viewedFile.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRepoFiles, resolveViewedFilePath, writeRepoFiles } from "./viewedFile";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hunk-viewed-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveViewedFilePath", () => {
  test("uses XDG_STATE_HOME when set", () => {
    expect(resolveViewedFilePath({ XDG_STATE_HOME: "/x/state" }, "linux", "/home/u")).toBe(
      join("/x/state", "hunk", "viewed.json"),
    );
  });

  test("defaults to ~/.local/state on linux and darwin", () => {
    expect(resolveViewedFilePath({}, "linux", "/home/u")).toBe(
      join("/home/u", ".local", "state", "hunk", "viewed.json"),
    );
    expect(resolveViewedFilePath({}, "darwin", "/Users/u")).toBe(
      join("/Users/u", ".local", "state", "hunk", "viewed.json"),
    );
  });

  test("uses LOCALAPPDATA on windows", () => {
    expect(resolveViewedFilePath({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(
      join("C:\\Users\\u\\AppData\\Local", "hunk", "viewed.json"),
    );
  });
});

describe("readRepoFiles", () => {
  test("returns an empty record when the file is missing", () => {
    const logs: string[] = [];
    expect(readRepoFiles(join(dir, "viewed.json"), "/repo", (m) => logs.push(m))).toEqual({});
    expect(logs).toEqual([]);
  });

  test("returns the repo's files", () => {
    const path = join(dir, "viewed.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        repos: { "/repo": { files: { "a.ts": { hash: "h", at: "2026-09-01T00:00:00.000Z" } } } },
      }),
    );
    expect(readRepoFiles(path, "/repo", () => {})).toEqual({
      "a.ts": { hash: "h", at: "2026-09-01T00:00:00.000Z" },
    });
    expect(readRepoFiles(path, "/other", () => {})).toEqual({});
  });

  test("logs and returns empty on corrupt json or wrong version", () => {
    const path = join(dir, "viewed.json");
    writeFileSync(path, "{not json");
    const logs: string[] = [];
    expect(readRepoFiles(path, "/repo", (m) => logs.push(m))).toEqual({});
    expect(logs.length).toBe(1);

    writeFileSync(path, JSON.stringify({ version: 2, repos: {} }));
    expect(readRepoFiles(path, "/repo", (m) => logs.push(m))).toEqual({});
    expect(logs.length).toBe(2);
  });
});

describe("writeRepoFiles", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");

  test("keeps other repos and drops expired entries", () => {
    const path = join(dir, "viewed.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        repos: {
          "/other": { files: { "o.ts": { hash: "x", at: "2026-09-02T00:00:00.000Z" } } },
          "/repo": { files: { "stale.ts": { hash: "s", at: "2026-01-01T00:00:00.000Z" } } },
        },
      }),
    );

    writeRepoFiles(
      path,
      "/repo",
      {
        "a.ts": { hash: "h", at: "2026-09-03T11:00:00.000Z" },
        "old.ts": { hash: "o", at: "2026-07-01T00:00:00.000Z" },
      },
      now,
    );

    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.version).toBe(1);
    expect(doc.repos["/repo"].files).toEqual({
      "a.ts": { hash: "h", at: "2026-09-03T11:00:00.000Z" },
    });
    expect(doc.repos["/other"].files).toEqual({ "o.ts": { hash: "x", at: "2026-09-02T00:00:00.000Z" } });
  });

  test("creates missing directories and merges with the current contents", () => {
    const path = join(dir, "nested", "hunk", "viewed.json");
    writeRepoFiles(path, "/other", { "o.ts": { hash: "x", at: now.toISOString() } }, now);
    writeRepoFiles(path, "/repo", { "a.ts": { hash: "h", at: now.toISOString() } }, now);

    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(doc.repos).sort()).toEqual(["/other", "/repo"]);
  });

  test("removes a repo record that becomes empty", () => {
    const path = join(dir, "viewed.json");
    writeRepoFiles(path, "/repo", { "a.ts": { hash: "h", at: now.toISOString() } }, now);
    writeRepoFiles(path, "/repo", {}, now);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.repos).toEqual({});
  });

  test("writes with mode 0600 on posix", () => {
    if (process.platform === "win32") return;
    const path = join(dir, "viewed.json");
    writeRepoFiles(path, "/repo", { "a.ts": { hash: "h", at: now.toISOString() } }, now);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/viewedFile.test.ts`
Expected: FAIL, cannot find module `./viewedFile`.

- [ ] **Step 3: Implement**

`src/viewedFile.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ViewedEntry {
  /** sha256 hex of the file's patch when it was marked. */
  hash: string;
  /** ISO timestamp of the mark; entries expire after VIEWED_TTL_MS. */
  at: string;
}

export type RepoFiles = Record<string, ViewedEntry>;

export interface ViewedFileDocument {
  version: 1;
  repos: Record<string, { files: RepoFiles }>;
}

export const VIEWED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Resolve the state file path: $XDG_STATE_HOME/hunk/viewed.json, %LOCALAPPDATA% on Windows, else ~/.local/state. */
export function resolveViewedFilePath(
  env: NodeJS.ProcessEnv,
  platform: string,
  homeDir: string,
): string {
  if (env.XDG_STATE_HOME) {
    return join(env.XDG_STATE_HOME, "hunk", "viewed.json");
  }
  if (platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "hunk", "viewed.json");
  }
  return join(homeDir, ".local", "state", "hunk", "viewed.json");
}

/** Parse the state file, or return an empty document when it is missing or unusable. */
function readDocument(filePath: string, log: (message: string) => void): ViewedFileDocument {
  const empty: ViewedFileDocument = { version: 1, repos: {} };
  if (!existsSync(filePath)) {
    return empty;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ViewedFileDocument>;
    if (parsed.version !== 1 || typeof parsed.repos !== "object" || parsed.repos === null) {
      log(`hunk-viewed: ignoring ${filePath}: unsupported format`);
      return empty;
    }
    return { version: 1, repos: parsed.repos };
  } catch (error) {
    log(`hunk-viewed: ignoring ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }
}

/** Read the viewed marks stored for one repo. */
export function readRepoFiles(
  filePath: string,
  repoKey: string,
  log: (message: string) => void,
): RepoFiles {
  return readDocument(filePath, log).repos[repoKey]?.files ?? {};
}

/** Drop entries older than VIEWED_TTL_MS. */
function pruneExpired(files: RepoFiles, now: Date): RepoFiles {
  const cutoff = now.getTime() - VIEWED_TTL_MS;
  const kept: RepoFiles = {};
  for (const [path, entry] of Object.entries(files)) {
    if (Date.parse(entry.at) >= cutoff) {
      kept[path] = entry;
    }
  }
  return kept;
}

/**
 * Replace one repo's marks in the state file and write it atomically.
 *
 * Rereads the file first so sessions in other repos keep their marks. Every
 * repo's expired entries are pruned on the way through, and a repo left with
 * no entries is removed.
 */
export function writeRepoFiles(filePath: string, repoKey: string, files: RepoFiles, now: Date): void {
  const document = readDocument(filePath, () => {});
  const repos: ViewedFileDocument["repos"] = {};
  for (const [key, record] of Object.entries(document.repos)) {
    if (key === repoKey) continue;
    const kept = pruneExpired(record.files, now);
    if (Object.keys(kept).length > 0) repos[key] = { files: kept };
  }
  const own = pruneExpired(files, now);
  if (Object.keys(own).length > 0) repos[repoKey] = { files: own };

  mkdirSync(dirname(filePath), { recursive: true });
  const staged = `${filePath}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(staged, filePath);
  } catch (error) {
    // Windows refuses to rename over an open target; fall back to a plain overwrite.
    if (process.platform === "win32" && existsSync(filePath)) {
      rmSync(filePath, { force: true });
      renameSync(staged, filePath);
      return;
    }
    rmSync(staged, { force: true });
    throw error;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/viewedFile.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/work/hunk-viewed && git add src/viewedFile.ts src/viewedFile.test.ts && git commit -m "feat: read and write the viewed state file"
```

---

### Task 4: Viewed store

**Files:**
- Create: `src/viewedStore.ts`, `src/viewedStore.test.ts`

**Interfaces:**
- Consumes: `hashPatch` (Task 2), `RepoFiles`, `ViewedEntry` (Task 3).
- Produces:
  - `interface ViewedFileLike { path: string; patch: string }`
  - `interface ViewedState { repoKey: string | null; files: RepoFiles }`
  - `getViewedState(): ViewedState`
  - `subscribeViewed(listener: () => void): () => void`
  - `useViewedState(): ViewedState` (React hook via `useSyncExternalStore`)
  - `loadRepo(repoKey: string, files: RepoFiles): void`
  - `isViewed(state: ViewedState, file: ViewedFileLike): boolean` (pure)
  - `toggleViewed(file: ViewedFileLike, now: Date): "marked" | "cleared"`
  - `reconcileViewed(files: readonly ViewedFileLike[]): void`
  - `clearRepo(): void`
  - `setPersist(persist: ((repoKey: string, files: RepoFiles) => void) | null): void`
  - `resetViewedStoreForTests(): void`

- [ ] **Step 1: Write the failing tests**

`src/viewedStore.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { hashPatch } from "./patchHash";
import {
  clearRepo,
  getViewedState,
  isViewed,
  loadRepo,
  reconcileViewed,
  resetViewedStoreForTests,
  setPersist,
  subscribeViewed,
  toggleViewed,
} from "./viewedStore";

const now = new Date("2026-09-03T12:00:00.000Z");
const a = { path: "src/a.ts", patch: "+a\n" };
const b = { path: "src/b.ts", patch: "+b\n" };

beforeEach(() => {
  resetViewedStoreForTests();
});

describe("viewedStore", () => {
  test("starts empty and unloaded", () => {
    expect(getViewedState()).toEqual({ repoKey: null, files: {} });
    expect(isViewed(getViewedState(), a)).toBe(false);
  });

  test("loadRepo installs the repo's files", () => {
    loadRepo("/repo", { "src/a.ts": { hash: hashPatch(a.patch), at: now.toISOString() } });
    expect(getViewedState().repoKey).toBe("/repo");
    expect(isViewed(getViewedState(), a)).toBe(true);
    expect(isViewed(getViewedState(), b)).toBe(false);
  });

  test("a stored hash that does not match the patch means not viewed", () => {
    loadRepo("/repo", { "src/a.ts": { hash: "stale", at: now.toISOString() } });
    expect(isViewed(getViewedState(), a)).toBe(false);
  });

  test("toggleViewed marks, then clears, and notifies subscribers and persist", () => {
    loadRepo("/repo", {});
    const persisted: Array<[string, Record<string, unknown>]> = [];
    setPersist((repoKey, files) => persisted.push([repoKey, files]));
    let notified = 0;
    subscribeViewed(() => notified++);

    expect(toggleViewed(a, now)).toBe("marked");
    expect(isViewed(getViewedState(), a)).toBe(true);
    expect(getViewedState().files["src/a.ts"]).toEqual({ hash: hashPatch(a.patch), at: now.toISOString() });

    expect(toggleViewed(a, now)).toBe("cleared");
    expect(isViewed(getViewedState(), a)).toBe(false);
    expect(getViewedState().files["src/a.ts"]).toBeUndefined();

    expect(notified).toBe(2);
    expect(persisted.length).toBe(2);
    expect(persisted[0]?.[0]).toBe("/repo");
  });

  test("toggleViewed on a file with a stale hash marks it with the new hash", () => {
    loadRepo("/repo", { "src/a.ts": { hash: "stale", at: now.toISOString() } });
    expect(toggleViewed(a, now)).toBe("marked");
    expect(getViewedState().files["src/a.ts"]?.hash).toBe(hashPatch(a.patch));
  });

  test("reconcileViewed drops entries whose file changed and keeps entries for absent files", () => {
    loadRepo("/repo", {
      "src/a.ts": { hash: "stale", at: now.toISOString() },
      "src/b.ts": { hash: hashPatch(b.patch), at: now.toISOString() },
      "src/gone.ts": { hash: "g", at: now.toISOString() },
    });
    const persisted: string[] = [];
    setPersist((repoKey) => persisted.push(repoKey));

    reconcileViewed([a, b]);

    expect(Object.keys(getViewedState().files).sort()).toEqual(["src/b.ts", "src/gone.ts"]);
    expect(persisted).toEqual(["/repo"]);
  });

  test("reconcileViewed with nothing to drop does not notify or persist", () => {
    loadRepo("/repo", { "src/b.ts": { hash: hashPatch(b.patch), at: now.toISOString() } });
    let notified = 0;
    subscribeViewed(() => notified++);
    const persisted: string[] = [];
    setPersist((repoKey) => persisted.push(repoKey));

    reconcileViewed([a, b]);

    expect(notified).toBe(0);
    expect(persisted).toEqual([]);
  });

  test("clearRepo empties the record and persists", () => {
    loadRepo("/repo", { "src/a.ts": { hash: hashPatch(a.patch), at: now.toISOString() } });
    const persisted: Array<Record<string, unknown>> = [];
    setPersist((_repoKey, files) => persisted.push(files));
    clearRepo();
    expect(getViewedState().files).toEqual({});
    expect(persisted).toEqual([{}]);
  });

  test("toggleViewed before loadRepo does nothing", () => {
    expect(toggleViewed(a, now)).toBe("cleared");
    expect(getViewedState().files).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/viewedStore.test.ts`
Expected: FAIL, cannot find module `./viewedStore`.

- [ ] **Step 3: Implement**

`src/viewedStore.ts`:

```ts
import { useSyncExternalStore } from "react";
import { hashPatch } from "./patchHash";
import type { RepoFiles } from "./viewedFile";

/** The two fields a file needs to be checked or marked. `ExtensionDiffFile` satisfies it. */
export interface ViewedFileLike {
  path: string;
  patch: string;
}

export interface ViewedState {
  /** Canonical repo path the marks belong to; null until the startup event loads it. */
  repoKey: string | null;
  files: RepoFiles;
}

type Persist = (repoKey: string, files: RepoFiles) => void;

let state: ViewedState = { repoKey: null, files: {} };
let persist: Persist | null = null;
const listeners = new Set<() => void>();

/** Return the current immutable snapshot. */
export function getViewedState(): ViewedState {
  return state;
}

/** Subscribe to snapshot changes; returns the unsubscribe function. */
export function subscribeViewed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the viewed snapshot from a React component. */
export function useViewedState(): ViewedState {
  return useSyncExternalStore(subscribeViewed, getViewedState);
}

/** Install the save callback; pass null to disable persistence. */
export function setPersist(next: Persist | null): void {
  persist = next;
}

/** Publish a new snapshot, notify React, and save it. Same-object updates are ignored. */
function publish(next: ViewedState) {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
  if (state.repoKey !== null) persist?.(state.repoKey, state.files);
}

/** Install the marks loaded from disk for one repo. Does not persist. */
export function loadRepo(repoKey: string, files: RepoFiles): void {
  state = { repoKey, files };
  for (const listener of listeners) listener();
}

/** Return true when the file has a mark whose hash still matches its patch. */
export function isViewed(current: ViewedState, file: ViewedFileLike): boolean {
  const entry = current.files[file.path];
  return entry !== undefined && entry.hash === hashPatch(file.patch);
}

/** Mark an unviewed file, or clear a viewed one. A stale mark counts as unviewed and is replaced. */
export function toggleViewed(file: ViewedFileLike, now: Date): "marked" | "cleared" {
  if (state.repoKey === null) return "cleared";
  if (isViewed(state, file)) {
    const { [file.path]: _removed, ...rest } = state.files;
    publish({ ...state, files: rest });
    return "cleared";
  }
  publish({
    ...state,
    files: { ...state.files, [file.path]: { hash: hashPatch(file.patch), at: now.toISOString() } },
  });
  return "marked";
}

/**
 * Drop marks for files present in the changeset whose patch no longer matches.
 * Marks for paths absent from the changeset stay, so a path-filtered review does not erase them.
 */
export function reconcileViewed(files: readonly ViewedFileLike[]): void {
  if (state.repoKey === null) return;
  let changed = false;
  const next: RepoFiles = { ...state.files };
  for (const file of files) {
    const entry = next[file.path];
    if (entry !== undefined && entry.hash !== hashPatch(file.patch)) {
      delete next[file.path];
      changed = true;
    }
  }
  if (changed) publish({ ...state, files: next });
}

/** Remove every mark for the current repo. */
export function clearRepo(): void {
  if (state.repoKey === null) return;
  publish({ ...state, files: {} });
}

/** Reset module state between tests. */
export function resetViewedStoreForTests(): void {
  state = { repoKey: null, files: {} };
  persist = null;
  listeners.clear();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/viewedStore.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/work/hunk-viewed && git add src/viewedStore.ts src/viewedStore.test.ts && git commit -m "feat: add the viewed marks store"
```

---

### Task 5: Review mirror and unviewed navigation

**Files:**
- Create: `src/reviewMirror.ts`, `src/reviewMirror.test.ts`, `src/navigation.ts`, `src/navigation.test.ts`

**Interfaces:**
- Consumes: `ExtensionDiffFile` from `hunkdiff/extension`.
- Produces (reviewMirror):
  - `interface ReviewMirror { files: readonly ExtensionDiffFile[]; filter: string; selectedFileId: string | null; filesModeActive: boolean }`
  - `getReviewMirror(): ReviewMirror`, `useReviewMirror(): ReviewMirror`
  - `setMirrorFiles(files: readonly ExtensionDiffFile[]): void`, `setMirrorFilter(filter: string): void`, `setMirrorSelectedFileId(fileId: string | null): void`, `setMirrorFilesModeActive(active: boolean): void`
  - `fileMatchesFilter(path: string, filter: string): boolean` — hunk's rule: lowercased trimmed substring; empty filter matches all.
  - `visibleFiles(mirror: ReviewMirror): ExtensionDiffFile[]`
  - `resetReviewMirrorForTests(): void`
- Produces (navigation):
  - `findUnviewedNeighbor(files: readonly ExtensionDiffFile[], selectedFileId: string | null, direction: 1 | -1, isViewedFile: (file: ExtensionDiffFile) => boolean): ExtensionDiffFile | null` — no wrap; with a null or unknown selection, direction 1 starts from the first file and direction -1 from the last.

- [ ] **Step 1: Write the failing tests**

`src/reviewMirror.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import {
  fileMatchesFilter,
  getReviewMirror,
  resetReviewMirrorForTests,
  setMirrorFiles,
  setMirrorFilter,
  setMirrorSelectedFileId,
  visibleFiles,
} from "./reviewMirror";

function file(id: string, path: string): ExtensionDiffFile {
  return { id, path, patch: "", stats: { additions: 0, deletions: 0 }, metadata: {}, agent: null };
}

beforeEach(() => resetReviewMirrorForTests());

describe("fileMatchesFilter", () => {
  test("empty or blank filter matches everything", () => {
    expect(fileMatchesFilter("src/a.ts", "")).toBe(true);
    expect(fileMatchesFilter("src/a.ts", "   ")).toBe(true);
  });
  test("is a case-insensitive trimmed substring match", () => {
    expect(fileMatchesFilter("src/App.tsx", " app ")).toBe(true);
    expect(fileMatchesFilter("src/App.tsx", "b.ts")).toBe(false);
  });
});

describe("reviewMirror", () => {
  test("starts empty", () => {
    expect(getReviewMirror()).toEqual({ files: [], filter: "", selectedFileId: null, filesModeActive: false });
  });

  test("visibleFiles applies the filter in review order", () => {
    setMirrorFiles([file("1", "src/a.ts"), file("2", "docs/b.md"), file("3", "src/c.ts")]);
    setMirrorFilter("src");
    expect(visibleFiles(getReviewMirror()).map((f) => f.id)).toEqual(["1", "3"]);
  });

  test("setters publish new snapshots", () => {
    const before = getReviewMirror();
    setMirrorSelectedFileId("2");
    expect(getReviewMirror()).not.toBe(before);
    expect(getReviewMirror().selectedFileId).toBe("2");
  });
});
```

`src/navigation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import { findUnviewedNeighbor } from "./navigation";

function file(id: string): ExtensionDiffFile {
  return { id, path: `${id}.ts`, patch: "", stats: { additions: 0, deletions: 0 }, metadata: {}, agent: null };
}
const files = [file("a"), file("b"), file("c"), file("d")];
const viewed = new Set(["b", "d"]);
const isViewedFile = (f: ExtensionDiffFile) => viewed.has(f.id);

describe("findUnviewedNeighbor", () => {
  test("skips viewed files going forward", () => {
    expect(findUnviewedNeighbor(files, "a", 1, isViewedFile)?.id).toBe("c");
  });
  test("skips viewed files going backward", () => {
    expect(findUnviewedNeighbor(files, "d", -1, isViewedFile)?.id).toBe("c");
    expect(findUnviewedNeighbor(files, "c", -1, isViewedFile)?.id).toBe("a");
  });
  test("returns null at the ends without wrapping", () => {
    expect(findUnviewedNeighbor(files, "c", 1, isViewedFile)).toBeNull();
    expect(findUnviewedNeighbor(files, "a", -1, isViewedFile)).toBeNull();
  });
  test("with no selection starts from the first or last file", () => {
    expect(findUnviewedNeighbor(files, null, 1, isViewedFile)?.id).toBe("a");
    expect(findUnviewedNeighbor(files, null, -1, isViewedFile)?.id).toBe("c");
    expect(findUnviewedNeighbor(files, "missing", 1, isViewedFile)?.id).toBe("a");
  });
  test("returns null for an empty list", () => {
    expect(findUnviewedNeighbor([], null, 1, isViewedFile)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/reviewMirror.test.ts src/navigation.test.ts`
Expected: FAIL, cannot find modules.

- [ ] **Step 3: Implement**

`src/reviewMirror.ts`:

```ts
import { useSyncExternalStore } from "react";
import type { ExtensionDiffFile } from "hunkdiff/extension";

/** What the extension knows about the live review, gathered from lifecycle events. */
export interface ReviewMirror {
  /** Full changeset in review order, unfiltered. */
  files: readonly ExtensionDiffFile[];
  /** Hunk's file filter text. */
  filter: string;
  selectedFileId: string | null;
  /** True while the extension's files keyboard mode owns keys. */
  filesModeActive: boolean;
}

const initial: ReviewMirror = { files: [], filter: "", selectedFileId: null, filesModeActive: false };
let mirror: ReviewMirror = initial;
const listeners = new Set<() => void>();

function publish(patch: Partial<ReviewMirror>) {
  mirror = { ...mirror, ...patch };
  for (const listener of listeners) listener();
}

/** Return the current immutable mirror snapshot. */
export function getReviewMirror(): ReviewMirror {
  return mirror;
}

/** Read the mirror from a React component. */
export function useReviewMirror(): ReviewMirror {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getReviewMirror,
  );
}

/** Replace the changeset after `changeset_loaded` or `session_reload`. */
export function setMirrorFiles(files: readonly ExtensionDiffFile[]): void {
  publish({ files });
}

/** Record the filter after `filter_changed`. */
export function setMirrorFilter(filter: string): void {
  publish({ filter });
}

/** Record the selection after `selection_changed`. */
export function setMirrorSelectedFileId(fileId: string | null): void {
  publish({ selectedFileId: fileId });
}

/** Record whether the files keyboard mode is active. */
export function setMirrorFilesModeActive(active: boolean): void {
  publish({ filesModeActive: active });
}

/** Apply hunk's filter rule: lowercased, trimmed substring of the path; blank matches all. */
export function fileMatchesFilter(path: string, filter: string): boolean {
  const query = filter.trim().toLowerCase();
  return query.length === 0 || path.toLowerCase().includes(query);
}

/** Return the files hunk currently shows, in review order. */
export function visibleFiles(current: ReviewMirror): ExtensionDiffFile[] {
  return current.files.filter((file) => fileMatchesFilter(file.path, current.filter));
}

/** Reset module state between tests. */
export function resetReviewMirrorForTests(): void {
  mirror = initial;
  listeners.clear();
}
```

`src/navigation.ts`:

```ts
import type { ExtensionDiffFile } from "hunkdiff/extension";

/**
 * Find the nearest unviewed file after (direction 1) or before (direction -1) the selection.
 * Never wraps. An unknown or null selection starts the search at the first or last file.
 */
export function findUnviewedNeighbor(
  files: readonly ExtensionDiffFile[],
  selectedFileId: string | null,
  direction: 1 | -1,
  isViewedFile: (file: ExtensionDiffFile) => boolean,
): ExtensionDiffFile | null {
  const selectedIndex = selectedFileId === null ? -1 : files.findIndex((file) => file.id === selectedFileId);
  let index: number;
  if (selectedIndex === -1) {
    index = direction === 1 ? 0 : files.length - 1;
  } else {
    index = selectedIndex + direction;
  }
  for (; index >= 0 && index < files.length; index += direction) {
    const file = files[index]!;
    if (!isViewedFile(file)) return file;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/reviewMirror.test.ts src/navigation.test.ts && bun run typecheck`
Expected: all pass, typecheck clean. If `ExtensionDiffFile` requires more fields than the test factory supplies, add them to the factory; do not loosen the type.

- [ ] **Step 5: Commit**

```bash
cd ~/work/hunk-viewed && git add src/reviewMirror.ts src/reviewMirror.test.ts src/navigation.ts src/navigation.test.ts && git commit -m "feat: mirror review state and find unviewed neighbors"
```

---

### Task 6: Sidebar text helpers and entry builders (ported)

**Files:**
- Create: `src/sidebar/text.ts`, `src/sidebar/text.test.ts`, `src/sidebar/entries.ts`, `src/sidebar/entries.test.ts`

**Interfaces:**
- Produces (text):
  - `formatTerminalPath(path: string): string` — escapes `\`, tab, CR, LF, and C0/C1 controls.
  - `textWidth(text: string): number` — number of code points (`Array.from(text).length`).
  - `fitText(text: string, width: number, overflowMarker = "."): string` — truncate to width, marker at the end.
  - `padText(text: string, width: number): string` — fit then right-pad with spaces.
- Produces (entries):
  - `interface SidebarFileSource { id: string; path: string; previousPath?: string; stats: { additions: number; deletions: number }; statsTruncated?: boolean; isUntracked?: boolean; agent?: { annotations: readonly unknown[] } | null; changeType?: "change" | "rename-pure" | "rename-changed" | "new" | "deleted" }` — `ExtensionDiffFile` satisfies it.
  - `interface FileListEntry { kind: "file"; id: string; path: string; name: string; depth: number; agentCommentsText: string | null; additionsText: string | null; deletionsText: string | null; changeType: SidebarFileSource["changeType"] | undefined; isUntracked: boolean }`
  - `interface FileGroupEntry { kind: "group"; id: string; label: string }`
  - `interface FileDirectoryEntry { kind: "directory"; id: string; label: string; depth: number }`
  - `type SidebarEntry = FileListEntry | FileGroupEntry | FileDirectoryEntry`
  - `type FileSidebarMode = "flat" | "tree"`; `TREE_FILE_SIDEBAR_MIN_CONTENT_WIDTH = 32`; `resolveFileSidebarMode(contentWidth: number): FileSidebarMode`
  - `buildFlatSidebarEntries(files: readonly SidebarFileSource[]): SidebarEntry[]`
  - `buildTreeSidebarEntries(files: readonly SidebarFileSource[]): SidebarEntry[]`
  - `sidebarEntryStats(entry): Array<{ kind: "agent-comment" | "addition" | "deletion"; text: string }>`
  - `sidebarEntryStatsWidth(entry): number`

- [ ] **Step 1: Write the failing tests**

`src/sidebar/text.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { fitText, formatTerminalPath, padText, textWidth } from "./text";

describe("formatTerminalPath", () => {
  test("escapes controls and backslashes", () => {
    expect(formatTerminalPath("a\\b\tc\nd\re\x1b")).toBe("a\\\\b\\tc\\nd\\re\\x1b");
    expect(formatTerminalPath("src/ø.ts")).toBe("src/ø.ts");
  });
});

describe("fitText / padText", () => {
  test("returns text that fits unchanged", () => {
    expect(fitText("abc", 5)).toBe("abc");
  });
  test("truncates with the marker at the end", () => {
    expect(fitText("abcdef", 4)).toBe("abc.");
    expect(fitText("abcdef", 4, "…")).toBe("abc…");
  });
  test("returns empty for zero width", () => {
    expect(fitText("abc", 0)).toBe("");
  });
  test("pads to the width", () => {
    expect(padText("ab", 4)).toBe("ab  ");
    expect(padText("abcdef", 4)).toBe("abc.");
  });
  test("textWidth counts code points", () => {
    expect(textWidth("aø…")).toBe(3);
  });
});
```

`src/sidebar/entries.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  buildFlatSidebarEntries,
  buildTreeSidebarEntries,
  resolveFileSidebarMode,
  sidebarEntryStats,
  sidebarEntryStatsWidth,
  type SidebarFileSource,
} from "./entries";

function src(path: string, extra: Partial<SidebarFileSource> = {}): SidebarFileSource {
  return { id: path, path, stats: { additions: 1, deletions: 2 }, ...extra };
}

describe("resolveFileSidebarMode", () => {
  test("tree at 32 columns and above, flat below", () => {
    expect(resolveFileSidebarMode(32)).toBe("tree");
    expect(resolveFileSidebarMode(31)).toBe("flat");
  });
});

describe("buildFlatSidebarEntries", () => {
  test("groups consecutive files by directory, keeping review order", () => {
    const entries = buildFlatSidebarEntries([src("src/a.ts"), src("src/b.ts"), src("README.md"), src("src/c.ts")]);
    expect(entries.map((e) => (e.kind === "file" ? `file:${e.name}` : `group:${e.label}`))).toEqual([
      "group:src/",
      "file:a.ts",
      "file:b.ts",
      "group:./",
      "file:README.md",
      "group:src/",
      "file:c.ts",
    ]);
    expect(entries.filter((e) => e.kind === "file").every((e) => e.kind === "file" && e.depth === 0)).toBe(true);
  });

  test("labels renames with both names when they differ", () => {
    const [, entry] = buildFlatSidebarEntries([src("src/new.ts", { previousPath: "src/old.ts" })]);
    expect(entry?.kind === "file" && entry.name).toBe("old.ts -> new.ts");
    const [, moved] = buildFlatSidebarEntries([src("lib/x.ts", { previousPath: "src/x.ts" })]);
    expect(moved?.kind === "file" && moved.name).toBe("x.ts");
  });

  test("formats stats and hides zero values", () => {
    const [, entry] = buildFlatSidebarEntries([
      src("a.ts", { stats: { additions: 3, deletions: 0 }, statsTruncated: true, agent: { annotations: [1, 2] } }),
    ]);
    expect(entry?.kind === "file" && entry.additionsText).toBe("+3+");
    expect(entry?.kind === "file" && entry.deletionsText).toBeNull();
    expect(entry?.kind === "file" && entry.agentCommentsText).toBe("*2");
    expect(sidebarEntryStats(entry as never).map((s) => s.text)).toEqual(["*2", "+3+"]);
    expect(sidebarEntryStatsWidth(entry as never)).toBe(6);
  });
});

describe("buildTreeSidebarEntries", () => {
  test("emits directory rows once per shared prefix and indents files by depth", () => {
    const entries = buildTreeSidebarEntries([src("src/ui/a.ts"), src("src/ui/b.ts"), src("src/c.ts"), src("README.md")]);
    expect(
      entries.map((e) =>
        e.kind === "file" ? `${e.depth}:file:${e.name}` : e.kind === "directory" ? `${e.depth}:dir:${e.label}` : "group",
      ),
    ).toEqual([
      "0:dir:src/",
      "1:dir:ui/",
      "2:file:a.ts",
      "2:file:b.ts",
      "1:file:c.ts",
      "0:file:README.md",
    ]);
  });

  test("keeps an absolute root marker on the first directory row", () => {
    const entries = buildTreeSidebarEntries([src("/etc/hosts")]);
    expect(entries.map((e) => (e.kind === "directory" ? e.label : e.kind))).toEqual(["/", "etc/", "file"]);
  });

  test("carries path and change type onto file entries", () => {
    const entries = buildTreeSidebarEntries([src("a.ts", { changeType: "new", isUntracked: true })]);
    const entry = entries[0];
    expect(entry?.kind === "file" && entry.path).toBe("a.ts");
    expect(entry?.kind === "file" && entry.changeType).toBe("new");
    expect(entry?.kind === "file" && entry.isUntracked).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/sidebar`
Expected: FAIL, cannot find modules.

- [ ] **Step 3: Implement text helpers**

`src/sidebar/text.ts`:

```ts
/**
 * Small terminal text helpers, simplified from hunk's `src/lib/terminalText.ts` and
 * `src/ui/lib/text.ts` (MIT, Modem Labs Inc.). Width is measured in code points, which is
 * exact for ASCII and single-width scripts and close enough for a file list.
 */

/** Escape backslashes and control characters so a path cannot move the cursor. */
export function formatTerminalPath(path: string): string {
  let formatted = "";
  for (const character of path) {
    const codePoint = character.codePointAt(0)!;
    if (character === "\\") formatted += "\\\\";
    else if (character === "\t") formatted += "\\t";
    else if (character === "\n") formatted += "\\n";
    else if (character === "\r") formatted += "\\r";
    else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      formatted += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else formatted += character;
  }
  return formatted;
}

/** Count code points. */
export function textWidth(text: string): number {
  return Array.from(text).length;
}

/** Truncate text to `width` code points, ending with the overflow marker when cut. */
export function fitText(text: string, width: number, overflowMarker = "."): string {
  if (width <= 0) return "";
  const characters = Array.from(text);
  if (characters.length <= width) return text;
  const marker = Array.from(overflowMarker).slice(0, width);
  return `${characters.slice(0, width - marker.length).join("")}${marker.join("")}`;
}

/** Fit, then right-pad with spaces to exactly `width`. */
export function padText(text: string, width: number): string {
  const trimmed = fitText(text, width);
  return `${trimmed}${" ".repeat(Math.max(0, width - textWidth(trimmed)))}`;
}
```

- [ ] **Step 4: Implement entry builders**

`src/sidebar/entries.ts`:

```ts
/**
 * Build the row model for the files pane. Ported from hunk's `src/ui/lib/files.ts`
 * (MIT, Modem Labs Inc.) with `path` added to file entries so viewed marks can be looked up.
 */
import { basename, dirname } from "node:path/posix";
import { formatTerminalPath } from "./text";

export type SidebarChangeType = "change" | "rename-pure" | "rename-changed" | "new" | "deleted";

/** The slice of one reviewed file the builders need. `ExtensionDiffFile` satisfies it. */
export interface SidebarFileSource {
  id: string;
  path: string;
  previousPath?: string;
  stats: { additions: number; deletions: number };
  statsTruncated?: boolean;
  isUntracked?: boolean;
  agent?: { annotations: readonly unknown[] } | null;
  changeType?: SidebarChangeType;
}

export interface FileListEntry {
  kind: "file";
  id: string;
  /** Raw file path, the key viewed marks are stored under. */
  path: string;
  name: string;
  depth: number;
  agentCommentsText: string | null;
  additionsText: string | null;
  deletionsText: string | null;
  changeType: SidebarChangeType | undefined;
  isUntracked: boolean;
}

export interface FileGroupEntry {
  kind: "group";
  id: string;
  label: string;
}

export interface FileDirectoryEntry {
  kind: "directory";
  id: string;
  label: string;
  depth: number;
}

export type FileSidebarMode = "flat" | "tree";
export type SidebarEntry = FileListEntry | FileGroupEntry | FileDirectoryEntry;

export const TREE_FILE_SIDEBAR_MIN_CONTENT_WIDTH = 32;

/** Choose the compact or hierarchical projection for an available content width. */
export function resolveFileSidebarMode(contentWidth: number): FileSidebarMode {
  return contentWidth >= TREE_FILE_SIDEBAR_MIN_CONTENT_WIDTH ? "tree" : "flat";
}

/** Strip parser-added line endings from a diff path. */
function normalizeDiffPath(path: string): string {
  return path.replace(/[\r\n]+$/u, "");
}

/** Build the filename-first label for one row; renames show `old -> new` when the names differ. */
function sidebarFileName(file: SidebarFileSource): string {
  const path = formatTerminalPath(normalizeDiffPath(file.path));
  const previousPath = file.previousPath ? formatTerminalPath(normalizeDiffPath(file.previousPath)) : undefined;
  if (!previousPath || previousPath === path) return basename(path);
  const previousName = basename(previousPath);
  const nextName = basename(path);
  return previousName === nextName ? nextName : `${previousName} -> ${nextName}`;
}

/** Hide zero-value stats so rows only show real line deltas. */
function formatSidebarStat(prefix: "+" | "-", value: number, truncated = false): string | null {
  return value > 0 ? `${prefix}${value}${truncated ? "+" : ""}` : null;
}

/** Return the visible stat badges for one row, agent notes first. */
export function sidebarEntryStats(
  entry: Pick<FileListEntry, "agentCommentsText" | "additionsText" | "deletionsText">,
): Array<{ kind: "agent-comment" | "addition" | "deletion"; text: string }> {
  const stats: Array<{ kind: "agent-comment" | "addition" | "deletion"; text: string }> = [];
  if (entry.agentCommentsText) stats.push({ kind: "agent-comment", text: entry.agentCommentsText });
  if (entry.additionsText) stats.push({ kind: "addition", text: entry.additionsText });
  if (entry.deletionsText) stats.push({ kind: "deletion", text: entry.deletionsText });
  return stats;
}

/** Measure the rendered stats width including the spaces between badges. */
export function sidebarEntryStatsWidth(
  entry: Pick<FileListEntry, "agentCommentsText" | "additionsText" | "deletionsText">,
): number {
  return sidebarEntryStats(entry).reduce((width, stat, index) => width + stat.text.length + (index > 0 ? 1 : 0), 0);
}

/** Build the shared file-row entry used by both projections. */
function buildSidebarFileEntry(file: SidebarFileSource, depth: number): FileListEntry {
  const agentCommentCount = file.agent?.annotations.length ?? 0;
  return {
    kind: "file",
    id: file.id,
    path: file.path,
    name: sidebarFileName(file),
    depth,
    agentCommentsText: agentCommentCount > 0 ? `*${agentCommentCount}` : null,
    additionsText: formatSidebarStat("+", file.stats.additions, file.statsTruncated),
    deletionsText: formatSidebarStat("-", file.stats.deletions),
    changeType: file.changeType,
    isUntracked: file.isUntracked ?? false,
  };
}

/** Build compact grouped entries while preserving review order. */
export function buildFlatSidebarEntries(files: readonly SidebarFileSource[]): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  let activeGroup: string | undefined;
  files.forEach((file, index) => {
    const path = formatTerminalPath(normalizeDiffPath(file.path));
    const group = dirname(path);
    if (group !== activeGroup) {
      activeGroup = group;
      entries.push({ kind: "group", id: `group:${group}:${index}`, label: group === "." ? "./" : `${group}/` });
    }
    entries.push(buildSidebarFileEntry(file, 0));
  });
  return entries;
}

/** Split a POSIX path's parent into segments, keeping an absolute root marker as the first one. */
function sidebarDirectorySegments(parent: string): string[] {
  if (parent === ".") return [];
  const root = parent.match(/^\/+/u)?.[0];
  const segments = parent.split("/").filter(Boolean);
  return root ? [root, ...segments] : segments;
}

/** Format one directory segment without doubling a root marker. */
function sidebarDirectoryLabel(segment: string): string {
  return segment.startsWith("/") ? segment : `${segment}/`;
}

/** Join segments into the stable path one directory row represents. */
function sidebarDirectoryPath(segments: readonly string[]): string {
  const [root, ...rest] = segments;
  return root?.startsWith("/") ? `${root}${rest.join("/")}` : segments.join("/");
}

/** Count leading segments two branches share. */
function sharedDirectoryDepth(previous: readonly string[], next: readonly string[]): number {
  const maxDepth = Math.min(previous.length, next.length);
  let depth = 0;
  while (depth < maxDepth && previous[depth] === next[depth]) depth += 1;
  return depth;
}

/** Build an always-expanded hierarchy without regrouping files away from review order. */
export function buildTreeSidebarEntries(files: readonly SidebarFileSource[]): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  let activeDirectories: string[] = [];
  files.forEach((file, fileIndex) => {
    const path = formatTerminalPath(normalizeDiffPath(file.path));
    const directories = sidebarDirectorySegments(dirname(path));
    const sharedDepth = sharedDirectoryDepth(activeDirectories, directories);
    for (let depth = sharedDepth; depth < directories.length; depth += 1) {
      const segment = directories[depth]!;
      const directoryPath = sidebarDirectoryPath(directories.slice(0, depth + 1));
      entries.push({
        kind: "directory",
        id: `directory:${fileIndex}:${depth}:${directoryPath}`,
        label: sidebarDirectoryLabel(segment),
        depth,
      });
    }
    entries.push(buildSidebarFileEntry(file, directories.length));
    activeDirectories = directories;
  });
  return entries;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun test src/sidebar && bun run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd ~/work/hunk-viewed && git add src/sidebar && git commit -m "feat: port the sidebar entry builders and text helpers"
```

---

### Task 7: Pane rows and the files pane component

**Files:**
- Create: `src/sidebar/rows.tsx`, `src/sidebar/FilesPane.tsx`

**Interfaces:**
- Consumes: entries and text helpers (Task 6), `useViewedState`/`isViewed` (Task 4), `useReviewMirror` (Task 5), `ExtensionPaneProps`, `ExtensionPaneTheme` from `hunkdiff/extension`.
- Produces:
  - `FileRow({ entry, viewed, selected, statsWidth, textWidth, paddingLeft?, theme, onSelectFile })`
  - `DirectoryRow({ entry, statsWidth?, textWidth, paddingLeft?, theme })`
  - `GroupHeader({ entry, textWidth, paddingLeft?, theme })`
  - `fileRowId(fileId: string): string` — `file-row:<id>`, the element id used for scroll-into-view.
  - `FilesPane(props: ExtensionPaneProps): ReactNode` — the component registered with `replaces: "hunk:files"`.

No unit tests: these render OpenTUI elements. Verification is `tsc` plus the manual TTY run in Task 8.

- [ ] **Step 1: Write the rows**

`src/sidebar/rows.tsx`:

```tsx
/**
 * Row components for the files pane. Adapted from hunk's
 * `src/ui/components/panes/FileListItem.tsx` (MIT, Modem Labs Inc.) with a viewed mark column.
 */
import { memo } from "react";
import type { ExtensionPaneTheme } from "hunkdiff/extension";
import { fitText, padText } from "./text";
import { sidebarEntryStats, type FileDirectoryEntry, type FileGroupEntry, type FileListEntry } from "./entries";

/** Build the element id the pane scrolls into view for one file. */
export function fileRowId(fileId: string): string {
  return `file-row:${fileId}`;
}

/** Return the git-style status glyph and its color. */
function fileStateIcon(entry: FileListEntry, theme: ExtensionPaneTheme): { icon: string; color: string } {
  if (entry.isUntracked) return { icon: "?", color: theme.fileUntracked };
  switch (entry.changeType) {
    case "new":
      return { icon: "A", color: theme.fileNew };
    case "deleted":
      return { icon: "D", color: theme.fileDeleted };
    case "rename-pure":
    case "rename-changed":
      return { icon: "R", color: theme.fileRenamed };
    case "change":
    case undefined:
      return { icon: "M", color: theme.fileModified };
  }
}

/** Clamp indentation so a row always keeps room for its label. */
function indentWidth(depth: number, textWidth: number, reservedWidth: number): number {
  return Math.min(Math.max(0, depth) * 2, Math.max(0, textWidth - reservedWidth - 1));
}

/** Render one directory-group header in flat mode. */
export function GroupHeader({
  entry,
  paddingLeft = 1,
  textWidth,
  theme,
}: {
  entry: FileGroupEntry;
  paddingLeft?: number;
  textWidth: number;
  theme: ExtensionPaneTheme;
}) {
  return (
    <box style={{ width: "100%", height: 1, paddingLeft, backgroundColor: theme.panel }}>
      <text fg={theme.muted}>{fitText(entry.label, Math.max(1, textWidth))}</text>
    </box>
  );
}

/** Render one always-expanded directory row in tree mode. */
export function DirectoryRow({
  entry,
  paddingLeft = 1,
  statsWidth = 0,
  textWidth,
  theme,
}: {
  entry: FileDirectoryEntry;
  paddingLeft?: number;
  statsWidth?: number;
  textWidth: number;
  theme: ExtensionPaneTheme;
}) {
  const statsSectionWidth = statsWidth > 0 ? statsWidth + 1 : 0;
  const indent = indentWidth(entry.depth, textWidth, statsSectionWidth + 1);
  const labelWidth = Math.max(1, textWidth - 1 - statsSectionWidth - indent);
  return (
    <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
      <box style={{ width: 1, height: 1, backgroundColor: theme.panel }} />
      <box style={{ flexGrow: 1, height: 1, paddingLeft: paddingLeft + indent, flexDirection: "row", backgroundColor: theme.panel }}>
        <text fg={theme.muted}>{fitText(entry.label, labelWidth)}</text>
      </box>
    </box>
  );
}

/** Width of the viewed-mark column: the glyph plus one space. */
const MARK_WIDTH = 2;

/** Render one file row: selection stripe, viewed mark, status glyph, name, stats. */
export const FileRow = memo(function FileRow({
  entry,
  viewed,
  paddingLeft = 1,
  selected,
  statsWidth,
  textWidth,
  theme,
  onSelectFile,
}: {
  entry: FileListEntry;
  viewed: boolean;
  paddingLeft?: number;
  selected: boolean;
  statsWidth: number;
  textWidth: number;
  theme: ExtensionPaneTheme;
  onSelectFile: (fileId: string) => void;
}) {
  const rowBackground = selected ? theme.panelAlt : theme.panel;
  const stats = sidebarEntryStats(entry);
  const { icon, color } = fileStateIcon(entry, theme);
  const iconWidth = 2;
  const statsSectionWidth = statsWidth > 0 ? statsWidth + 1 : 0;
  const indent = indentWidth(entry.depth, textWidth, MARK_WIDTH + iconWidth + statsSectionWidth + 1);
  const nameWidth = Math.max(1, textWidth - 1 - MARK_WIDTH - iconWidth - statsSectionWidth - indent);
  const textColor = viewed ? theme.muted : theme.text;

  return (
    <box
      id={fileRowId(entry.id)}
      style={{ width: "100%", height: 1, backgroundColor: rowBackground, flexDirection: "row" }}
      onMouseUp={() => onSelectFile(entry.id)}
    >
      <box style={{ width: 1, height: 1, backgroundColor: selected ? theme.accent : rowBackground }} />
      <box style={{ flexGrow: 1, height: 1, paddingLeft: paddingLeft + indent, flexDirection: "row", backgroundColor: rowBackground }}>
        <text fg={theme.accentMuted}>{viewed ? "✓ " : "  "}</text>
        <text fg={viewed ? theme.muted : color}>{icon} </text>
        <text fg={textColor}>{padText(fitText(entry.name, nameWidth, "…"), nameWidth)}</text>
        {statsSectionWidth > 0 && (
          <box style={{ width: statsSectionWidth, height: 1, flexDirection: "row", justifyContent: "flex-end", backgroundColor: rowBackground }}>
            {stats.map((stat, index) => (
              <box key={`${entry.id}:${stat.kind}`} style={{ height: 1, flexDirection: "row", backgroundColor: rowBackground }}>
                {index > 0 && <text fg={theme.muted}> </text>}
                <text
                  fg={
                    viewed
                      ? theme.muted
                      : stat.kind === "agent-comment"
                        ? theme.noteBorder
                        : stat.kind === "addition"
                          ? theme.badgeAdded
                          : theme.badgeRemoved
                  }
                >
                  {stat.text}
                </text>
              </box>
            ))}
          </box>
        )}
      </box>
    </box>
  );
});
```

- [ ] **Step 2: Write the pane**

`src/sidebar/FilesPane.tsx`:

```tsx
/**
 * Replacement files pane: a title row with viewed progress, then the tree or flat file list
 * with viewed marks. Files and selection come from the host props; marks and the mode flag
 * come from the extension stores. Adapted from hunk's bundled sidebar (MIT, Modem Labs Inc.)
 * without row windowing.
 */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { ExtensionPaneProps } from "hunkdiff/extension";
import { useReviewMirror } from "../reviewMirror";
import { isViewed, useViewedState } from "../viewedStore";
import { buildFlatSidebarEntries, buildTreeSidebarEntries, resolveFileSidebarMode, sidebarEntryStatsWidth } from "./entries";
import { DirectoryRow, FileRow, GroupHeader, fileRowId } from "./rows";
import { padText } from "./text";

/** Render the hunk-viewed files pane. */
export function FilesPane({ files, selectedFileId, theme, width, actions }: ExtensionPaneProps): ReactNode {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const viewed = useViewedState();
  const { filesModeActive } = useReviewMirror();
  // One column of selection stripe plus one of row padding, as in the bundled pane.
  const textWidth = Math.max(8, width - 2);
  const mode = resolveFileSidebarMode(textWidth);
  const paddingLeft = mode === "tree" ? 0 : 1;

  const entries = useMemo(
    () => (mode === "tree" ? buildTreeSidebarEntries(files) : buildFlatSidebarEntries(files)),
    [files, mode],
  );
  const viewedByFileId = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const file of files) map.set(file.id, isViewed(viewed, file));
    return map;
  }, [files, viewed]);
  const viewedCount = useMemo(() => [...viewedByFileId.values()].filter(Boolean).length, [viewedByFileId]);
  const statsWidth = Math.max(0, ...entries.map((entry) => (entry.kind === "file" ? sidebarEntryStatsWidth(entry) : 0)));

  useEffect(() => {
    if (!selectedFileId) return;
    scrollRef.current?.scrollChildIntoView(fileRowId(selectedFileId));
  }, [files, mode, selectedFileId]);

  const title = padText(` Files  ${viewedCount}/${files.length} viewed`, Math.max(1, width));

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
      <box style={{ width: "100%", height: 1, backgroundColor: theme.panel }}>
        <text fg={filesModeActive ? theme.accent : theme.muted}>{title}</text>
      </box>
      <scrollbox
        ref={scrollRef}
        width="100%"
        flexGrow={1}
        focused={false}
        scrollY={true}
        viewportCulling={true}
        rootOptions={{ backgroundColor: theme.panel }}
        wrapperOptions={{ backgroundColor: theme.panel }}
        viewportOptions={{ backgroundColor: theme.panel }}
        contentOptions={{ backgroundColor: theme.panel }}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <box style={{ width: "100%", flexDirection: "column" }}>
          {entries.map((entry) => {
            if (entry.kind === "group") {
              return <GroupHeader key={entry.id} entry={entry} paddingLeft={paddingLeft} textWidth={textWidth} theme={theme} />;
            }
            if (entry.kind === "directory") {
              return (
                <DirectoryRow key={entry.id} entry={entry} paddingLeft={paddingLeft} statsWidth={statsWidth} textWidth={textWidth} theme={theme} />
              );
            }
            return (
              <FileRow
                key={entry.id}
                entry={entry}
                viewed={viewedByFileId.get(entry.id) ?? false}
                paddingLeft={paddingLeft}
                selected={entry.id === selectedFileId}
                statsWidth={statsWidth}
                textWidth={textWidth}
                theme={theme}
                onSelectFile={actions.selectFile}
              />
            );
          })}
        </box>
      </scrollbox>
    </box>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun run typecheck`
Expected: clean. If `<scrollbox>` rejects `flexGrow` as a direct prop, move it into `style={{ flexGrow: 1 }}`; if it rejects `width="100%"`, use `style={{ width: "100%" }}`. Check `node_modules/@opentui/react` types for the accepted prop shape rather than guessing twice.

- [ ] **Step 4: Commit**

```bash
cd ~/work/hunk-viewed && git add src/sidebar/rows.tsx src/sidebar/FilesPane.tsx && git commit -m "feat: render the files pane with viewed marks"
```

---

### Task 8: Wire the extension and verify in a real TTY

**Files:**
- Modify: `index.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: registered pane `hunk-viewed:files` replacing `hunk:files`; commands `hunk-viewed.toggleViewed` (`v`), `hunk-viewed.nextUnviewed` (`J`), `hunk-viewed.previousUnviewed` (`K`), `hunk-viewed.filesMode` (`F`), `hunk-viewed.clearRepo` (no key); keyboard mode `hunk-viewed:files`.

- [ ] **Step 1: Write the factory**

`index.tsx`:

```tsx
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
import type { ExtensionDiffFile, ExtensionKeyEvent, HunkExtensionAPI } from "hunkdiff/extension";
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

  /** Load this repo's marks once, keyed by the canonical cwd. */
  function ensureRepoLoaded(cwd: string, notify: (message: string, type: "warning") => void) {
    if (getViewedState().repoKey !== null) return;
    let repoKey: string;
    try {
      repoKey = realpathSync(cwd);
    } catch {
      repoKey = cwd;
    }
    loadRepo(repoKey, readRepoFiles(stateFilePath, repoKey, hunk.log));
    setPersist((key, files) => {
      try {
        writeRepoFiles(stateFilePath, key, files, new Date());
      } catch (error) {
        notify(`hunk-viewed: could not save ${stateFilePath}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    });
  }

  const isViewedFile = (file: ExtensionDiffFile) => isViewed(getViewedState(), file);

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
    const next = findUnviewedNeighbor(visibleFiles(getReviewMirror()), file.id, 1, isViewedFile);
    if (next) ctx.navigation.selectFile(next.id);
    else ctx.notify("All files viewed", "info");
  });

  hunk.registerCommand({ id: "nextUnviewed", title: "Next unviewed file", key: "J" }, (ctx) => {
    const next = findUnviewedNeighbor(visibleFiles(getReviewMirror()), ctx.selection.file?.id ?? null, 1, isViewedFile);
    if (next) ctx.navigation.selectFile(next.id);
    else ctx.notify("No unviewed file after this one", "info");
  });

  hunk.registerCommand({ id: "previousUnviewed", title: "Previous unviewed file", key: "K" }, (ctx) => {
    const previous = findUnviewedNeighbor(visibleFiles(getReviewMirror()), ctx.selection.file?.id ?? null, -1, isViewedFile);
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
```

- [ ] **Step 2: Typecheck and run all tests**

Run: `export PATH="$HOME/.bun/bin:$PATH"; cd ~/work/hunk-viewed && bun run typecheck && bun test`
Expected: clean and all pass. If `hunk.on("startup", ...)` handler's second argument type differs, follow the `ExtensionEventHandler` signature in `node_modules/hunkdiff/dist/npm/extension/extension-api/types.d.ts`.

- [ ] **Step 3: Manual TTY verification (ask the user to run it)**

Give the user this command and checklist. Do not run the TUI from the agent.

```bash
cd ~/work/hunk && hunk diff --extension ~/work/hunk-viewed HEAD~3
```

Checklist:
1. The left pane shows ` Files  0/N viewed` and the tree file list.
2. `v` marks the selected file: `✓`, greyed row, counter increments, selection jumps to the next unviewed file.
3. `v` on a viewed file clears the mark and stays.
4. `J` / `K` skip viewed files and show a notice at the ends.
5. `F` shows the mode badge and the title row turns accent; `j`/`k`/arrows move between files; `Enter` or `Esc` leaves.
6. Quit, rerun the same command: marks are still there. `cat ~/.local/state/hunk/viewed.json` shows the repo record.
7. Change one marked file in the working tree and rerun: its mark is gone, the others remain.
8. Narrow the terminal below about 36 columns of pane width: the list switches to flat groups.

- [ ] **Step 4: Fix anything the checklist finds, then commit**

```bash
cd ~/work/hunk-viewed && git add index.tsx && git commit -m "feat: register the viewed pane, commands, and files mode"
```

---

### Task 9: README and install

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

`README.md`:

````markdown
# hunk-viewed

GitLab-style "viewed" marks for [hunk](https://hunk.dev). Mark a file as viewed, see the check
mark in the files pane, skip viewed files while you review, and keep the marks between runs.

## Install

```bash
hunk extension install ~/work/hunk-viewed
# or, while developing:
hunk diff --extension ~/work/hunk-viewed
```

Requires hunk 0.21 or newer (extension API 16).

## Keys

| Key   | Action                                                                    |
| ----- | ------------------------------------------------------------------------- |
| `v`   | Mark the selected file viewed and jump to the next unviewed file. On a viewed file: clear the mark. |
| `J`   | Next unviewed file                                                        |
| `K`   | Previous unviewed file                                                    |
| `F`   | Files mode: `j`/`k` and the arrows move between files, `Enter`/`Esc` leave |

**Extensions → Clear viewed marks for this repo** removes every mark for the current repo.

Rebind in `~/.config/hunk/config.toml`:

```toml
[keybindings]
"hunk-viewed.toggleViewed" = "v"
"hunk-viewed.nextUnviewed" = "J"
"hunk-viewed.previousUnviewed" = "K"
"hunk-viewed.filesMode" = "F"
```

## How marks work

- A mark is stored per repo (the canonical working directory hunk runs in) and per file path,
  together with a sha256 of the file's patch. When the patch changes, the file is unviewed again.
- Marks live in `$XDG_STATE_HOME/hunk/viewed.json`, default `~/.local/state/hunk/viewed.json`
  (`%LOCALAPPDATA%\hunk\viewed.json` on Windows). Marks older than 30 days are dropped.
- Viewed files stay in the review stream and in the pane; only `v`, `J`, and `K` skip them.

## Development

```bash
bun install
bun run typecheck
bun test
```

## License

MIT. The files pane is adapted from hunk's bundled sidebar, © Modem Labs Inc., MIT.
````

- [ ] **Step 2: Commit**

```bash
cd ~/work/hunk-viewed && git add README.md && git commit -m "docs: add README"
```

- [ ] **Step 3: Install permanently (ask the user first)**

Run: `hunk extension install ~/work/hunk-viewed`
Expected: hunk reports the install; `hunk extension list` shows `hunk-viewed`. If the user prefers a symlink instead: `ln -s ~/work/hunk-viewed ~/.config/hunk/extensions/hunk-viewed`.

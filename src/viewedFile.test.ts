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

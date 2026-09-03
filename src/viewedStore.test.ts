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

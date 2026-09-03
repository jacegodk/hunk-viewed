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

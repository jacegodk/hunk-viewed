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
export function normalizeDiffPath(path: string): string {
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

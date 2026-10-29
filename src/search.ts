import { useSyncExternalStore } from "react";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import { isNewLineInHunk, parseUnifiedPatch } from "./unifiedPatch";

/** One case-insensitive match of the active query, located on one side of one file. */
export interface SearchHit {
  fileId: string;
  filePath: string;
  side: "old" | "new";
  line: number;
  range: readonly [number, number];
  /**
   * True when the match sits in an unchanged region no hunk renders (found by scanning the
   * whole document, not the patch). Hunk's `revealLine` refuses such lines, so navigating to
   * one needs the full-file view's pinned-extent jump instead.
   */
  outside?: boolean;
}

/** Content-search state: the active query, its merged hits, the current pick, and the prompt. */
export interface SearchState {
  /** Empty string means no search is active. */
  query: string;
  /** Merged hits across visible files, in review order then line then column. */
  hits: readonly SearchHit[];
  /** Index into `hits` of the current pick; -1 when there are none. */
  currentIndex: number;
  prompt: { open: boolean; draft: string };
  /** Ids of files currently showing the full-file view, toggled by the `F` command. */
  fullViewFileIds: ReadonlySet<string>;
}

const initialState: SearchState = {
  query: "",
  hits: [],
  currentIndex: -1,
  prompt: { open: false, draft: "" },
  fullViewFileIds: new Set(),
};

let state: SearchState = initialState;
const listeners = new Set<() => void>();
/** Hits reported by the full-file view's layout pass, one entry per file currently showing it. */
let documentHits = new Map<string, readonly SearchHit[]>();
/**
 * Out-of-diff hits per file, reported by the background document scan. A file showing the
 * full-file view reports its whole-document hits through `documentHits` instead, so its entry
 * here is ignored by `rebuildHits` but kept for identity (the scan does not re-run per toggle).
 */
let gapHits = new Map<string, { query: string; hits: readonly SearchHit[] }>();

function publish(patch: Partial<SearchState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/** Return the current immutable snapshot. */
export function getSearchState(): SearchState {
  return state;
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeSearch(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the snapshot from a React component. */
export function useSearchState(): SearchState {
  return useSyncExternalStore(subscribeSearch, getSearchState);
}

/**
 * Find every case-insensitive, non-overlapping occurrence of `query` in `text`.
 * Returns `[start, end)` UTF-16 offsets; an empty query yields no hits.
 */
export function findLineHits(text: string, query: string): Array<readonly [number, number]> {
  if (query === "") return [];
  const hits: Array<readonly [number, number]> = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let searchFrom = 0;
  while (true) {
    const index = lowerText.indexOf(lowerQuery, searchFrom);
    if (index === -1) break;
    hits.push([index, index + lowerQuery.length]);
    searchFrom = index + lowerQuery.length;
  }
  return hits;
}

/** One exact source location a hit or a mark can address. */
export interface HitLocation {
  side: "old" | "new";
  line: number;
  range: readonly [number, number];
}

/** Whether two locations address the same side, line, and character range. */
export function sameHitLocation(a: HitLocation, b: HitLocation): boolean {
  return a.side === b.side && a.line === b.line && a.range[0] === b.range[0] && a.range[1] === b.range[1];
}

/**
 * Two hits are the same pick target when path and location both match.
 * Compares `filePath` rather than `fileId`: hunk renumbers file ids on reload, so an id-based
 * compare would lose the pinned hit across every reload even though the same line still matches.
 */
export function sameHit(a: SearchHit, b: SearchHit): boolean {
  return a.filePath === b.filePath && sameHitLocation(a, b);
}

/**
 * Scan one file's unified patch for `query`. Context and added lines attribute to the new side,
 * removed lines to the old side, tracking `oldLine`/`newLine` per hunk exactly as
 * `buildFullFileLayout` does (a pure-insertion hunk's new side starts at `newStart + 1`).
 * Empty query yields no hits.
 */
export function scanPatchHits(file: Pick<ExtensionDiffFile, "id" | "path" | "patch">, query: string): SearchHit[] {
  if (query === "") return [];
  const hits: SearchHit[] = [];
  for (const hunk of parseUnifiedPatch(file.patch)) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === "removed") {
        for (const range of findLineHits(line.text, query)) {
          hits.push({ fileId: file.id, filePath: file.path, side: "old", line: oldLine, range });
        }
        oldLine += 1;
        continue;
      }
      for (const range of findLineHits(line.text, query)) {
        hits.push({ fileId: file.id, filePath: file.path, side: "new", line: newLine, range });
      }
      newLine += 1;
      if (line.kind === "context") oldLine += 1;
    }
  }
  return hits;
}

/** Scan every line of a full-view file's new-side document for `query`. Empty query yields no hits. */
export function scanDocumentHits(file: Pick<ExtensionDiffFile, "id" | "path">, document: string, query: string): SearchHit[] {
  if (query === "") return [];
  const hits: SearchHit[] = [];
  const lines = document.replaceAll("\r\n", "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  lines.forEach((text, index) => {
    for (const range of findLineHits(text, query)) {
      hits.push({ fileId: file.id, filePath: file.path, side: "new", line: index + 1, range });
    }
  });
  return hits;
}

/**
 * Scan a file's whole new-side document for `query`, keeping only matches in unchanged regions
 * no hunk renders — the ones `scanPatchHits` cannot see. These are the hits that need the
 * full-file view's pinned-extent jump; in-diff matches stay patch hits. Empty query yields no
 * hits, and a document that disagrees with the patch's new-side span (a stale read against a
 * reloaded review) yields none rather than mislocated ones.
 */
export function scanGapHits(file: Pick<ExtensionDiffFile, "id" | "path" | "patch">, document: string, query: string): SearchHit[] {
  if (query === "") return [];
  const hunks = parseUnifiedPatch(file.patch);
  const hits: SearchHit[] = [];
  const lines = document.replaceAll("\r\n", "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  // A stale read (the review reloaded mid-scan) can disagree with the patch's new-side span;
  // gap hits would then carry wrong line numbers, so yield none rather than mislocated ones.
  const spanEnd = Math.max(0, ...hunks.map((hunk) => hunk.newStart + Math.max(hunk.newCount, 0) - 1));
  if (spanEnd > lines.length) return [];
  lines.forEach((text, index) => {
    const line = index + 1;
    if (isNewLineInHunk(hunks, line)) return;
    for (const range of findLineHits(text, query)) {
      hits.push({ fileId: file.id, filePath: file.path, side: "new", line, range, outside: true });
    }
  });
  return hits;
}

/** Open the prompt with a prefilled draft. */
export function openPrompt(initial: string): void {
  publish({ prompt: { open: true, draft: initial } });
}

/** Replace the prompt's draft text. */
export function editDraft(next: string): void {
  publish({ prompt: { ...state.prompt, draft: next } });
}

/** Close the prompt, keeping its draft. */
export function closePrompt(): void {
  publish({ prompt: { ...state.prompt, open: false } });
}

/**
 * Set the active query, clearing hits and the current index; the caller rebuilds hits next.
 * An empty query is equivalent to `clearSearch`.
 */
export function setQuery(query: string): void {
  if (query === "") {
    clearSearch();
    return;
  }
  publish({ query, hits: [], currentIndex: -1 });
}

/** Whether two hit lists address the same (side, line, range) locations, in the same order. */
function sameHitRanges(a: readonly SearchHit[], b: readonly SearchHit[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((hit, i) => sameHitLocation(hit, b[i]!));
}

/**
 * Store the full-file view's reported hits for one file; the caller rebuilds hits next.
 * Returns whether the stored hits actually changed (by side/line/range), so a caller that only
 * wants to rebuild the merged list when it would actually change (the view's `layout` pass) can
 * skip a redundant rebuild.
 */
export function setDocumentHits(fileId: string, hits: readonly SearchHit[]): boolean {
  const changed = !sameHitRanges(documentHits.get(fileId) ?? [], hits);
  documentHits.set(fileId, hits);
  publish({});
  return changed;
}

/**
 * Store one file's out-of-diff hits for `query`; the caller rebuilds hits next. The query rides
 * along so a re-applied search can skip files already scanned for it, and a stale scan (the
 * query changed mid-read) is ignored by the scanner before it ever calls this.
 */
export function setGapHits(fileId: string, query: string, hits: readonly SearchHit[]): void {
  gapHits.set(fileId, { query, hits });
  publish({});
}

/** Set whether a file shows the full-file view for search-scanning purposes. */
export function setFullViewFile(fileId: string, active: boolean): void {
  const next = new Set(state.fullViewFileIds);
  if (active) next.add(fileId);
  else next.delete(fileId);
  publish({ fullViewFileIds: next });
}

/**
 * Drop full-view membership and reported document hits for files no longer in `ids`, after
 * `changeset_loaded`/`session_reload` replace the file list wholesale (hunk renumbers ids on
 * every reload, so anything keyed by a prior generation's id is otherwise a permanent leak).
 */
export function pruneSearchFiles(ids: Iterable<string>): void {
  const keep = new Set(ids);
  for (const id of documentHits.keys()) {
    if (!keep.has(id)) documentHits.delete(id);
  }
  for (const id of gapHits.keys()) {
    if (!keep.has(id)) gapHits.delete(id);
  }
  const nextFullView = new Set([...state.fullViewFileIds].filter((id) => keep.has(id)));
  if (nextFullView.size !== state.fullViewFileIds.size) publish({ fullViewFileIds: nextFullView });
}

/** Clamp a raw index into `[0, length - 1]`, or -1 when there is nothing to point at. */
function clampIndex(index: number, length: number): number {
  if (length === 0) return -1;
  return Math.min(Math.max(index, 0), length - 1);
}

/** Options narrowing which visible files `rebuildHits` scans. */
export interface RebuildHitsOptions {
  /** Files to skip entirely — a viewed (folded) file's row shows no marks, so it is not scanned. */
  excludeFileIds?: ReadonlySet<string>;
}

/** Render order of the two sides at one line position: a removed row prints before its replacement. */
function sideRank(side: "old" | "new"): number {
  return side === "old" ? 0 : 1;
}

/** Order one file's merged patch and out-of-diff hits by (line, side, column). */
function mergeFileHits(patchHits: readonly SearchHit[], gapHitsForFile: readonly SearchHit[]): SearchHit[] {
  return [...patchHits, ...gapHitsForFile].sort((a, b) =>
    a.line - b.line || sideRank(a.side) - sideRank(b.side) || a.range[0] - b.range[0],
  );
}

/**
 * Rebuild the merged hit list from the given visible files, in order.
 * Skips any file in `options.excludeFileIds`. Uses reported document hits for files in
 * `fullViewFileIds`, otherwise scans the patch and merges in the file's reported out-of-diff
 * hits. Keeps pointing at the current hit if it still exists in the new list, else clamps the
 * index.
 */
export function rebuildHits(visibleFiles: readonly ExtensionDiffFile[], options?: RebuildHitsOptions): void {
  const pinned = currentHit();
  const nextHits: SearchHit[] = [];
  for (const file of visibleFiles) {
    if (options?.excludeFileIds?.has(file.id)) continue;
    if (state.fullViewFileIds.has(file.id)) nextHits.push(...(documentHits.get(file.id) ?? []));
    else nextHits.push(...mergeFileHits(scanPatchHits(file, state.query), gapHits.get(file.id)?.hits ?? []));
  }
  const pinnedIndex = pinned ? nextHits.findIndex((hit) => sameHit(hit, pinned)) : -1;
  const nextIndex = pinnedIndex !== -1 ? pinnedIndex : clampIndex(state.currentIndex, nextHits.length);
  publish({ hits: nextHits, currentIndex: nextIndex });
}

/** Move the current pick by one hit, wrapping at either end and reporting whether it wrapped. */
export function stepHit(direction: 1 | -1): { hit: SearchHit; wrapped: boolean } | null {
  if (state.hits.length === 0) return null;
  let nextIndex = state.currentIndex + direction;
  let wrapped = false;
  if (nextIndex >= state.hits.length) {
    nextIndex = 0;
    wrapped = true;
  } else if (nextIndex < 0) {
    nextIndex = state.hits.length - 1;
    wrapped = true;
  }
  publish({ currentIndex: nextIndex });
  return { hit: state.hits[nextIndex]!, wrapped };
}

/** The hit at the current index, or null when there are none. */
export function currentHit(): SearchHit | null {
  return state.currentIndex >= 0 ? (state.hits[state.currentIndex] ?? null) : null;
}

/** Point the current pick at `index` (clamped); callers reveal the newly current hit. */
export function pickIndex(index: number): void {
  publish({ currentIndex: clampIndex(index, state.hits.length) });
}

/** Whether `fileId` already has out-of-diff hits stored for `query` (a null read counts as scanned). */
export function hasGapHitsFor(fileId: string, query: string): boolean {
  return gapHits.get(fileId)?.query === query;
}

/** Clear the query, hits, index, prompt, and out-of-diff scan results. Keeps `fullViewFileIds`. */
export function clearSearch(): void {
  gapHits = new Map();
  publish({ query: "", hits: [], currentIndex: -1, prompt: { open: false, draft: "" } });
}

/** Reset module state between tests. */
export function resetSearchForTests(): void {
  state = initialState;
  documentHits = new Map();
  gapHits = new Map();
  listeners.clear();
}

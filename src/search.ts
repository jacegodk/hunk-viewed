import { useSyncExternalStore } from "react";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import { parseUnifiedPatch } from "./unifiedPatch";

/** One case-insensitive match of the active query, located on one side of one file. */
export interface SearchHit {
  fileId: string;
  filePath: string;
  side: "old" | "new";
  line: number;
  range: readonly [number, number];
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

/**
 * Two hits are the same pick target when path, side, line, and range all match.
 * Compares `filePath` rather than `fileId`: hunk renumbers file ids on reload, so an id-based
 * compare would lose the pinned hit across every reload even though the same line still matches.
 */
export function sameHit(a: SearchHit, b: SearchHit): boolean {
  return a.filePath === b.filePath && a.side === b.side && a.line === b.line && a.range[0] === b.range[0] && a.range[1] === b.range[1];
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

/** Store the full-file view's reported hits for one file; the caller rebuilds hits next. */
export function setDocumentHits(fileId: string, hits: readonly SearchHit[]): void {
  documentHits.set(fileId, hits);
  publish({});
}

/** Toggle whether a file shows the full-file view for search-scanning purposes. */
export function toggleFullViewFile(fileId: string): void {
  const next = new Set(state.fullViewFileIds);
  if (next.has(fileId)) next.delete(fileId);
  else next.add(fileId);
  publish({ fullViewFileIds: next });
}

/** Clamp a raw index into `[0, length - 1]`, or -1 when there is nothing to point at. */
function clampIndex(index: number, length: number): number {
  if (length === 0) return -1;
  return Math.min(Math.max(index, 0), length - 1);
}

/**
 * Rebuild the merged hit list from the given visible files, in order.
 * Uses reported document hits for files in `fullViewFileIds`, otherwise scans the patch.
 * Keeps pointing at the current hit if it still exists in the new list, else clamps the index.
 */
export function rebuildHits(visibleFiles: readonly ExtensionDiffFile[]): void {
  const pinned = currentHit();
  const nextHits: SearchHit[] = [];
  for (const file of visibleFiles) {
    if (state.fullViewFileIds.has(file.id)) nextHits.push(...(documentHits.get(file.id) ?? []));
    else nextHits.push(...scanPatchHits(file, state.query));
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

/** Clear the query, hits, index, and prompt. Keeps `fullViewFileIds`. */
export function clearSearch(): void {
  publish({ query: "", hits: [], currentIndex: -1, prompt: { open: false, draft: "" } });
}

/** Reset module state between tests. */
export function resetSearchForTests(): void {
  state = initialState;
  documentHits = new Map();
  listeners.clear();
}

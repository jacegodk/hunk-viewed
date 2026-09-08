# hunk-viewed Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Content search across the review: a bottom-bar prompt, exact-range hit highlighting in hunk's diff rows and in the full-file view, and next/previous navigation across files.

**Architecture:** A pure `src/search.ts` store holds query, hits, current index, prompt draft, and the set of files showing the full view. Hits for diff files come from `parseUnifiedPatch` over `file.patch`; hits for full-view files are reported by the full view's layout pass. `index.tsx` registers a bottom pane (`SearchBar`), a keyboard mode for typing, a line highlighter, and the commands. Commands own every host side effect (`highlights.refresh`, `fileViews.refresh`, `revealLine`); the prompt command awaits a promise the keyboard mode resolves on submit or cancel.

**Tech Stack:** TypeScript, Bun 1.4, React 19 / `@opentui/react`, `hunkdiff@0.21.0` types (API 16).

**Spec:** `docs/superpowers/specs/2026-09-03-hunk-viewed-design.md`, section "Round 5 — 2026-09-08: content search".

## Global Constraints

- Repo `~/work/hunk-viewed`, work on branch `feat/search` from `main`. `bun` is not on PATH: `export PATH="$HOME/.bun/bin:$PATH";` before bun. Use absolute paths or `git -C`.
- New ids: pane `search`, keyboard mode `search-prompt`, line highlighter `search`, commands `search` (keys `["ctrl+f", "f3"]`), `searchNext` (`n`), `searchPrevious` (`["p", "shift+f3", "ctrl+shift+f"]`), `searchEdit` (no key), `searchClear` (no key). `n`, `p`, `ctrl+f`, `f3` are free in hunk's catalog.
- Matching: case-insensitive substring over the line text; every occurrence; ranges are `[start, end)` UTF-16 offsets into the raw line text (what hunk's highlighter expects). Diff lines: context/added → `side: "new"` with the new-side line number; removed → `side: "old"` with the old-side line number.
- Hit order: file order in the visible list, then line number, then column. Wrapping navigation with notices `"Wrapped to the first hit"` / `"Wrapped to the last hit"`; `"No hits"` when the list is empty.
- The store never touches the host; `index.tsx` does all `highlights.refresh("search")`, `fileViews.refresh(FULL_VIEW_ID)`, `panes.open/close("search")`, and `revealLine` calls, always from a command context.
- Keyboard mode contexts have `commands`, `highlights`, `keyboardModes`, `notify`, but no `navigation`, `panes`, or `fileViews`; event contexts have `navigation`, `panes`, `dialogs`, but no `highlights` or `fileViews`. Design around that; do not try to call what a context lacks.
- No runtime dependencies. Short active-voice JSDoc. One commit per task, no `Co-Authored-By`, never amend. Never run the TUI.

---

### Task 1: Search store and pure scanning

**Files:** create `src/search.ts`, `src/search.test.ts`.

**Interfaces (exact):**
```ts
export interface SearchHit { fileId: string; filePath: string; side: "old" | "new"; line: number; range: readonly [number, number]; }
export interface SearchState {
  query: string;                       // "" = no search active
  hits: readonly SearchHit[];          // merged, ordered
  currentIndex: number;                // -1 when no hits
  prompt: { open: boolean; draft: string };
  fullViewFileIds: ReadonlySet<string>;
}
export function getSearchState(): SearchState;
export function subscribeSearch(l: () => void): () => void;
export function useSearchState(): SearchState;
export function findLineHits(text: string, query: string): Array<readonly [number, number]>;  // all occurrences, case-insensitive, non-overlapping
export function scanPatchHits(file: Pick<ExtensionDiffFile, "id" | "path" | "patch">, query: string): SearchHit[];
export function scanDocumentHits(file: Pick<ExtensionDiffFile, "id" | "path">, document: string, query: string): SearchHit[]; // new side, every line
export function openPrompt(initial: string): void;           // prompt.open = true, draft = initial
export function editDraft(next: string): void;
export function closePrompt(): void;
export function setQuery(query: string): void;               // also resets currentIndex to 0 or -1 after rebuild
export function setDocumentHits(fileId: string, hits: readonly SearchHit[]): void;  // reported by the full view
export function toggleFullViewFile(fileId: string): void;    // F pressed on a file
export function rebuildHits(visibleFiles: readonly ExtensionDiffFile[]): void;
  // for each visible file in order: fullViewFileIds.has(id) ? documentHits[id] ?? [] : scanPatchHits(file, query); clamp currentIndex to the same hit if still present (by fileId+side+line+range), else keep the index within bounds, -1 if empty
export function stepHit(direction: 1 | -1): { hit: SearchHit; wrapped: boolean } | null;
export function currentHit(): SearchHit | null;
export function clearSearch(): void;                          // query "", hits [], index -1, prompt closed; keeps fullViewFileIds
export function resetSearchForTests(): void;
```
`scanPatchHits` uses `parseUnifiedPatch`; track `oldLine`/`newLine` per hunk exactly as `buildFullFileLayout` does. Empty query → no hits everywhere.

**Tests** (write first, run to fail, implement, pass): `findLineHits("Foo foo FOO", "foo")` → three ranges; overlapping query `"aa"` in `"aaa"` → one range `[0,2]`; `scanPatchHits` over a two-hunk patch gives correct sides/lines/ranges and file order; `rebuildHits` merges patch and document hits in visible-file order, keeps the current hit across a rebuild when it still exists, clamps otherwise; `stepHit` wraps both ways and reports `wrapped`; `setQuery("")` equals `clearSearch()`; prompt draft ops; `useSearchState` not tested (hook).

Commit: `feat: add the content search store and scanners`.

### Task 2: Bottom search bar pane

**Files:** create `src/sidebar/SearchBar.tsx`; modify `index.tsx` (registration only).

`SearchBar(props: ExtensionPaneProps)`: reads `useSearchState()`. Row text: prompt open → `` `Search: ${draft}▏` `` (accent for the label, text color for the draft); active → `` `Search: ${query}  ${hits.length === 0 ? "no hits" : `${currentIndex + 1}/${hits.length} hits`}  ${currentHit ? basename(currentHit.filePath) + ":" + currentHit.line : ""}` `` in muted with the counter in accent; pad to `width` with `padText`. Background `theme.panel`.

Registration in `index.tsx`:
```ts
hunk.registerPane({ id: "search", title: "Search", placement: "bottom", height: { preferred: 1, min: 1, max: 1 }, component: SearchBar });
```
(closed by default; opened/closed by the commands in Task 3). No tests beyond typecheck.

Commit: `feat: add the bottom search bar pane`.

### Task 3: Prompt mode, highlighter, commands, and event wiring

**Files:** modify `index.tsx`, `index.test.ts`.

1. **Prompt keyboard mode** `search-prompt`, title "Search". Module-level `let promptResolve: ((value: string | null) => void) | null`. `onKey(key)`: `matchesKey("enter", key)` → `promptResolve?.(getSearchState().prompt.draft); promptResolve = null; return "exit"`; `matchesKey("backspace", key)` → `editDraft(draft.slice(0, -1)); return "handled"`; printable: `key.sequence` is exactly one character with code ≥ 0x20 and no `ctrl`/`meta` → `editDraft(draft + key.sequence); return "handled"`; anything else `"handled"` (the prompt owns the keyboard). `onExit`: `closePrompt(); if (promptResolve) { promptResolve(null); promptResolve = null; }` (Esc path).
2. **`runPrompt(ctx, initial)`** helper (async): `openPrompt(initial); ctx.panes.open("search"); ctx.keyboardModes.enterMode("search-prompt"); const value = await new Promise<string | null>((r) => { promptResolve = r; });` then: `null` → if no active query `ctx.panes.close("search")`; return. `""` → `applyClear(ctx)`. Otherwise `applySearch(ctx, value)`.
3. **`applySearch(ctx, query)`**: `setQuery(query); rebuildHits(visibleFiles(getReviewMirror())); ctx.highlights.refresh("search"); ctx.fileViews.refresh(FULL_VIEW_ID); reveal(ctx, currentHit())`; notice `"No hits"` when none. **`applyClear(ctx)`**: `clearSearch(); ctx.highlights.refresh("search"); ctx.fileViews.refresh(FULL_VIEW_ID); ctx.panes.close("search")`. **`reveal(ctx, hit)`**: `ctx.navigation.revealLine(hit.fileId, hit.side, hit.line)`. **`moveHit(ctx, direction)`**: `const step = stepHit(direction)`; none → notice `"No hits"`; else `ctx.highlights.refresh("search"); ctx.fileViews.refresh(FULL_VIEW_ID); reveal(...)`; if `wrapped` notify the wrap message.
4. **Commands**: `search` keys `["ctrl+f","f3"]`: query active → `moveHit(ctx, 1)`; else `runPrompt(ctx, "")`. `searchNext` `n` → `moveHit(ctx, 1)`. `searchPrevious` `["p","shift+f3","ctrl+shift+f"]` → `moveHit(ctx, -1)`. `searchEdit` → `runPrompt(ctx, getSearchState().query)`. `searchClear` → `applyClear(ctx)`.
5. **Line highlighter** `search`: `highlight({ file })` → if no query or `fullViewFileIds.has(file.id)` return `[]`; else `scanPatchHits(file, query).map(h => ({ side: h.side, line: h.line, range: h.range, tone: sameHit(h, currentHit()) ? "current" : "match" }))`.
6. **Full view integration** (`src/fullFileView.ts` gets an optional `hits?: { query: string; current: SearchHit | null }` in options): when a query is set, split each row's text span at the occurrences (`findLineHits`) so matched text becomes `{ text, tone: "accent" }` and the current hit `{ text, tone: "accent", attributes: ["bold"] }`; in split columns apply to both sides. In `index.tsx` the full view's `layout` reads the store, passes `hits`, and after building calls `setDocumentHits(file.id, scanDocumentHits(file, document, query))` (empty array when no query). The `F` command calls `toggleFullViewFile(file.id)` then `rebuildHits(...)`, `highlights.refresh`, `fileViews.refresh`.
7. **Events**: in `changeset_loaded`, `session_reload`, `filter_changed`: after existing work, if a query is active `rebuildHits(visibleFiles(getReviewMirror()))` (no host calls; hunk re-runs highlighters on reload itself). In the `single` mode `onEnter`/`onExit` and in `retarget`, call `rebuildHits` too. Selection is not needed.
8. **Tests** (`index.test.ts`, extend fakes: `registerLineHighlighter` recorder, `panes` with open/close recorders, `highlights.refresh` recorder, `keyboardModes.enterMode` recorder, `navigation.revealLine` recorder): (a) registration of pane/mode/highlighter/commands and keys; (b) prompt flow: run `search` with no query → pane opened, mode entered, prompt open; drive the mode with keys `f`,`o`,`o`, `enter` → the awaited command resolves, query `foo`, hits computed from a 2-file changeset, `highlights.refresh("search")` and `fileViews.refresh("full")` called, `revealLine` called with the first hit; (c) Esc path: `onExit` without enter → resolves null, no query, pane closed; (d) `search` with active query → next hit + reveal; `searchPrevious` wraps with notice; (e) highlighter returns `match`/`current` marks for a file and `[]` for a full-view file; (f) `filter_changed` hiding a file drops its hits and clamps the index.

Commit: `feat: content search with a bottom-bar prompt and hit highlighting`.

### Task 4: Docs and manual checklist

README: keys table rows for `ctrl+f`/`f3`, `n`, `p`/`shift+f3`/`ctrl+shift+f`; menu commands "Edit search" and "Clear search"; rebind block ids; a "Search" paragraph (bottom bar, what is scanned, full-view behavior); limitations (no regex, accent color in full view, collapsed context lands on the hunk, full view via hunk's menu not tracked). Commit: `docs: describe content search`.

Manual TTY checklist (human): `ctrl+f`, type `TODO`, `Enter` → bottom bar shows `Search: TODO  1/N hits file:line`, the first hit is revealed with the matched word highlighted, other hits highlighted lighter; `n`/`p`/`f3`/`shift+f3` move and wrap with a notice; `ctrl+shift+f` moves back; `F` on a file with hits → full view shows accent hits, count changes to include whole-file hits; `/` filter hiding a file lowers the count; `o` single-file mode lowers the count to that file; `Esc` in the prompt cancels; empty `Enter` clears and hides the bar; Extensions → Clear search hides the bar.

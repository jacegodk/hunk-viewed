/**
 * Expand-all: every file the full-file view can show shows it, except files marked viewed.
 * Per session: hunk keys file presentations by runtime file id and drops them on reload, so a
 * reload (and every single-file mode switch) needs the toggle again.
 */
export interface ExpandAllState {
  active: boolean;
  /**
   * Files whose "full" presentation hunk still holds but whose layout must decline so they render
   * raw. Hunk can reset only the selected file to raw, so turning expand-all off collapses every
   * expanded file this way instead; `F` on such a file lifts the decline again.
   */
  collapsedFileIds: ReadonlySet<string>;
}

let state: ExpandAllState = { active: false, collapsedFileIds: new Set() };

/** Return the current immutable snapshot. */
export function getExpandAllState(): ExpandAllState {
  return state;
}

/** Turn expand-all on or off. Turning it on lifts every pending collapse, so re-expanded files lay out again. */
export function setExpandAllActive(active: boolean): void {
  state = { active, collapsedFileIds: active ? new Set() : state.collapsedFileIds };
}

/** Replace the collapsed set with `fileIds`. */
export function collapseFullViews(fileIds: Iterable<string>): void {
  state = { ...state, collapsedFileIds: new Set(fileIds) };
}

/** Lift the collapse of one file, so its full view lays out again. */
export function uncollapseFullView(fileId: string): void {
  if (!state.collapsedFileIds.has(fileId)) return;
  const next = new Set(state.collapsedFileIds);
  next.delete(fileId);
  state = { ...state, collapsedFileIds: next };
}

/** Whether the full view must decline `fileId` and let hunk show the raw diff. */
export function isFullViewCollapsed(fileId: string): boolean {
  return state.collapsedFileIds.has(fileId);
}

/** Forget collapsed files that are no longer in the changeset. */
export function pruneCollapsed(presentFileIds: Iterable<string>): void {
  const present = new Set(presentFileIds);
  collapseFullViews([...state.collapsedFileIds].filter((id) => present.has(id)));
}

/** Reset module state between tests. */
export function resetExpandAllForTests(): void {
  state = { active: false, collapsedFileIds: new Set() };
}

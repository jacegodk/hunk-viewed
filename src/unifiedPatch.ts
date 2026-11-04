export type PatchLineKind = "context" | "added" | "removed";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Parse the hunks of one unified-diff patch. Skips anything before the first `@@` header
 * (git and `diff` file headers), ignores `\ No newline at end of file` markers, and treats a
 * missing count as 1. Returns an empty list when the text holds no hunk.
 */
export function parseUnifiedPatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  const rawLines = patch.replaceAll("\r\n", "\n").split("\n");
  // A trailing empty string from the final newline must not become a context line.
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();
  for (const rawLine of rawLines) {
    const header = HUNK_HEADER.exec(rawLine);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const marker = rawLine[0];
    const text = rawLine.slice(1);
    if (marker === " ") current.lines.push({ kind: "context", text });
    else if (marker === "+") current.lines.push({ kind: "added", text });
    else if (marker === "-") current.lines.push({ kind: "removed", text });
    else if (rawLine === "") current.lines.push({ kind: "context", text: "" });
    // "\ No newline at end of file" and any other marker are ignored.
  }
  return hunks;
}

/**
 * Whether any hunk renders new-side line `line` (context, added, or a numbered position a
 * reveal can address). A pure-deletion hunk (`newCount` 0) renders no new-side line, so the
 * line it names renders as context *before* the hunk's rows.
 */
export function isNewLineInHunk(hunks: readonly PatchHunk[], line: number): boolean {
  return hunks.some((hunk) => hunk.newCount > 0 && hunk.newStart <= line && line < hunk.newStart + hunk.newCount);
}

/**
 * Which hunk's surrounding region contains new-side line `line`: its own hunk when one renders
 * it, else the hunk whose leading gap (start of file, or the unchanged run after the previous
 * hunk) holds it, else the last hunk for the trailing region. Returns null only when there are
 * no hunks. Drives search's reveal of hits outside the diff: hunk's `revealLine` refuses lines
 * no hunk contains, but a presented file view can pin the owning hunk's row extent on the hit's
 * row and land `selectHunk` there.
 */
export function gapOwnerForNewLine(hunks: readonly PatchHunk[], line: number): { index: number; trailing: boolean } | null {
  if (hunks.length === 0) return null;
  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index]!;
    if (hunk.newCount > 0 && hunk.newStart <= line && line < hunk.newStart + hunk.newCount) return { index, trailing: false };
    // A pure-deletion hunk renders no new-side line; the line it names renders before the hunk's
    // rows, so it belongs to this hunk's leading gap.
    const renderStart = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1;
    if (line < renderStart) return { index, trailing: false };
  }
  return { index: hunks.length - 1, trailing: true };
}

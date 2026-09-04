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

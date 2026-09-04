/**
 * Small terminal text helpers, simplified from hunk's `src/lib/terminalText.ts` and
 * `src/ui/lib/text.ts` (MIT, Modem Labs Inc.). Width is measured in terminal display cells, not
 * code points: most characters occupy one cell, but East Asian Wide/Fullwidth script and emoji
 * occupy two, and combining marks and zero-width joiners occupy none, matching how hunk itself
 * measures row width.
 */

/** Escape backslashes and control characters so a path cannot move the cursor. */
export function formatTerminalPath(path: string): string {
  let formatted = "";
  for (const character of path) {
    const codePoint = character.codePointAt(0)!;
    if (character === "\\") formatted += "\\\\";
    else if (character === "\t") formatted += "\\t";
    else if (character === "\n") formatted += "\\n";
    else if (character === "\r") formatted += "\\r";
    else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      formatted += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else formatted += character;
  }
  return formatted;
}

/** East Asian Wide/Fullwidth script and emoji-presentation blocks: two terminal cells each. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** Combining marks and zero-width joiners/selectors: zero terminal cells, drawn over the prior character. */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x200b, 0x200d],
  [0xfe0f, 0xfe0f],
];

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/** Terminal cell width of one code point: 0, 1, or 2. */
function cellWidth(codePoint: number): number {
  if (inRanges(codePoint, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

/** Count display cells (double for East Asian Wide/Fullwidth and emoji, zero for combining marks). */
export function textWidth(text: string): number {
  let width = 0;
  for (const character of text) width += cellWidth(character.codePointAt(0)!);
  return width;
}

/** Truncate text to `width` display cells, ending with the overflow marker when cut. */
export function fitText(text: string, width: number, overflowMarker = "."): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  // The marker itself is trimmed first, cell by cell, so an extremely narrow width still gets a
  // (possibly partial) marker instead of overflowing it.
  let marker = "";
  let markerWidth = 0;
  for (const character of overflowMarker) {
    const w = cellWidth(character.codePointAt(0)!);
    if (markerWidth + w > width) break;
    marker += character;
    markerWidth += w;
  }
  let kept = "";
  let usedWidth = 0;
  const budget = width - markerWidth;
  for (const character of text) {
    const w = cellWidth(character.codePointAt(0)!);
    if (usedWidth + w > budget) break;
    kept += character;
    usedWidth += w;
  }
  return `${kept}${marker}`;
}

/** Fit, then right-pad with spaces to exactly `width` display cells. */
export function padText(text: string, width: number): string {
  const trimmed = fitText(text, width);
  return `${trimmed}${" ".repeat(Math.max(0, width - textWidth(trimmed)))}`;
}

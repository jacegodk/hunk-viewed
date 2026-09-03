/**
 * Small terminal text helpers, simplified from hunk's `src/lib/terminalText.ts` and
 * `src/ui/lib/text.ts` (MIT, Modem Labs Inc.). Width is measured in code points, which is
 * exact for ASCII and single-width scripts and close enough for a file list.
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

/** Count code points. */
export function textWidth(text: string): number {
  return Array.from(text).length;
}

/** Truncate text to `width` code points, ending with the overflow marker when cut. */
export function fitText(text: string, width: number, overflowMarker = "."): string {
  if (width <= 0) return "";
  const characters = Array.from(text);
  if (characters.length <= width) return text;
  const marker = Array.from(overflowMarker).slice(0, width);
  return `${characters.slice(0, width - marker.length).join("")}${marker.join("")}`;
}

/** Fit, then right-pad with spaces to exactly `width`. */
export function padText(text: string, width: number): string {
  const trimmed = fitText(text, width);
  return `${trimmed}${" ".repeat(Math.max(0, width - textWidth(trimmed)))}`;
}

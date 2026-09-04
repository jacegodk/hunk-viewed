import { describe, expect, test } from "bun:test";
import { fitText, formatTerminalPath, padText, textWidth } from "./text";

describe("formatTerminalPath", () => {
  test("escapes controls and backslashes", () => {
    expect(formatTerminalPath("a\\b\tc\nd\re\x1b")).toBe("a\\\\b\\tc\\nd\\re\\x1b");
    expect(formatTerminalPath("src/ø.ts")).toBe("src/ø.ts");
  });
});

describe("fitText / padText", () => {
  test("returns text that fits unchanged", () => {
    expect(fitText("abc", 5)).toBe("abc");
  });
  test("truncates with the marker at the end", () => {
    expect(fitText("abcdef", 4)).toBe("abc.");
    expect(fitText("abcdef", 4, "…")).toBe("abc…");
  });
  test("returns empty for zero width", () => {
    expect(fitText("abc", 0)).toBe("");
  });
  test("pads to the width", () => {
    expect(padText("ab", 4)).toBe("ab  ");
    expect(padText("abcdef", 4)).toBe("abc.");
  });
  test("textWidth counts display cells: 1 for narrow code points", () => {
    expect(textWidth("aø…")).toBe(3);
  });
  test("textWidth counts 2 cells for East Asian Wide/Fullwidth and emoji", () => {
    expect(textWidth("日本")).toBe(4);
  });
  test("fitText truncates by display cells, not code points", () => {
    // "日本語" is 6 cells; the "." marker takes 1, leaving a 4-cell budget that exactly fits "日本".
    expect(fitText("日本語", 5)).toBe("日本.");
  });
  test("padText pads by display cells", () => {
    expect(padText("日", 4)).toBe("日  ");
  });
});

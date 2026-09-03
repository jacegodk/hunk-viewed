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
  test("textWidth counts code points", () => {
    expect(textWidth("aø…")).toBe(3);
  });
});

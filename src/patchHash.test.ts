import { describe, expect, test } from "bun:test";
import { hashPatch } from "./patchHash";

describe("hashPatch", () => {
  test("returns the sha256 hex of the patch text", () => {
    expect(hashPatch("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hashPatch("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("differs when the patch differs", () => {
    expect(hashPatch("+a\n")).not.toBe(hashPatch("+b\n"));
  });
});

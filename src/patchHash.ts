import { createHash } from "node:crypto";

/** Return the sha256 hex digest of one file's patch text; the viewed mark is tied to it. */
export function hashPatch(patch: string): string {
  return createHash("sha256").update(patch, "utf8").digest("hex");
}

/**
 * File-view syntax paint fields from hunk PR modem-dev/hunk#1053 (merged 2026-09-13, documented as
 * extension API 28; not in any hunkdiff release up to 0.22.0). The `hunkdiff@0.21.0` dev
 * dependency's types predate them. Delete this file once the dev dependency is bumped to a
 * release that ships them.
 */
import "hunkdiff/extension";

declare module "hunkdiff/extension" {
  interface ExtensionFileViewCodeDocument {
    readonly id: string;
    readonly text: string;
    readonly language?: string;
  }

  interface ExtensionFileViewSyntaxReference {
    readonly documentId: string;
    readonly line: number;
    readonly range?: readonly [number, number];
  }

  interface ExtensionFileViewSpan {
    readonly syntax?: ExtensionFileViewSyntaxReference;
  }

  interface ExtensionFileViewLayout {
    readonly codeDocuments?: readonly ExtensionFileViewCodeDocument[];
  }
}

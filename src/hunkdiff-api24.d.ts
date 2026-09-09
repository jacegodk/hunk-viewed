/**
 * Extension API 24 additions (hunk PR modem-dev/hunk#1053: host-owned file-view syntax paint) that
 * the `hunkdiff@0.21.0` dev dependency's types predate. Delete this file once the dev dependency
 * is bumped to a release that ships them.
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

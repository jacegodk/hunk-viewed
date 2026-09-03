/**
 * Replacement files pane: a title row with viewed progress, then the tree or flat file list
 * with viewed marks. Files and selection come from the host props; marks and the mode flag
 * come from the extension stores. Adapted from hunk's bundled sidebar (MIT, Modem Labs Inc.)
 * without row windowing.
 */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { ExtensionPaneProps } from "hunkdiff/extension";
import { useReviewMirror } from "../reviewMirror";
import { isViewed, useViewedState } from "../viewedStore";
import { buildFlatSidebarEntries, buildTreeSidebarEntries, resolveFileSidebarMode, sidebarEntryStatsWidth } from "./entries";
import { DirectoryRow, FileRow, GroupHeader, fileRowId } from "./rows";
import { padText } from "./text";

/** Render the hunk-viewed files pane. */
export function FilesPane({ files, selectedFileId, theme, width, actions }: ExtensionPaneProps): ReactNode {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const viewed = useViewedState();
  const { filesModeActive } = useReviewMirror();
  // One column of selection stripe plus one of row padding, as in the bundled pane.
  const textWidth = Math.max(8, width - 2);
  const mode = resolveFileSidebarMode(textWidth);
  const paddingLeft = mode === "tree" ? 0 : 1;

  const entries = useMemo(
    () => (mode === "tree" ? buildTreeSidebarEntries(files) : buildFlatSidebarEntries(files)),
    [files, mode],
  );
  const viewedByFileId = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const file of files) map.set(file.id, isViewed(viewed, file));
    return map;
  }, [files, viewed]);
  const viewedCount = useMemo(() => [...viewedByFileId.values()].filter(Boolean).length, [viewedByFileId]);
  const statsWidth = useMemo(
    () => entries.reduce((max, entry) => Math.max(max, entry.kind === "file" ? sidebarEntryStatsWidth(entry) : 0), 0),
    [entries],
  );

  useEffect(() => {
    if (!selectedFileId) return;
    scrollRef.current?.scrollChildIntoView(fileRowId(selectedFileId));
  }, [files, mode, selectedFileId]);

  const title = padText(` Files  ${viewedCount}/${files.length} viewed`, Math.max(1, width));

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
      <box style={{ width: "100%", height: 1, backgroundColor: theme.panel }}>
        <text fg={filesModeActive ? theme.accent : theme.muted}>{title}</text>
      </box>
      <scrollbox
        ref={scrollRef}
        width="100%"
        flexGrow={1}
        focused={false}
        scrollY={true}
        viewportCulling={true}
        rootOptions={{ backgroundColor: theme.panel }}
        wrapperOptions={{ backgroundColor: theme.panel }}
        viewportOptions={{ backgroundColor: theme.panel }}
        contentOptions={{ backgroundColor: theme.panel }}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <box style={{ width: "100%", flexDirection: "column" }}>
          {entries.map((entry) => {
            if (entry.kind === "group") {
              return <GroupHeader key={entry.id} entry={entry} paddingLeft={paddingLeft} textWidth={textWidth} theme={theme} />;
            }
            if (entry.kind === "directory") {
              return (
                <DirectoryRow key={entry.id} entry={entry} paddingLeft={paddingLeft} statsWidth={statsWidth} textWidth={textWidth} theme={theme} />
              );
            }
            return (
              <FileRow
                key={entry.id}
                entry={entry}
                viewed={viewedByFileId.get(entry.id) ?? false}
                paddingLeft={paddingLeft}
                selected={entry.id === selectedFileId}
                statsWidth={statsWidth}
                textWidth={textWidth}
                theme={theme}
                onSelectFile={actions.selectFile}
              />
            );
          })}
        </box>
      </scrollbox>
    </box>
  );
}

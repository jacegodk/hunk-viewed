/**
 * Row components for the files pane. Adapted from hunk's
 * `src/ui/components/panes/FileListItem.tsx` (MIT, Modem Labs Inc.) with a viewed mark column.
 */
import { memo } from "react";
import type { ExtensionPaneTheme } from "hunkdiff/extension";
import { fitText, padText } from "./text";
import { sidebarEntryStats, type FileDirectoryEntry, type FileGroupEntry, type FileListEntry } from "./entries";

/** Build the element id the pane scrolls into view for one file. */
export function fileRowId(fileId: string): string {
  return `file-row:${fileId}`;
}

/** Return the git-style status glyph and its color. */
function fileStateIcon(entry: FileListEntry, theme: ExtensionPaneTheme): { icon: string; color: string } {
  if (entry.isUntracked) return { icon: "?", color: theme.fileUntracked };
  switch (entry.changeType) {
    case "new":
      return { icon: "A", color: theme.fileNew };
    case "deleted":
      return { icon: "D", color: theme.fileDeleted };
    case "rename-pure":
    case "rename-changed":
      return { icon: "R", color: theme.fileRenamed };
    case "change":
    case undefined:
      return { icon: "M", color: theme.fileModified };
  }
}

/** Clamp indentation so a row always keeps room for its label. */
function indentWidth(depth: number, textWidth: number, reservedWidth: number): number {
  return Math.min(Math.max(0, depth) * 2, Math.max(0, textWidth - reservedWidth - 1));
}

/** Render one directory-group header in flat mode. */
export function GroupHeader({
  entry,
  paddingLeft = 1,
  textWidth,
  theme,
}: {
  entry: FileGroupEntry;
  paddingLeft?: number;
  textWidth: number;
  theme: ExtensionPaneTheme;
}) {
  return (
    <box style={{ width: "100%", height: 1, paddingLeft, backgroundColor: theme.panel }}>
      <text fg={theme.muted}>{fitText(entry.label, Math.max(1, textWidth))}</text>
    </box>
  );
}

/** Render one always-expanded directory row in tree mode. */
export function DirectoryRow({
  entry,
  paddingLeft = 1,
  statsWidth = 0,
  textWidth,
  theme,
}: {
  entry: FileDirectoryEntry;
  paddingLeft?: number;
  statsWidth?: number;
  textWidth: number;
  theme: ExtensionPaneTheme;
}) {
  const statsSectionWidth = statsWidth > 0 ? statsWidth + 1 : 0;
  const indent = indentWidth(entry.depth, textWidth, statsSectionWidth + 1);
  const labelWidth = Math.max(1, textWidth - 1 - statsSectionWidth - indent);
  return (
    <box style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: theme.panel }}>
      <box style={{ width: 1, height: 1, backgroundColor: theme.panel }} />
      <box style={{ flexGrow: 1, height: 1, paddingLeft: paddingLeft + indent, flexDirection: "row", backgroundColor: theme.panel }}>
        <text fg={theme.muted}>{fitText(entry.label, labelWidth)}</text>
      </box>
    </box>
  );
}

/** Width of the viewed-mark column: the glyph plus one space. */
const MARK_WIDTH = 2;

/** Render one file row: selection stripe, viewed mark, status glyph, name, stats. */
export const FileRow = memo(function FileRow({
  entry,
  viewed,
  paddingLeft = 1,
  selected,
  statsWidth,
  textWidth,
  theme,
  onSelectFile,
}: {
  entry: FileListEntry;
  viewed: boolean;
  paddingLeft?: number;
  selected: boolean;
  statsWidth: number;
  textWidth: number;
  theme: ExtensionPaneTheme;
  onSelectFile: (fileId: string) => void;
}) {
  const rowBackground = selected ? theme.panelAlt : theme.panel;
  const stats = sidebarEntryStats(entry);
  const { icon, color } = fileStateIcon(entry, theme);
  const iconWidth = 2;
  const statsSectionWidth = statsWidth > 0 ? statsWidth + 1 : 0;
  const indent = indentWidth(entry.depth, textWidth, MARK_WIDTH + iconWidth + statsSectionWidth + 1);
  const nameWidth = Math.max(1, textWidth - 1 - MARK_WIDTH - iconWidth - statsSectionWidth - indent);
  const textColor = viewed ? theme.muted : theme.text;

  return (
    <box
      id={fileRowId(entry.id)}
      style={{ width: "100%", height: 1, backgroundColor: rowBackground, flexDirection: "row" }}
      onMouseUp={() => onSelectFile(entry.id)}
    >
      <box style={{ width: 1, height: 1, backgroundColor: selected ? theme.accent : rowBackground }} />
      <box style={{ flexGrow: 1, height: 1, paddingLeft: paddingLeft + indent, flexDirection: "row", backgroundColor: rowBackground }}>
        <text fg={theme.accentMuted}>{viewed ? "✓ " : "  "}</text>
        <text fg={viewed ? theme.muted : color}>{icon} </text>
        <text fg={textColor}>{padText(fitText(entry.name, nameWidth, "…"), nameWidth)}</text>
        {statsSectionWidth > 0 && (
          <box style={{ width: statsSectionWidth, height: 1, flexDirection: "row", justifyContent: "flex-end", backgroundColor: rowBackground }}>
            {stats.map((stat, index) => (
              <box key={`${entry.id}:${stat.kind}`} style={{ height: 1, flexDirection: "row", backgroundColor: rowBackground }}>
                {index > 0 && <text fg={theme.muted}> </text>}
                <text
                  fg={
                    viewed
                      ? theme.muted
                      : stat.kind === "agent-comment"
                        ? theme.noteBorder
                        : stat.kind === "addition"
                          ? theme.badgeAdded
                          : theme.badgeRemoved
                  }
                >
                  {stat.text}
                </text>
              </box>
            ))}
          </box>
        )}
      </box>
    </box>
  );
});

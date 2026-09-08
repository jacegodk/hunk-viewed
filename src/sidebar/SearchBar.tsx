/**
 * Bottom search bar: one row that shows the prompt draft while typing, or the active query,
 * hit count, and current hit's file while a search is active. Hidden state (open/closed) is
 * handled entirely by hunk's pane open/close; this component only ever renders its one row.
 */
import { basename } from "node:path/posix";
import type { ReactNode } from "react";
import type { ExtensionPaneProps } from "hunkdiff/extension";
import { useSearchState } from "../search";
import { fitText, fitTextTail, padText, textWidth } from "./text";

/** Render the bottom-bar search row. */
export function SearchBar({ theme, width }: ExtensionPaneProps): ReactNode {
  const { prompt, query, hits, currentIndex } = useSearchState();

  if (prompt.open) {
    const label = "Search: ";
    const contentWidth = Math.max(0, width - textWidth(label));
    // Keep the tail (not the head) of the draft + cursor: a draft longer than the available
    // space must still show the cursor glyph, not have it truncated away at the far end.
    const shown = fitTextTail(`${prompt.draft}▏`, contentWidth);
    return (
      <box style={{ width: "100%", height: 1, backgroundColor: theme.panel, flexDirection: "row" }}>
        <text fg={theme.accent}>{label}</text>
        <text fg={theme.text}>{padText(shown, contentWidth)}</text>
      </box>
    );
  }

  const hit = currentIndex >= 0 ? (hits[currentIndex] ?? null) : null;
  const counter = hits.length === 0 ? "no hits" : `${currentIndex + 1}/${hits.length} hits`;
  const location = hit ? `${basename(hit.filePath)}:${hit.line}` : "";
  // Truncate the query itself so `prefix` + `counter` alone can never exceed `width`; the
  // trailing `location` then simply gets whatever's left (down to nothing) via `padText`.
  const queryBudget = Math.max(0, width - textWidth("Search:   ") - textWidth(counter));
  const prefix = `Search: ${fitText(query, queryBudget, "…")}  `;
  const suffix = `  ${location}`;
  const contentWidth = Math.max(0, width - textWidth(prefix) - textWidth(counter));
  return (
    <box style={{ width: "100%", height: 1, backgroundColor: theme.panel, flexDirection: "row" }}>
      <text fg={theme.muted}>{prefix}</text>
      <text fg={theme.accent}>{counter}</text>
      <text fg={theme.muted}>{padText(suffix, contentWidth)}</text>
    </box>
  );
}

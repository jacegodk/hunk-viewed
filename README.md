# hunk-viewed

GitLab-style "viewed" marks for [hunk](https://hunk.dev). Mark a file as viewed and fold it to one
line, see the check mark in the files pane, review one file at a time, open the whole file, search
inside the changes, and keep the marks between runs.

It is a plain hunk extension. It changes nothing in hunk itself and needs hunk 0.21 or newer
(extension API 16).

## Install

```bash
hunk extension install jacegodk/hunk-viewed
```

hunk clones this repository into its managed extensions directory and loads it on every run.
`hunk extension update hunk-viewed` pulls the latest commit, `hunk extension remove hunk-viewed`
uninstalls it. To pin a release once tags exist: `hunk extension install jacegodk/hunk-viewed@v0.1.0`.

To try a local checkout without installing, or while developing (uncommitted changes count here,
not with `install`):

```bash
hunk diff --extension ~/work/hunk-viewed
```

## Keys

| Key | Command id | Action |
| --- | --- | --- |
| `V` | `hunk-viewed.toggleViewed` | Mark the selected file viewed and fold it to one line. On a viewed file: clear the mark and unfold. The selection stays on the file. |
| `J` | `hunk-viewed.nextUnviewed` | Next file. |
| `K` | `hunk-viewed.previousUnviewed` | Previous file. |
| `U` | `hunk-viewed.skipToUnviewed` | Next unviewed file. Skips viewed files; `J`/`K` do not. |
| `F` | `hunk-viewed.fullFile` | Toggle the full file: every line, with the diff marked in place. Side by side when hunk's layout is split, one column when stacked. |
| `A` | `hunk-viewed.expandAll` | Toggle expand all: every file the full-file view can show opens in full, except viewed files. Off closes them all, also files opened with `F`. Per session. |
| `o` | `hunk-viewed.singleFile` | Toggle single-file mode: the review shows only the current file, the pane still lists all files. |
| `ctrl+f`, `f3` | `hunk-viewed.search` | Search: open the prompt, or jump to the next hit when a search is active. |
| `ctrl+n` | `hunk-viewed.searchNext` | Next hit. |
| `ctrl+p`, `shift+f3`, `ctrl+shift+f` | `hunk-viewed.searchPrevious` | Previous hit. |

Inside single-file mode: `,` and `.` show the previous or next file, `J` and `K` do the same,
`V` folds or unfolds the shown file, a click in the pane picks a file and `Enter` shows it,
`o` or `Esc` leaves and puts the file you were on at the top of the review.

Menu-only commands, in **Extensions**:

| Command id | Action |
| --- | --- |
| `hunk-viewed.foldViewed` | Fold every viewed file. Select a viewed file first; hunk applies the fold from there to all matching files. |
| `hunk-viewed.clearRepo` | Remove every mark for this repo, after a confirmation. |
| `hunk-viewed.searchEdit` | Open the search prompt, prefilled with the current query. |
| `hunk-viewed.searchClear` | Clear the active search and hide the search bar. |

The ids `nextUnviewed` and `previousUnviewed` are historical; they move to the next and
previous file and never skip viewed files. Rebind any command in `~/.config/hunk/config.toml`:

```toml
[keybindings]
"hunk-viewed.toggleViewed" = "V"
"hunk-viewed.nextUnviewed" = "J"
"hunk-viewed.previousUnviewed" = "K"
"hunk-viewed.skipToUnviewed" = "U"
"hunk-viewed.fullFile" = "F"
"hunk-viewed.expandAll" = "A"
"hunk-viewed.singleFile" = "o"
"hunk-viewed.foldViewed" = "ctrl+g"
"hunk-viewed.search" = ["ctrl+f", "f3"]
"hunk-viewed.searchNext" = "ctrl+n"
"hunk-viewed.searchPrevious" = ["ctrl+p", "shift+f3", "ctrl+shift+f"]
```

## Search

`ctrl+f` or `f3` opens the prompt in a one-row bar at the bottom. Typing shows
`Search: text▏`; `Enter` runs the search and the bar switches to
`Search: text  3/17 hits  file:line`; `Esc` cancels; an empty `Enter` clears the search and hides
the bar.

The search scans visible files only: patch lines (context and added text on the new side, removed
text on the old side) for a normal diff file, or the whole new-side document for a file currently
showing the full file view (`F`). Hiding a file with hunk's filter, entering single-file mode, or
toggling the full file view changes what is scanned and the hit count with it. Files marked viewed
are not searched; press `V` to unmark and include them.

Hits are highlighted on their exact matched characters, the current hit stronger than the rest. In
the full file view hits use the accent color instead of hunk's own search tones. `ctrl+n` or `ctrl+f`/`f3`
move to the next hit, `ctrl+p`, `shift+f3`, or `ctrl+shift+f` to the previous; navigation wraps at either
end with a notice.

## How marks work

- A mark is stored per repo (the directory hunk runs in) and per file path, together with a
  sha256 of the file's patch. When the patch changes, the file is unviewed again.
- Marks live in `$XDG_STATE_HOME/hunk/viewed.json`, default `~/.local/state/hunk/viewed.json`
  (`%LOCALAPPDATA%\hunk\viewed.json` on Windows). Marks older than 30 days are dropped.
- Viewed files stay in the review stream and in the pane. Nothing skips them.

## Known limitations

- Folding is per loaded file. After a reload, run **Fold viewed files** again. The header bar of
  a folded file keeps hunk's normal colors.
- The pane counter counts the files the pane shows. With a filter active, it is progress within
  the filter.
- Single-file mode reloads the review on every switch, needs a reloadable input (not a piped
  patch), ignores hunk's filter, and does not carry an open full-file view across switches.
- The full-file view needs a readable source (not a piped patch). It falls back to the normal
  diff over 10,000 rows or when the file changed since the diff was taken. Side-by-side columns cut
  long lines with `…`.
- Syntax highlighting in the full-file view needs a hunk newer than 0.22.0 (extension API 28,
  https://github.com/modem-dev/hunk/pull/1053, merged 2026-09-13 and unreleased); older hunks ignore
  the extra fields and show it in one color. `package.json` keeps `apiVersion` 16 on purpose, so
  the extension still loads on hunk 0.21 and 0.22. Only unchanged lines are highlighted. Added and removed lines stay solid green and red,
  because hunk's token colors would replace that color and hunk paints no green or red background
  on file-view rows. In split layout the old column needs a readable old side for highlighting. A
  file with terminal control characters, or where old and new side together exceed 10,000 lines or
  1,000,000 characters, loses the old side first and then all highlighting.
- Expand all needs an unviewed file selected that the full view can show, because hunk applies the
  selected file's presentation to the others. Like folding it is per loaded file: after a reload,
  and after every switch in single-file mode, press `A` again. While it is on, `F` on a viewed
  file is refused with hunk's own notice; `V` unmarks the file and opens it in full.
- hunk announces its split/stack layout to extensions only when it changes. Until then the
  full-file view guesses split when the review body is at least 116 columns wide, which matches
  hunk's own threshold at default pane sizes. After you switch layout mode with `1`, `2`, or `0`,
  press `F` twice on an open full-file view to re-render it.
- Search has no regex; matching is case-insensitive substring only. A hit inside collapsed context
  lands on its hunk, not the exact line (hunk's `revealLine` fallback). In the full file view, hits
  in removed lines are painted but are not navigable hits, because only the new-side document is
  scanned. At most 100 hits per line and 2,000 per file are highlighted; the full file view falls
  back to hits-free rendering (still full, just unmarked) on very large files. `shift+f3` and
  `ctrl+shift+f` need a terminal with the kitty keyboard protocol; on others `shift+f3` is dropped
  and `ctrl+shift+f` acts as `ctrl+f`. The defaults stay clear of every key hunk 0.22 binds itself (`v`, `N`, `n` are taken there); on
  a hunk that binds one of these anyway, it warns at startup and leaves the command unbound. A
  full view applied from hunk's own View menu instead of `F` does not count as a full view for
  search until `F` is pressed on that file. Files marked viewed are not searched; press `V` to
  unmark and include them.

## Development

```bash
bun install
bun run typecheck
bun test
```

## License

MIT. The files pane is adapted from hunk's bundled sidebar, © Modem Labs Inc., MIT.

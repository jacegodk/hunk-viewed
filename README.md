# hunk-viewed

GitLab-style "viewed" marks for [hunk](https://hunk.dev). Mark a file as viewed and fold it to one
line, see the check mark in the files pane, review one file at a time, open the whole file, and
keep the marks between runs.

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
| `v` | `hunk-viewed.toggleViewed` | Mark the selected file viewed and fold it to one line. On a viewed file: clear the mark and unfold. The selection stays on the file. |
| `J` | `hunk-viewed.nextUnviewed` | Next file. |
| `K` | `hunk-viewed.previousUnviewed` | Previous file. |
| `F` | `hunk-viewed.fullFile` | Toggle the full file: every line, with the diff marked in place. Side by side when hunk's layout is split, one column when stacked. |
| `o` | `hunk-viewed.singleFile` | Toggle single-file mode: the review shows only the current file, the pane still lists all files. |

Inside single-file mode: `J` and `K` show the previous or next file, `v` folds or unfolds the
shown file, a click in the pane picks a file and `Enter` shows it, `o` or `Esc` leaves and puts
the file you were on at the top of the review.

Menu-only commands, in **Extensions**:

| Command id | Action |
| --- | --- |
| `hunk-viewed.foldViewed` | Fold every viewed file. Select a viewed file first; hunk applies the fold from there to all matching files. |
| `hunk-viewed.clearRepo` | Remove every mark for this repo, after a confirmation. |

The ids `nextUnviewed` and `previousUnviewed` are historical; they move to the next and
previous file and never skip viewed files. Rebind any command in `~/.config/hunk/config.toml`:

```toml
[keybindings]
"hunk-viewed.toggleViewed" = "v"
"hunk-viewed.nextUnviewed" = "J"
"hunk-viewed.previousUnviewed" = "K"
"hunk-viewed.fullFile" = "F"
"hunk-viewed.singleFile" = "o"
"hunk-viewed.foldViewed" = "ctrl+f"
```

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
  patch). `J`/`K` switch files; the filter is ignored for switching. Does not carry an open full-file
  view across switches.
- The full-file view needs a readable source (not a piped patch). It falls back to the normal
  diff over 10,000 rows or when the file changed since the diff was taken. It has no syntax
  highlighting, because the extension API only exposes semantic colors. Side-by-side columns cut
  long lines with `…`.
- hunk announces its split/stack layout to extensions only when it changes. Until then the
  full-file view guesses split when the review body is at least 116 columns wide, which matches
  hunk's own threshold at default pane sizes. After you switch layout mode with `1`, `2`, or `0`,
  press `F` twice on an open full-file view to re-render it.

## Development

```bash
bun install
bun run typecheck
bun test
```

## License

MIT. The files pane is adapted from hunk's bundled sidebar, © Modem Labs Inc., MIT.

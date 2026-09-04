# hunk-viewed

GitLab-style "viewed" marks for [hunk](https://hunk.dev). Mark a file as viewed, see the check
mark in the files pane, skip viewed files while you review, and keep the marks between runs.

## Install

```bash
hunk extension install ~/work/hunk-viewed
# or, while developing:
hunk diff --extension ~/work/hunk-viewed
```

Requires hunk 0.21 or newer (extension API 16).

## Keys

| Key   | Action                                                                    |
| ----- | ------------------------------------------------------------------------- |
| `v`   | Mark the selected file viewed and fold it, staying on it. On a viewed file: clear the mark and unfold it, staying on it. |
| `F`   | Toggle full file: the whole file as a diff with unlimited context; `F` again returns to the normal diff |
| `J`   | Next file. In single-file mode: next unviewed file.                      |
| `K`   | Previous file. In single-file mode: previous unviewed file.              |
| `o`   | Single-file mode: shows only the current file. Inside it `,`/`.` switch files, `Enter` loads a file clicked in the pane, `o` or `Esc` leaves and keeps that file selected. In single-file mode `J`/`K` switch the shown file instead of moving the selection; `v` marks/folds or clears/unfolds the shown file in place. |

**Extensions → Fold viewed files** folds every viewed file to one line. It needs a viewed file already selected; run `v` on the file first if it is not marked yet.

`v` folds and unfolds the file it marks, in and out of single-file mode.

**Extensions → Clear viewed marks for this repo** removes every mark for the current repo.

Rebind in `~/.config/hunk/config.toml`:

```toml
[keybindings]
"hunk-viewed.toggleViewed" = "v"
"hunk-viewed.fullFile" = "F"
"hunk-viewed.nextUnviewed" = "J"
"hunk-viewed.previousUnviewed" = "K"
"hunk-viewed.singleFile" = "o"
```

`nextUnviewed`/`previousUnviewed` kept their command ids from round 1; they now move next/previous file (unviewed only inside single-file mode), not next/previous unviewed file everywhere.

## How marks work

- A mark is stored per repo (the canonical working directory hunk runs in) and per file path,
  together with a sha256 of the file's patch. When the patch changes, the file is unviewed again.
- Marks live in `$XDG_STATE_HOME/hunk/viewed.json`, default `~/.local/state/hunk/viewed.json`
  (`%LOCALAPPDATA%\hunk\viewed.json` on Windows). Marks older than 30 days are dropped.
- Viewed files stay in the review stream and in the pane; only `v` skips them, and `J`/`K` skip
  them too, but only inside single-file mode.

## Known limitations

- The pane's `n/m viewed` counter counts the files the pane shows. With a filter active, it is
  progress within the filter, not the whole changeset.
- The extension mirrors hunk's filter from events. After a hard reload with a filter active, the
  mirror can lag until the filter is edited again. When that happens, `J`/`K` fall back to the
  full file list if the selected file is not in the mirrored view.
- Row widths are measured in code points. Wide file names (CJK, emoji) can push the stats column.
- `hunk extension install <path>` clones the path's committed HEAD. Uncommitted work is not
  installed. Use `--extension <path>` while developing.
- Folding is per loaded file, so after a reload run Fold viewed files again. The header bar of a folded file keeps its normal colors. Single-file mode reloads the review on every switch and starts at the top of the file.
- Single-file mode needs a reloadable input (not a piped patch).
- The full-file view needs a readable source (not a piped patch) and falls back to the normal
  diff over 10,000 rows or when the file changed since the diff was taken.
- The full-file view has no syntax highlighting (the extension API only exposes semantic tones).
- The full-file view does not follow you across single-file mode switches; press F again.
- Single-file mode ignores the filter: `,`/`.` can land on a filtered-out file, which shows an empty review until you move on.

## Development

```bash
bun install
bun run typecheck
bun test
```

## License

MIT. The files pane is adapted from hunk's bundled sidebar, © Modem Labs Inc., MIT.

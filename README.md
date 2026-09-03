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
| `v`   | Mark the selected file viewed and jump to the next unviewed file. On a viewed file: clear the mark. |
| `J`   | Next unviewed file                                                        |
| `K`   | Previous unviewed file                                                    |
| `F`   | Files mode: `j`/`k` and the arrows move between files, `Enter`/`Esc` leave |

**Extensions → Clear viewed marks for this repo** removes every mark for the current repo.

Rebind in `~/.config/hunk/config.toml`:

```toml
[keybindings]
"hunk-viewed.toggleViewed" = "v"
"hunk-viewed.nextUnviewed" = "J"
"hunk-viewed.previousUnviewed" = "K"
"hunk-viewed.filesMode" = "F"
```

## How marks work

- A mark is stored per repo (the canonical working directory hunk runs in) and per file path,
  together with a sha256 of the file's patch. When the patch changes, the file is unviewed again.
- Marks live in `$XDG_STATE_HOME/hunk/viewed.json`, default `~/.local/state/hunk/viewed.json`
  (`%LOCALAPPDATA%\hunk\viewed.json` on Windows). Marks older than 30 days are dropped.
- Viewed files stay in the review stream and in the pane; only `v`, `J`, and `K` skip them.

## Known limitations

- The pane's `n/m viewed` counter counts the files the pane shows. With a filter active, it is
  progress within the filter, not the whole changeset.
- The extension mirrors hunk's filter from events. After a hard reload with a filter active, the
  mirror can lag until the filter is edited again. When that happens, `J`/`K` fall back to the
  full file list if the selected file is not in the mirrored view.
- Row widths are measured in code points. Wide file names (CJK, emoji) can push the stats column.
- `hunk extension install <path>` clones the path's committed HEAD. Uncommitted work is not
  installed. Use `--extension <path>` while developing.

## Development

```bash
bun install
bun run typecheck
bun test
```

## License

MIT. The files pane is adapted from hunk's bundled sidebar, © Modem Labs Inc., MIT.

---
title: Sessions
---

Each session is saved under `~/.clue/sessions/` and belongs to the folder it started in.

| Command | What it does |
| --- | --- |
| `clue -c` | Continues the latest session in the current folder. |
| `clue -r` | Picks a past session from the current folder. |
| `clue -r <id or name>` | Continues one session. |
| `clue --name <name>` | Opens the session with that name in the current folder, or creates it. |
| `/rename <name>` | Renames this session. |

A name is unique within a folder and ignores case. `clue --name <name> "prompt"` sends the prompt only when it creates the session, so a tool can run the same command every time. `--name` never opens a session from another folder, but `clue -r <name>` can. When a conversation gets long, clue summarizes older turns. See [Compaction](/docs/compaction).

`clue -r` and `/resume` list only the sessions of the current folder, and you can type to search their titles and prompts. To resume a session from another folder, use `clue -r <id or name>`, and clue continues it in its own folder. If that folder no longer exists, clue tells you and doesn't resume.

Session files are append-only, and nothing is written into your repository.

When a conversation gets long, clue replaces older turns with a summary. See [Compaction](/docs/compaction).

When you start typing in a resumed session, clue sends the history once to warm the cache, so your first reply starts sooner. Opening a session only to read it sends nothing. Typing a `/` command doesn't warm the cache either. The warm-up counts toward the session's cost.

## Undo

`/undo` restores the files that clue changed in the last turn that changed files. It stops if those files changed since, and `/undo force` overwrites them. It keeps the conversation, and it can't undo shell commands. It doesn't survive quitting clue.

## Rewind

Press `esc` twice at an idle prompt to go back to before an earlier prompt. During a run, `esc esc` interrupts, so press it again afterwards.

Pick a prompt, then press `enter` to restore the files and cut the conversation back to it. Press `tab` to cut the conversation and keep the files. The prompt returns to the input, so you can edit it and send it again.

Your scrollback stays as it was. A marker shows where the rewind happened, and the output above it no longer applies.

Each row shows what is possible. `shell` means the turn ran commands, which clue can't reverse. `conversation only` means clue has no file snapshots for that point, such as after a resume. If a file changed since, clue names it, and pressing `enter` again overwrites it. Only prompts since the last compaction appear.

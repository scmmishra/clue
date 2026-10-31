---
title: Sessions
---

Each session is saved under `~/.clue/sessions/` and belongs to the folder it started in.

| Command | What it does |
| --- | --- |
| `clue -c` | Continues the latest session in this folder. |
| `clue -r` | Picks any past session. |
| `clue -r <id or name>` | Continues one session. |
| `clue --name <name>` | Opens the session with that name in this folder, or creates it. |
| `/rename <name>` | Renames this session. |

A name is unique within a folder and ignores case. `clue --name <name> "prompt"` sends the prompt only when it creates the session, so a tool can run the same command every time. `--name` never opens a session from another folder, but `clue -r <name>` can. When a conversation nears the context limit, Claude's server-side compaction summarizes older turns.

Sessions from the current folder come first in `clue -r`, and you can type to search folders, titles and prompts. You can resume a session from anywhere, and clue continues it in its own folder. If that folder no longer exists, clue tells you and doesn't resume.

Session files are append-only, and nothing is written into your repository.

When a conversation gets long, clue replaces older turns with a summary. See [Compaction](/docs/compaction).

## Undo

`/undo` restores the files that clue changed in the last turn that changed files. It stops if those files changed since, and `/undo force` overwrites them. It keeps the conversation, and it can't undo shell commands. It doesn't survive quitting clue.

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

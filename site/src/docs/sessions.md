---
title: Sessions
---

Each session is saved under `~/.clue/sessions/` and belongs to the folder it started in.

| Command | What it does |
| --- | --- |
| `clue -c` | Continues the latest session in this folder. |
| `clue -r` | Picks any past session. |
| `clue -r <id or name>` | Continues one session. |
| `clue --name <name>` | Starts a named session. |
| `/rename <name>` | Renames this session. |

A name is unique within a folder and ignores case. When a conversation nears the context limit, Claude's server-side compaction summarizes older turns.

---
title: Slash commands
---

Type `/` to open the list of commands. `tab` completes the one you're typing.

## Model

| Command | What it does |
| --- | --- |
| `/model` | Picks the model. `←` `→` change its effort. |
| `/effort` | Changes the effort. |
| `/fast` | Turns [fast mode](/docs/models#fast-mode) on or off. |
| `/permissions` | Changes the [permission mode](/docs/permissions). |

## Session

| Command | What it does |
| --- | --- |
| `/new` | Starts a new session. |
| `/resume` | Opens a past session. |
| `/rename` | Shows or changes the session name. |
| `/compact` | Replaces the conversation with a [summary](/docs/compaction). |
| `/undo` | Restores the files the last turn changed. |
| `/usage` | Shows how full the context is, and what the session cost. |
| `/cost` | Same as `/usage`. |

## Other

| Command | What it does |
| --- | --- |
| `/paste` | Attaches the image on the clipboard. |
| `/mcp` | Manages [MCP servers](/docs/mcp-servers). |
| `/help` | Lists commands and keys. |
| `/exit` | Quits clue. |

## Undo

`/undo` restores the files from the last turn that changed files. If those files changed since, `/undo force` overwrites the later changes. Shell commands aren't undone, and the conversation stays as it is.

## Usage

The cost covers every request: turns, including failed and interrupted ones, compactions, advisor calls and warming the cache on resume. The line under the input shows the same total.

A `+` after a reply's cost, such as `$0.42+`, means the reply was interrupted. The API billed some output it never reported, so the real cost is a little higher.

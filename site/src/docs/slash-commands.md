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
| `/copy` | Copies the last reply, or the part you describe. |
| `/paste` | Attaches the image on the clipboard. |
| `/mcp` | Manages [MCP servers](/docs/mcp-servers). |
| `/help` | Lists commands and keys. |
| `/exit` | Quits clue. |

## Undo

`/undo` restores the files from the last turn that changed files. If those files changed since, `/undo force` overwrites the later changes. Shell commands aren't undone, and the conversation stays as it is.

## Copy

`/copy` puts the last reply on the clipboard as Markdown. It copies the text clue received, so the gutters and line wraps on screen are left out.

`/copy <request>` copies only the parts you describe, such as `/copy the sql` or `/copy all the code blocks`. A code block is copied without its fences. If you describe several parts, they are joined with a blank line. A line under the command says what was copied.

A model picks the parts. clue uses Perplexity's Decider through OpenRouter if `OPENROUTER_API_KEY` is set, and Claude Haiku if it isn't. If Decider fails, Haiku picks. The model sees the last reply but not the tool output. To use another model, see [Choose the copy model](/docs/settings#choose-the-copy-model).

On a Mac, clue copies with `pbcopy`. On Linux, and over SSH, it asks your terminal to set the clipboard with an OSC 52 code, so the copy lands on the computer in front of you. Ghostty, kitty, WezTerm and iTerm2 support it, and some turn it off until you allow clipboard access in their settings. In tmux, add `set -g set-clipboard on` to your tmux config. The first copy in a session says so.

## Usage

The cost covers every request: turns, including failed and interrupted ones, compactions, advisor calls and warming the cache on resume. The line under the input shows the same total.

A `+` after a reply's cost, such as `$0.42+`, means the reply was interrupted. The API billed some output it never reported, so the real cost is a little higher.

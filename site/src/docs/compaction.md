---
title: Compaction
---

Compaction replaces older turns of a conversation with a summary that Claude writes. It keeps a long session inside the context window, and it keeps each request smaller.

## When it runs

The API compacts a conversation on its own when it reaches about 150k tokens. `/usage` shows how close you are.

`/compact` does it when you ask, such as when you finish one task and start another in the same session. If the summary doesn't finish, clue tells you why and the conversation stays as it was.

After you run `/compact` in a session, clue starts the later compactions itself, at the same 150k point. They can run before your next message or between tool calls.

## What changes

| After `/compact` | What happens |
| --- | --- |
| Images | Gone. Add them again if Claude still needs them. |
| File contents | Gone. Claude reads files again when it needs them, and it must read a file before it edits it. |
| Project instructions | clue sends them again with your next message. |
| Your screen | Stays as it is. |
| The session file | Keeps every message, and a resumed session still shows them. |

A summary takes a request of its own, so it adds to your usage. `/usage` includes that cost. You can't interrupt `/compact`, and keys you press wait until it finishes.

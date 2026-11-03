---
title: Compaction
---

Compaction replaces the older part of a conversation with a summary that Claude writes. It keeps a long session inside the context window, and it keeps each request smaller.

## When it runs

clue compacts a conversation when it reaches 80% of the window left after the longest reply. That is about 749k tokens on clue's models, which all have a 1M window. A model clue doesn't know compacts at 150k. `/usage` shows how close you are.

A compaction runs before your next message, or between tool calls, and then the turn goes on.

`/compact` does it when you ask, such as when you finish one task and start another in the same session. If the summary doesn't finish, clue tells you why and the conversation stays as it was.

## What it keeps

clue keeps the latest messages word for word, about 20k tokens of them, and Claude summarizes the rest. The kept part starts at one of your prompts or one of Claude's replies, so a tool call always keeps its result. If the whole conversation is smaller than that, all of it goes into the summary.

## What changes

| After a compaction | What happens |
| --- | --- |
| Recent messages | Stay as they were. |
| Older images | Gone. Add them again if Claude still needs them. |
| Older file contents | Gone. Claude reads files again when it needs them. |
| Project instructions | clue sends them again with your next message, unless the recent messages still hold them. |
| Your screen | Stays as it is. |
| The session file | Keeps every message, and a resumed session still shows them. |

A summary takes a request of its own, so it adds to your usage. `/usage` includes that cost, and so does `cost_usd` in `clue ask --json`. You can't interrupt `/compact`, and keys you press wait until it finishes.

---
title: Compaction
---

Compaction replaces older turns of a conversation with a summary that Claude writes. It keeps a long session inside the context window, and it keeps each request smaller.

## When it runs

clue compacts a conversation before a request would reach the model's compaction point. `/usage` shows how close you are.

| Model | Compacts at |
| --- | --- |
| Fable, Opus and Sonnet | 80% of the window left after the longest reply: about 749k tokens of a 1M window |
| Haiku 5.5 | 80k tokens, under its higher price for prompts over 100k |
| A model clue doesn't know | 150k tokens |

The `compact_at` [setting](/docs/settings) moves the point: a token count such as `400000`, or a share of the window such as `"40%"`. It can't go under 50k, and clue keeps 15% of the window free for the reply. A later point compacts less often and loses less detail to summaries. Each request reads the whole context, though, so it costs more per request, and a long context full of old tool output can make Claude less accurate.

Automatic compaction can run before your next message or between tool calls. It keeps the latest 20k tokens of the conversation word for word after the summary, so Claude still has the exact output it was working with. The kept part starts where no tool call is cut from its result.

`/compact` does it when you ask, such as when you finish one task and start another in the same session. It summarizes everything and keeps nothing. If the summary doesn't finish, clue tells you why and the conversation stays as it was.

The summary follows clue's own instructions. It keeps your requests and the constraints you gave, decisions and the approaches that failed, the files changed, errors still open, and the next step.

## What changes

| After a compaction | What happens |
| --- | --- |
| Images | Gone, unless they are in the kept part. Add them again if Claude still needs them. |
| File contents | Gone, unless they are in the kept part. Claude reads files again when it needs them. |
| Project instructions | clue sends them again with your next message. |
| Your screen | Stays as it is. |
| The session file | Keeps every message, and a resumed session still shows them. |

A summary takes a request of its own, so it adds to your usage. `/usage` includes that cost. You can't interrupt `/compact`, and keys you press wait until it finishes.

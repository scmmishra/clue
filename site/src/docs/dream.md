---
title: Dream
description: clue dream reads your past sessions in a repository and proposes memories from your corrections. Approved memories load into every new session there.
---

`clue dream` reads your past sessions in a repository and finds the messages where you corrected or guided the agent. From those it proposes memories, such as "Don't add a check that no caller uses". You review each one. Every new session in the repository loads the memories you approved.

```bash
cd your-repo
clue dream
```

It works only inside a git repository. It needs `OPENROUTER_API_KEY` and your [Claude credentials](/docs#sign-in).

## What it reads

A dream reads the clue sessions you ran in the repository, in any of its worktrees. `clue dream --include-cc` also reads Claude Code's transcripts for the repository. clue looks for them in `~/.claude/projects`, or in `CLAUDE_CONFIG_DIR` if you set it.

In each session, it reads the messages you typed after the first prompt. The first prompt is usually a new task, and a correction comes later. Short replies such as "yes" or "commit it" are dropped before any model runs.

## How it proposes memories

A dream runs two passes:

1. Jev, a decision model on OpenRouter, reads each message with the end of what the agent said before it. It keeps the messages that guide how the agent works, such as a correction or a rule for commits. It drops new tasks, questions and approvals.
2. Sonnet reads the kept messages, with the memories you already approved and the ones you rejected. It proposes at most 10 memories. Each one lists up to 5 of your messages as evidence.

A memory usually needs at least two messages behind it. One message is enough when you stated a lasting rule, with words such as "always" or "from now on". If the evidence refines an approved memory, the proposal names that memory. Approving the proposal removes the old one.

The Sonnet pass runs on Claude's API and shows its cost when it ends. The Jev pass is billed by OpenRouter.

## Review the proposals

After the proposals arrive, clue opens a list to review them.

| Key | Action |
| --- | --- |
| `space` | Cycle the proposal through approve, reject and skip. |
| <kbd>e</kbd> | Edit the proposal's text. |
| <kbd>s</kbd> | Split the proposal into one per sentence. Each part keeps the same evidence. |
| `→` | Show the evidence: your messages, with what the agent said before each one. `←` goes back. |
| <kbd>q</kbd> | Finish the review. |

A proposal you skip, or don't mark, waits for the next review. The next `clue dream` shows it again before it reads anything new, so no paid work is lost.

## Where memories go

A repository's dream is two files in `~/.clue/dreams/`:

- A JSON file holds everything: approved memories with their evidence, proposals waiting for review, rejected proposals, and how far each session was read.
- A Markdown file lists only the approved memories.

A session in the repository loads the Markdown list into its context with the first prompt, after the [project instructions](/docs/project-instructions). Every worktree of the repository loads the same list.

clue writes the Markdown file from the JSON file each time a dream saves. To change a memory for good, edit it in the JSON file.

## Later dreams

A later dream reads only the messages typed since the last one. It doesn't propose a memory you rejected again, in the same or other words.

If you interrupt a dream before the proposals arrive, nothing is saved, and the next dream reads the same sessions. A message Jev failed to judge waits for the next dream.

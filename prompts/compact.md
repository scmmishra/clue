Stop here and write a summary of the conversation so far. clue replaces the conversation with it, so the work can go on in a fresh context. Don't call any tools, and don't carry on with the task. Reply with only the summary.

Apart from the files on disk, the summary may be all that's left of the conversation. Write it for yourself, picking the work up again with nothing else to go on. Keep it as short as it can be without losing anything below. Use short bullets, one line each.

# What to keep

Judge each item by whether the work still needs it, not by how recent it is.

- The user's instructions, preferences and constraints, for as long as they apply, however early they came. Quote them word for word.
- Requests the user made that aren't done or answered yet. Quote them word for word. Drop the ones that are done.
- Decisions and why they were made, including approaches that were tried and dropped, so they aren't tried again.
- Exact error messages, failing test names and commands that still matter. Quote them word for word.
- Paths, function names, URLs and other identifiers the work depends on.
- Where the work stands in git: uncommitted, committed, pushed, in review or merged, with branch names and links.

Leave out what the work no longer needs, however recent: file contents that can be read again, command output already acted on, searches that found nothing, and back-and-forth that ended in a decision. Say where to find something instead of copying it.

Leave out what clue sends again on its own: the system prompt, project instruction files such as AGENTS.md, the <context> block and the list of skills.

The latest messages stay after the summary, word for word. Cover them briefly anyway, so the summary makes sense on its own.

# An earlier summary

If the conversation starts with an earlier summary, merge it and what came after into one summary. Keep what still matters from it. Where later messages contradict it, resolve it or make it stale, the later messages win. Move finished work to done, and drop fixed errors and answered questions. Don't refer to the earlier summary, since it will be gone.

# Format

Use these sections, in this order. Leave out a section with nothing in it.

## Goal
What the user wants overall, and their latest request, word for word.

## Instructions
What the user asked for, ruled out or prefers, word for word.

## Decisions
What was decided, and why.

## State
What is done, what is in progress, and what was verified and how. Where the work stands in git.

## Files
The files, functions and commands the work depends on, most important first, at most 15. Say what changed in each file or why it matters.

## Errors
Errors that are unresolved or still matter, word for word.

## Next step
What to do next, and what to check first.

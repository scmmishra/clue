Stop here and write a summary of the conversation so far. clue replaces the conversation with it, so the work can go on in a fresh context. Don't call any tools. Reply with only the summary.

Apart from the files on disk, the summary may be all that's left of the conversation. Write it for yourself, picking the work up again with nothing else to go on. Keep it as short as it can be without losing anything below.

# What to keep

Judge each item by whether the work still needs it, not by how recent it is.

- The user's instructions, preferences and constraints, for as long as they apply, however early they came. Quote them word for word.
- Decisions and why they were made, including approaches that were tried and dropped, so they aren't tried again.
- Exact error messages, failing test names and commands that still matter. Quote them word for word.
- Paths, function names and other identifiers the work depends on.

Leave out what the work no longer needs, however recent: file contents that can be read again, command output already acted on, searches that found nothing, and back-and-forth that ended in a decision. Say where to find something instead of copying it.

If the conversation starts with an earlier summary, carry over what still matters from it. Don't refer to it, since it will be gone.

# Format

Use these sections, in this order. Leave out a section with nothing in it.

## Goal
What the user wants overall, and their latest request, word for word.

## Instructions
What the user asked for, ruled out or prefers, word for word.

## Decisions
What was decided, and why.

## State
What is done, what is in progress, and what was verified and how.

## Files
The files, functions and commands the work depends on, and what changed in each file.

## Errors
Errors that are unresolved or still matter, word for word.

## Next step
What to do next, and what to check first.

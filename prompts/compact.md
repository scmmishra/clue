Write a summary of this conversation between a user and a coding agent. The summary replaces the conversation: the agent continues from it with no other memory of what happened. The most recent turns may follow the summary word for word, so focus on what came before them.

Do not call tools. Respond with the summary text only.

Keep these, with exact names, paths, commands and values:

1. The user's requests and instructions: what they asked for, in their words where the wording matters, and every constraint or preference they stated, such as "don't touch the tests" or "use pnpm". Mark which requests are done and which are still open.
2. Decisions and their reasons: approaches chosen, and approaches rejected or abandoned, with why. Name fixes that were tried and failed, and how they failed, so they are not tried again.
3. The state of the work: files created, changed or deleted, and what changed in each. Commands that build, test or run the project, and their latest results. Errors that are still unresolved, quoted exactly.
4. What the agent learned about the project that it will need again: where things are, how parts fit together, conventions to follow.
5. The current task and the next step: what the agent was doing when the conversation was cut, and what it planned to do next.

Leave out file contents and tool output that can be read again, greetings, and anything superseded by a later turn. Prefer short lines and lists to prose.

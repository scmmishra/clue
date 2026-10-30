---
title: Project instructions
---

Instruction files tell clue how your project works. Good ones are short: the commands to build and test, the conventions to follow, and what to avoid.

```markdown
# Project notes

- Run tests with `bun test`.
- Use the existing helpers in `src/lib`.
- Never edit generated files in `dist`.
```

clue reads these files:

- `~/.clue/AGENTS.md`, for your own instructions across projects.
- `AGENTS.md` and `CLAUDE.md`, in every folder from the git root down to where clue started.
- Nested `AGENTS.md` and `CLAUDE.md` files, when clue reads or changes a file in their folder.

clue reads the first 20,000 characters of each file. Projects already set up for Claude Code work as they are.

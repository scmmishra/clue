---
title: Skills
---

A skill is a folder of instructions that clue reads when a task needs them. The model sees each skill's name and description, so an installed skill takes little room in the context.

## Write a skill

Create a folder with a `SKILL.md` file:

```markdown
---
name: release-notes
description: Write release notes from the commits since the last tag.
---

Read the commits since the last tag. Group them by feature and fix.
```

Other files in the folder are available to the model. Only the first 300 characters of a description are used.

## Where skills load from

clue checks these folders in order. If two define the same name, the first one wins.

1. `.clue/skills`
2. `~/.clue/skills`
3. `.claude/skills`
4. `~/.claude/skills`
5. `.agents/skills`
6. `~/.agents/skills`

## Install a skill

Ask clue to install one from a local folder or a git URL. It goes into `~/.clue/skills` and is available from the next session.

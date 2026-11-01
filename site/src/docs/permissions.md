---
title: Permissions
---

| Mode | Behavior |
| --- | --- |
| `ask` | Asks before any action that changes something. |
| `auto` | Runs routine work, and sends other actions to a reviewer model. This is the default. |
| `full-access` | Skips the checks. Deny rules still apply. |

Switch modes with `shift+tab`, `/permissions <mode>`, `--permission-mode <mode>` for one run, or `permission_mode` in `settings.json`.

## What `auto` does

clue runs these directly:

- Reading files and searching code or the web.
- Creating and editing files inside the project.
- A short list of project commands, such as `git status`, tests and builds, including chains of them joined by `&&`, `||`, `;` or `|`.

It has these reviewed first:

- Input that the model sends to a running shell process. It can be any command, so clue treats it as an unrecognized command. Reading a process's output and stopping it run without review.
- Any other shell command, including one with a redirect to a file, a substitution, a variable or a background `&`.
- Writing files outside the project. clue follows links first, so a write through a link that leads out of the project counts as outside. If clue can't tell where a path leads, it counts as outside.
- Changing sensitive configuration, such as `.env`, `.git`, `.ssh`, `.mcp.json` and `.clue/settings.json`. The check ignores case and also looks at where a link points.
- Calling an MCP tool.

A review sends the exact action to a review model, which checks it for prompt injection and harmful behavior. If the reviewer finds no problem, clue runs the action. If it flags the action, or no reviewer can finish the check, clue shows you the reason and asks whether to run it, as in `ask` mode. In `clue ask`, where no one can answer, clue holds the action and tells the model why. Deleting temporary files, such as under `/tmp`, counts as routine cleanup, not a reason to flag. If the action is too long for the reviewer to read in full, clue skips the review and asks you, or holds the action in `clue ask`. Every review adds to your usage. See [Choose the reviewer](/docs/settings#choose-the-reviewer).

`auto` reduces risk, but it isn't a sandbox. An allowed command such as `bun test` still runs your project's code. Routine runners run what the project defines, and flags that point at other code or folders go to review. Use a container or VM for untrusted repositories.

## Rules

Rules in `settings.json` skip the review. The last match wins. In a shell chain, a deny on one command denies the chain, and an allow needs every command to match. A command clue can't parse never matches an allow rule. Deny and ask rules also match a command after `time`, `env`, `timeout` and leading `NAME=value` words, but allow rules do not. A deny or ask rule that ends in ` *` also matches the bare command, so `git push *` matches `git push`. An allow rule does not. Rules can't see inside `bash -c '...'` and don't match a full path such as `/usr/bin/git push`. Deny rules also apply to read-only tools. A rule for a file tool matches the path as the model wrote it, as an absolute path and relative to the project, so `src/generated/*` also covers `./src/generated/a.ts` and the same file by its absolute path. A deny or ask rule matches in any of these forms, and also matches the real path behind a link. An allow rule matches the path as written or relative to the project. An allow rule does not match the path as written if it contains `..`, so `src/../../x` does not match `src/*`. A leading `~/` is your home folder. Deny and ask rules also match input sent to a running process. Allow rules and "always allow" answers never cover that input.

```json
{
  "permission": {
    "shell": { "git *": "allow", "git push *": "deny" },
    "read_file": { "*.env": "deny" }
  }
}
```

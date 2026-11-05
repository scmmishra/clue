---
title: Permissions
description: The ask, auto and full-access modes, and the rules that decide which actions clue runs.
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

- Any other shell command, including one with a redirect to a file, a substitution, a variable or a background `&`.
- A shell command that names a file with secrets, such as `.env` or `~/.ssh/id_rsa`.
- Writing files outside the project.
- Changing sensitive configuration.
- Calling an MCP tool.

A review sends the exact action to a review model, which checks it for prompt injection and harmful behavior. The reviewer also sees your last few messages and the agent's latest tool calls, so it can tell how the action fits the work. Tool output goes only to a Claude reviewer. A decision model on OpenRouter, such as Jev, sees the calls without their output. Reading your own local files and databases counts as investigation, not a reason to flag, unless it targets credentials or sends the data off the machine. If the reviewer finds no problem, clue runs the action. If it flags the action, or no reviewer can finish the check, clue shows you the reason and asks whether to run it, as in `ask` mode. In `clue ask`, where no one can answer, clue holds the action and tells the model why. Deleting temporary files, such as under `/tmp`, counts as routine cleanup, not a reason to flag. Every review adds to your usage. See [Choose the reviewer](/docs/settings#choose-the-reviewer).

`auto` reduces risk, but it isn't a sandbox. An allowed command such as `bun test` still runs your project's code. Use a container or VM for untrusted repositories.

## Rules

Rules in `settings.json` skip the review. The last match wins. In a shell chain, a deny on one command denies the chain, and an allow needs every command to match. A command clue can't parse never matches an allow rule. Deny and ask rules also match the command after `time`, `timeout <duration>`, `env` and variable assignments, so `git push *` blocks `time git push` and `CI=1 git push`. A pattern that ends in ` *` also matches the bare command, so `git push *` blocks `git push`. A file rule for a path inside the project also matches it with a leading `./` or as an absolute path, so `src/gen/*` also matches `./src/gen/a.ts`. File rules are case-sensitive. Deny rules also apply to read-only tools.

> [!WARNING]
> Deny rules don't see inside `bash -c "..."` or a full program path such as `/usr/bin/git`.

```json
{
  "permission": {
    "shell": { "git *": "allow", "git push *": "deny" },
    "read_file": { "*.env": "deny" }
  }
}
```

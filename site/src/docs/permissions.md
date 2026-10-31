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

- Any other shell command, including one with a redirect, a substitution, a variable or a background `&`.
- Writing files outside the project.
- Changing sensitive configuration.
- Calling an MCP tool.

A review sends the exact action to a review model, which checks it for prompt injection and harmful behavior. If the reviewer finds no problem, clue runs the action. If it flags the action, or no reviewer can finish the check, clue holds the action and tells the model why. Every review adds to your usage. See [Choose the reviewer](/docs/settings#choose-the-reviewer).

`auto` reduces risk, but it isn't a sandbox. An allowed command such as `bun test` still runs your project's code. Use a container or VM for untrusted repositories.

## Rules

Rules in `settings.json` skip the review. The last match wins. In a shell chain, a deny on one command denies the chain, and an allow needs every command to match. A command clue can't parse never matches an allow rule. Deny rules also apply to read-only tools.

```json
{
  "permission": {
    "shell": { "git *": "allow", "git push *": "deny" },
    "read_file": { "*.env": "deny" }
  }
}
```

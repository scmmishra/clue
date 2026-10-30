---
title: Permissions
---

| Mode | Behavior |
| --- | --- |
| `ask` | Asks before any action that changes something. |
| `auto` | Runs routine work, and sends other actions to a reviewer model. This is the default. |
| `full-access` | Skips the checks. Deny rules still apply. |

`auto` reduces risk, but it isn't a sandbox. Use a container or VM for untrusted repositories.

Rules in `settings.json` skip the review. The last match wins. In a shell chain, a deny on one command denies the chain, and an allow needs every command to match.

```json
{
  "permission": {
    "shell": { "git *": "allow", "git push *": "deny" },
    "read_file": { "*.env": "deny" }
  }
}
```

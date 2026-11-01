---
title: Models
---

clue starts with `claude-opus-5-5` at `medium` effort.

| Where | Model | Effort |
| --- | --- | --- |
| For one run | `--model <id>` | `--effort <level>` |
| In a session | `/model` or `/model <id>` | `/effort` or `/effort <level>` |
| As your default | `model` in `settings.json` | `effort` in `settings.json` |

Short names work too:

```bash
clue --model sonnet
```

Inside clue, `/model` and `/effort` open a list to choose from. Effort levels are `low`, `medium`, `high`, `xhigh` and `max`. Lower effort means shorter thinking and a sooner first token.

Changing the model mid-session starts a fresh cache for the rest of that session.

## Fast mode

Fast mode asks Claude to reply faster, at twice the token price. It works with Opus 5.5 and Opus 5.

| Where | Fast mode |
| --- | --- |
| For one run | `--fast` |
| In a session | `/fast`, `/fast on` or `/fast off` |
| As your default | `fast` in `settings.json` |

The line under the input shows `fast` while it is on, and the footer of each reply shows `fast` if Claude answered in fast mode. Turning it on or off starts a fresh cache.

If you switch to a model without fast mode, clue turns it off. clue also turns it off if the API rejects it or its rate limit runs out, and it continues at standard speed. Run `/fast` to turn it back on.

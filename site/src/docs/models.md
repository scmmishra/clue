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

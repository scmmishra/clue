---
title: Settings
---

Settings live in `~/.clue/settings.json`. Every key is optional.

| Key | Default | What it does |
| --- | --- | --- |
| `model` | `claude-opus-5-5` | The model for new sessions. |
| `effort` | `medium` | The effort level. |
| `permission_mode` | `auto` | `ask`, `auto` or `full-access`. |
| `permission` | none | Allow, ask and deny rules. See [Permissions](/docs/permissions). |
| `review_model` | `typesafe/jev-1.14` | The reviewer when `OPENROUTER_API_KEY` is set. |
| `bell` | `true` | Rings the terminal bell when clue needs you. |

```json
{
  "model": "claude-sonnet-5-5",
  "effort": "high",
  "bell": false
}
```

`CLUE_MODEL`, `CLUE_EFFORT` and `CLUE_PERMISSION_MODE` override the file for one process. Command-line flags override both.

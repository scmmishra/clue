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
| `review` | automatic | Who reviews actions in `auto` mode. See below. |
| `bell` | `true` | Rings the terminal bell when clue needs you. |

```json
{
  "model": "claude-sonnet-5-5",
  "effort": "high",
  "bell": false
}
```

## Choose the reviewer

```json
{
  "review": { "provider": "anthropic", "model": "haiku" }
}
```

| `provider` | Default `model` | Other models |
| --- | --- | --- |
| `anthropic` | `haiku` | Any Claude model, such as `sonnet` |
| `openrouter` | `jev` | A pinned Jev, such as `typesafe/jev-1.14` |

Both keys are optional. With no `review`, clue uses Jev if `OPENROUTER_API_KEY` is set, and Haiku otherwise. With `"provider": "anthropic"`, reviews never reach OpenRouter.

If the reviewer fails or the setting can't work, Claude Haiku at low effort reviews instead. The action is held only if that fails too.

`CLUE_MODEL`, `CLUE_EFFORT` and `CLUE_PERMISSION_MODE` override the file for one process. Command-line flags override both.

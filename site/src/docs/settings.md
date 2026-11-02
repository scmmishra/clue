---
title: Settings
---

Settings live in `~/.clue/settings.json`. Every key is optional.

| Command | What it does |
| --- | --- |
| `clue config show` | Shows the settings in use and where each comes from. `--json` is for scripts. |
| `clue config path` | Prints the path of the file. |
| `clue config edit [editor]` | Opens the file, then checks it. Without a name, it uses `$VISUAL`, then `$EDITOR`, then `vi`. |
| `clue config set <key> <value>` | Changes one setting, such as `clue config set review.provider anthropic`. |
| `clue config unset <key>` | Removes a setting, so it goes back to its default. |

clue warns at startup if the file has a problem. If the JSON is broken, clue uses its defaults, so your permission rules don't apply until you fix it.

| Key | Default | What it does |
| --- | --- | --- |
| `model` | `claude-opus-5-5` | The model for new sessions. |
| `effort` | `medium` | The effort level. |
| `fast` | `false` | Starts in [fast mode](/docs/models#fast-mode) on a model that has it. |
| `permission_mode` | `auto` | `ask`, `auto` or `full-access`. |
| `permission` | none | Allow, ask and deny rules. See [Permissions](/docs/permissions). |
| `review` | automatic | Who reviews actions in `auto` mode. See below. |
| `copy` | automatic | Who picks what `/copy <request>` copies. See below. |
| `threads` | `true` | Sends each request as a [message thread](#message-threads), with only what the API doesn't hold yet. |
| `compact_at` | per model | When clue [compacts](/docs/compaction) the conversation: a token count such as `400000`, or a share of the context window such as `"40%"`. |
| `bell` | `true` | Rings the terminal bell when clue needs you. |

```json
{
  "model": "claude-sonnet-5-5",
  "effort": "high",
  "bell": false
}
```

## Message threads

With a message thread, the API keeps the conversation for 5 minutes after each request. clue then sends only the messages since the last reply, instead of the whole conversation, so Claude starts answering sooner in a long session. Claude still reads the whole conversation, so tokens and cost don't change.

clue starts a new thread, with the whole conversation, when the old one can't continue: after a pause of more than 4.5 minutes, a rewind, a summary, a change of model, effort or fast mode, or an MCP server that connects or drops. A request that carries a summary goes without a thread, because threads can't hold one. If the API refuses threads, such as for an organization with HIPAA readiness, clue goes on without them for the session.

The API holds a thread in memory, encrypted, and deletes it no more than an hour after its last use. Threads aren't eligible for zero data retention. To turn them off, set `"threads": false`.

## Choose the reviewer

```json
{
  "review": { "provider": "anthropic", "model": "haiku" }
}
```

| `provider` | Default `model` | Other models |
| --- | --- | --- |
| `anthropic` | `haiku` | Any Claude model, such as `sonnet` |
| `openrouter` | `jev` | Any decision model on OpenRouter, such as `decider` or `perplexity/pplx-decider-v1.2` |

`jev` and `decider` are short names. They point to the latest versions clue knows, `typesafe/jev-1.14` and `perplexity/pplx-decider-v1.2`. An OpenRouter model id has a vendor and a slash before the name. If you set only `model`, clue picks the provider from it.

Both keys are optional. With no `review`, clue uses Jev if `OPENROUTER_API_KEY` is set, and Haiku if it isn't. To always use Haiku, set `"provider": "anthropic"`.

If the reviewer fails or the setting can't work, Claude Haiku at low effort reviews instead. If that fails too, clue asks you, or holds the action in `clue ask`.

## Choose the copy model

`copy` picks the model that chooses what `/copy <request>` copies. It takes the same keys and models as `review`.

```json
{
  "copy": { "provider": "anthropic", "model": "sonnet" }
}
```

With no `copy`, clue uses Decider if `OPENROUTER_API_KEY` is set, and Haiku if it isn't. If the model fails or the setting can't work, Haiku picks instead.

A decision model picks a code block when its probability is at least 0.6, and any other block at 0.85. clue set those cutoffs from benchmarks of Jev and Decider, so another decision model may pick more or fewer blocks.

`CLUE_MODEL`, `CLUE_EFFORT` and `CLUE_PERMISSION_MODE` override the file for one process. Command-line flags override both.

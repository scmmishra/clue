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

Inside clue, `/model` and `/effort` open a list to choose from. In `/model`, `←` and `→` change the effort of the highlighted model. Effort levels are `low`, `medium`, `high`, `xhigh` and `max`. Lower effort means shorter thinking and a sooner first token.

Changing the model mid-session starts a fresh cache for the rest of that session.

## Pairs with an advisor

A pair is two models. The first does the work. On hard steps, it asks the second for advice, such as before it plans a change or when it's stuck. The advisor sees the whole conversation and answers in a few seconds. The first model's tokens cost its own price, and each answer costs the advisor's price.

| Pair | Does the work | Advises | Short name |
| --- | --- | --- | --- |
| `haiku 5.5 + sonnet` | Haiku 5.5 | Sonnet 5.5 | `haiku+sonnet` |
| `sonnet 5.5 + opus` | Sonnet 5.5 | Opus 5.5 | `sonnet+opus` |
| `opus 5.5 + fable` | Opus 5.5 | Fable 5.1 | `opus+fable` |

```bash
clue --model sonnet+opus
```

Each answer shows as an `Asked <advisor>` row, such as `Asked opus 5.5`. The advice itself is encrypted, so clue can't show it. The cost of a reply includes the advice.

A pair runs at `medium` effort or above. Below that, the first model rarely asks its advisor, so clue raises `low` to `medium`. Subagents use the first model alone. Fast mode doesn't work with a pair.

## Fast mode

Fast mode asks Claude to reply faster, at twice the token price. It works with Opus 5.5 and Opus 5.

| Where | Fast mode |
| --- | --- |
| For one run | `--fast` |
| In a session | `/fast`, `/fast on` or `/fast off` |
| As your default | `fast` in `settings.json` |

The line under the input shows `fast` while it is on, and the footer of each reply shows `fast` if Claude answered in fast mode. Turning it on or off starts a fresh cache.

If you switch to a model without fast mode, clue turns it off. clue also turns it off if the API rejects it or its rate limit runs out, and it continues at standard speed. Run `/fast` to turn it back on.

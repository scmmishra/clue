---
title: Scripts
---

`clue ask` sends one request without the interactive shell. It takes the prompt as arguments or on stdin.

```bash
clue ask "explain the changes in this repository"
git diff | clue ask "review this diff"
clue ask --json "summarize the failing tests" | jq -r .final_output
```

The answer goes to stdout, and progress goes to stderr. clue exits with a nonzero status if the request fails, is interrupted or is refused.

## JSON output

`--json` prints one object:

| Field | What it holds |
| --- | --- |
| `final_output` | The final answer. |
| `session_id` | The session's ID. |
| `stop_reason` | Why the turn ended. |
| `tools` | The number of tool calls. |
| `duration_ms` | The total time. |
| `first_token_ms` | The time to the first token. |
| `usage` | Tokens in and out. |
| `cost_usd` | The cost in dollars. |

If the request fails, the object has `error` and `session_id` instead.

## Continue a session

```bash
clue ask --resume <id> "now fix them"
```

`--resume` takes an ID, not a name.

## Approvals

Nobody can answer a prompt in a script. An action that needs approval doesn't run, and the model reports what it wanted to do.

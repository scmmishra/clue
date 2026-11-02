---
title: Keys
---

| Key | What it does |
| --- | --- |
| `enter` | Sends the message. During a run, steers the turn with it. |
| `shift+enter`, `alt+enter`, or `\` then `enter` | Adds a new line. `shift+enter` needs a terminal that reports it, such as Ghostty or kitty. |
| `↑` `↓` | Move through history, or through the `/` command list when it is open. |
| `tab` | Completes a command. During a run, queues the message for after the turn. |
| `@` | Opens the file picker. `↑` `↓` choose, `enter` mentions the file or folder, `tab` opens a folder, `esc` closes the picker. |
| `shift+tab` | Switches between the `ask`, `auto` and `full-access` permission modes. |
| `ctrl+o` | Opens the full detail of the session. |
| `esc esc`, `ctrl+c` | Interrupt a run. When idle, `esc esc` opens [rewind](/docs/sessions#rewind). |
| `ctrl+d` | Exits. |

## Jump between prompts

clue marks each prompt you send, so your terminal's jump-to-prompt keys move between them in a session. This works in terminals that read OSC 133 prompt marks, such as Ghostty, iTerm2, kitty and WezTerm.

| Terminal | Keys |
| --- | --- |
| Ghostty on macOS | `cmd+↑` `cmd+↓` |
| Ghostty on Linux | `ctrl+shift+↑` `ctrl+shift+↓` |

Other terminals have their own keys. Look for "jump to prompt" or "marks" in their docs.

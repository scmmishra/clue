---
title: Quick start
---

clue is a coding agent for the terminal. It runs on Claude's API.

## Install

```bash
curl -fsSL https://clue.shivam.dev/install | bash
```

clue runs on macOS and Linux, on arm64 and x86_64. Run `clue upgrade` to update. Set `CLUE_INSTALL_DIR` to choose the folder, or `CLUE_VERSION` to install a specific tag.


## Sign in

clue reads your credentials in this order:

1. `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in the environment.
2. The profile saved by `ant auth login`. clue looks for it in `~/.config/anthropic`, or in `ANTHROPIC_CONFIG_DIR` if you set it.
3. A key saved by `clue login`. clue keeps it in the macOS Keychain or the system keyring. Without one, it keeps it in a private file in `~/.clue`.

`clue logout` removes a saved key.

## Optional: OpenRouter

Two small jobs use a decision model: reviewing risky actions in `auto` mode, and picking what `/copy <request>` copies. By default, if `OPENROUTER_API_KEY` is set, clue uses Jev for reviews and Perplexity's Decider for `/copy`, both through OpenRouter. If it isn't set, Claude Haiku does both. See [Choose the reviewer](/docs/settings#choose-the-reviewer) and [Choose the copy model](/docs/settings#choose-the-copy-model).


## First prompt

```bash
cd your-project
clue
```

Type what you want done and press Enter. You can also pass the first prompt: `clue "fix the flaky spec"`.

`clue help` lists every command and option. `clue --version` prints the version.

## If something looks wrong

`clue doctor` checks your version, credentials, API access, settings, tools, terminal and MCP servers. It also names the models that review actions and pick what `/copy` copies. It exits with a nonzero status if a check fails.

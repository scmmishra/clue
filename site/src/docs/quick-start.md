---
title: Quick start
---

clue is a coding agent for the terminal. It runs on Claude's API.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/scmmishra/clue/main/install.sh | bash
```

clue runs on macOS and Linux, on arm64 and x86_64. Run `clue upgrade` to update. Set `CLUE_INSTALL_DIR` to choose the folder, or `CLUE_VERSION` to install a specific tag.


## Sign in

clue reads your credentials in this order:

1. `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in the environment.
2. The profile saved by `ant auth login`.
3. A key saved by `clue login`.

`clue logout` removes a saved key.


## First prompt

```bash
cd your-project
clue
```

Type what you want done and press Enter. You can also pass the first prompt: `clue "fix the flaky spec"`.


<img src="site/public/logo.svg" width="96" height="96" alt="The clue logo: a blue pixel prompt bar and dot on a dark screen, inside a blue bevelled icon.">

# clue

[![CI](https://github.com/scmmishra/clue/actions/workflows/ci.yml/badge.svg)](https://github.com/scmmishra/clue/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/scmmishra/clue)](https://github.com/scmmishra/clue/releases/latest)

clue is a fast, simple coding agent for Claude, in your terminal. It calls Claude's API directly and ships as a single binary. The conversation prints into your terminal's scrollback, like any other command's output.

clue works to shorten three waits. It's ready in 7.5 ms, resumes a session in 13.8 ms, and adds 5.4 ms of its own before the first token ([benchmarks](benchmarks/README.md)).

**[Read the docs at clue.shivam.dev](https://clue.shivam.dev)**

> clue is actively developed, so things may change. [CHANGELOG.md](CHANGELOG.md) lists what changed in each version.

## Install

```bash
curl -fsSL https://clue.shivam.dev/install | bash
```

clue runs on macOS and Linux, on arm64 and x86_64. You don't need Bun to run it. `clue upgrade` installs the latest release.

clue calls Claude's API through the API SDK, not the Agent SDK, so it bills per token. `clue usage` shows what it has cost.

## Start

```bash
clue login
cd your-project
clue
```

Type what you want done and press Enter. `/help` lists the commands and keys.

```bash
clue "fix the flaky spec"   # start with a prompt
clue -c                     # continue the last session here
clue ask "explain this"     # one request, for scripts
clue doctor                 # check your setup
clue usage                  # cost and cache use across sessions
```

## Docs

| Topic | Page |
| --- | --- |
| Install and sign in | [Quick start](https://clue.shivam.dev/docs) |
| `@` file mentions, images, steering and queued messages | [Prompts](https://clue.shivam.dev/docs/prompts) |
| Resume, undo and cost across sessions | [Sessions](https://clue.shivam.dev/docs/sessions) |
| `/compact` and long sessions | [Compaction](https://clue.shivam.dev/docs/compaction) |
| `clue ask` and JSON output | [Scripts](https://clue.shivam.dev/docs/scripts) |
| `ask`, `auto` and `full-access` | [Permissions](https://clue.shivam.dev/docs/permissions) |
| `~/.clue/settings.json` | [Settings](https://clue.shivam.dev/docs/settings) |
| MCP servers | [MCP servers](https://clue.shivam.dev/docs/mcp-servers) |
| Commands, keys and tools | [Slash commands](https://clue.shivam.dev/docs/slash-commands), [Keys](https://clue.shivam.dev/docs/keys), [Tools](https://clue.shivam.dev/docs/tools) |

## Develop

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

clue builds on two projects:

- [pi](https://pi.dev) by Mario Zechner showed that a coding agent needs only a short prompt and a plain loop.
- [fx](https://github.com/vercel-labs/fx) by Vercel Labs shaped clue's terminal output, tool set, permission modes and MCP commands. clue's system prompt is adapted from fx's [`system_prompt.md`](https://github.com/vercel-labs/fx/blob/main/src/builtins/system_prompt.md), licensed under Apache-2.0.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

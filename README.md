<img src="site/public/logo.svg" width="96" height="96" alt="The clue logo: a blue pixel prompt bar and dot on a dark screen, inside a blue bevelled icon.">

# clue

[![CI](https://github.com/scmmishra/clue/actions/workflows/ci.yml/badge.svg)](https://github.com/scmmishra/clue/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/scmmishra/clue)](https://github.com/scmmishra/clue/releases/latest)

clue is a coding agent for the terminal. It calls Claude's API directly and ships as a single binary. The conversation prints into your terminal's scrollback, like any other command's output.

clue works to shorten three waits: starting, resuming a session, and the first word of a reply.

**[Read the docs at clue.shivam.dev](https://clue.shivam.dev)**

> Status: early. Expect rough edges. [CHANGELOG.md](CHANGELOG.md) lists what changed in each version.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/scmmishra/clue/main/install.sh | bash
```

clue runs on macOS and Linux, on arm64 and x86_64. You don't need Bun to run it. `clue upgrade` installs the latest release.

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
```

## Docs

| Topic | Page |
| --- | --- |
| Install and sign in | [Quick start](https://clue.shivam.dev/docs) |
| `@` file mentions, images and queued messages | [Prompts](https://clue.shivam.dev/docs/prompts) |
| Resume and undo | [Sessions](https://clue.shivam.dev/docs/sessions) |
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

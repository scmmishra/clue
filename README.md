# clue

[![CI](https://github.com/scmmishra/clue/actions/workflows/ci.yml/badge.svg)](https://github.com/scmmishra/clue/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/scmmishra/clue)](https://github.com/scmmishra/clue/releases/latest)

clue is a coding agent for the terminal. It runs on Claude's API natively and is written in TypeScript on Bun.

clue calls Claude's Messages API directly, so it can use what the API offers: prompt caching, server-side web tools, adaptive thinking and server-side compaction. It uses them for one goal: less waiting. clue measures three waits and works to shorten each one:

1. From typing `clue` to a ready prompt.
2. From `clue -c` to a ready prompt with your last session on screen.
3. From pressing Enter to the first word of the reply.

clue is a single binary. The conversation prints into your terminal's scrollback, like any other command's output.

> Status: early. Expect rough edges, and see [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Principles

- **Claude-native.** Every request is shaped for Claude's API, so features such as caching work without adapters. All model calls go through one provider module, so other providers, such as OpenRouter, can be added beside it.
- **Waiting is a bug.** A change that makes a start, a resume or a first token slower needs a reason. Each of the three is benchmarked.
- **The terminal is the interface.** No full-screen app. Output stays in your scrollback, where you can scroll, search and copy it.
- **History is never rewritten.** A session only grows. This keeps resumes exact and keeps the cache valid.
- **Small enough to read.** The loop, the tools and the prompt should fit in one sitting.
- **Bun does the heavy lifting.** Markdown rendering, ANSI wrapping, PTYs, SQLite, the keychain, JSONL parsing and image resizing all use Bun's native APIs instead of JavaScript or npm packages.

## Features

- **Ready before it's loaded**: clue shows the prompt first. The SDK, MCP servers and skills load while you type, and the connection to the API opens in the background.
- **Resume without the wait**: `clue -c` prints only the last screen of the conversation. While you type, clue sends the history to Claude ahead of your message, so your message reads cached history instead of processing it again.
- **A prompt Claude has already seen**: the system prompt and tool list are the same bytes in every session, so Claude caches them across sessions. Details that change, such as the working directory and git state, travel in messages.
- **A quiet transcript**: each run of tool calls shows as a short tree, one line per call. Command output, diffs and errors wait behind `ctrl+o`. tmux copy mode keeps working.
- **Your terminal knows the state**: clue reports when it is working, waiting for you, finished or failed through the [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status) (OSC 7501). Terminals without support ignore it. clue also rings the terminal bell when it needs you, and when a turn ends after 30 seconds or more without input from you.
- **Every wait on screen**: each reply ends with its total time, cost and tokens. `ctrl+o` shows the first-token time of each turn.
- **Tools for real work**: clue finds, reads and edits files, runs shell commands and dev servers, searches the web, reads URLs and hands tasks to subagents. See [Tools](#tools).
- **MCP servers**: local and remote. A server's tools cost nothing until the model needs them.
- **Three permission modes**: `auto` runs routine work and has risky actions reviewed first. See [Permissions](#permissions).
- **Your instructions**: clue reads `AGENTS.md` and `CLAUDE.md` files and loads skills when a task needs them.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/scmmishra/clue/main/install.sh | bash
```

clue runs on macOS and Linux, on arm64 and x86_64. The installer downloads the binary for your machine from the latest release, checks it against the published SHA-256 checksum, and puts it in `~/.local/bin`. Set `CLUE_INSTALL_DIR` to choose another folder, or `CLUE_VERSION` to install a specific tag. Run the same command again to update. You don't need Bun installed to run clue.

To install by hand, download `clue-<os>-<arch>` and `SHA256SUMS` from the [latest release](https://github.com/scmmishra/clue/releases/latest).

## Quick start

clue uses your Claude API credentials. It reads them in this order:

1. The `ANTHROPIC_API_KEY` environment variable.
2. The profile saved by `ant auth login`.
3. A key saved by `clue login`.

`clue login` runs `ant auth login` when the `ant` CLI is installed. Without it, `clue login` asks for an API key and stores it in the macOS Keychain or the Linux keyring. `clue logout` removes it.

Open a project and start clue:

```bash
cd your-project
clue
```

Type what you want done and press Enter. `/help` lists the slash commands.

Continue the last session in this project:

```bash
clue -c
```

Send one request without the interactive shell:

```bash
clue ask "explain the changes in this repository"
clue ask --json "summarize the failing tests" | jq -r .final_output
```

`clue ask` takes the prompt as arguments or on stdin. It writes the answer to stdout, and progress and diagnostics to stderr. It exits with a nonzero status when the request fails. `--resume <id>` continues a saved session.

## What you see

```
$ clue
clue 0.1.0 · /help for commands

┃ the conversation spec is flaky, fix it

  I'll run the spec a few times to see how it fails.

● 3 tool calls · 1 command · 1 read · 1 search
├ Ran bundle exec rspec spec/models/conversation_spec.rb
├ Read spec/models/conversation_spec.rb  180 lines
└ Searched "last_activity_at"  12 matches

  The spec compares `last_activity_at` with `Time.now`. The two
  timestamps can land in different seconds. I'll freeze time in that
  example.

● 2 tool calls · 1 edit · 1 command
├ Edited spec/models/conversation_spec.rb  +3 −1
└ Ran bundle exec rspec spec/models/conversation_spec.rb

  Fixed. The example now freezes time, and 5 runs in a row pass.

  41s · $0.21 · 48k in · 1.2k out

┃

auto · opus 5.5 · medium                      ~/code/chatwoot (main)
```

- **The header** shows clue's version.
- **The status line** under the input shows the permission mode, model, effort, folder and branch.
- **Tool calls** show as a tree under a summary line: how many calls, of which kinds, and how many failed. Each call has its own line, with line counts for edits and the error for a failed call. A run of more than 8 calls shows the last 7.
- **The footer** after each reply shows the total time, the cost, and the tokens in and out. Tokens in include cached input.
- **`ctrl+o`** opens the full detail: every command and its output, every diff, errors, timestamps, first-token time and token use per turn. Press `ctrl+o` or `escape` to close it. clue keeps working while it's open.

A reviewed action in `auto` mode shows its review on the call's line. In `ask` mode, clue stops and asks:

```
? slack.post_message
  y yes, once · a always allow slack.post_message this session · n no
```

## Models

clue starts with Claude Opus 5.5 (`claude-opus-5-5`) at `medium` effort.

| Where | Model | Effort |
| --- | --- | --- |
| For one run | `--model <id>` | `--effort <level>` |
| In a session | `/model <id>` | `/effort <level>` |
| As your default | `model` in `~/.clue/settings.json` | `effort` in `~/.clue/settings.json` |

Effort levels are `low`, `medium`, `high`, `xhigh` and `max`. Lower effort means shorter thinking and a sooner first token.

Changing the model mid-session starts a fresh cache for the rest of that session.

## Tools

| Tool | What it does |
| --- | --- |
| `glob_files` | Finds file paths that match glob patterns. |
| `grep_files` | Searches file contents. |
| `read_file` | Reads text files and images. Images larger than 1568 px are resized before they are sent. |
| `write_file` | Creates files. |
| `edit_file` | Changes existing files. It refuses to write if the file changed since the model last read it. |
| `shell` | Runs commands in your shell, inside a pseudo-terminal, so interactive programs work. `run` starts a command, `interact` reads its output or sends input, and `stop` ends it. Dev servers and watchers keep running across prompts. `stop`, and exiting clue, also end the command's child processes. |
| `web_search` | Searches the web, through Claude's server-side tool. |
| `web_fetch` | Reads a public URL, through Claude's server-side tool. |
| `subagent` | Hands a task to another agent with its own context. |
| `skill` | Reads a skill's instructions and references. |
| `install_skill` | Installs a skill. |
| `capability_search` | Finds installed skills and MCP tools, with each MCP tool's input schema. |
| `mcp_call` | Calls a tool on a connected MCP server. |
| `ask_user_question` | Asks you a question and waits for the answer. |
| `read_tool_result` | Reads a stored tool result, including results from before a compaction or a resume. |

Claude reads images directly, so `read_file` handles screenshots and diagrams.

Commands run with `AI_AGENT=clue` in their environment, so your tools can detect clue.

## MCP servers

clue reads MCP servers from two files in the standard `mcpServers` format:

| File | Scope |
| --- | --- |
| `~/.clue/mcp.json` | All projects. Trusted by default. |
| `.mcp.json` in the project root | This project only. A project server starts only after you approve it. |

```json
{
  "mcpServers": {
    "prisma": {
      "type": "http",
      "url": "https://mcp.prisma.io/mcp"
    },
    "local-tools": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  }
}
```

If both files define the same name, the entry in `~/.clue/mcp.json` wins. Set `"enabled": false` to turn a server off without removing it.

Servers start in the background, so they never delay the prompt. Their tool definitions never enter the request's tool list. The model finds them with `capability_search` and calls them with `mcp_call`. That way, adding a server doesn't change the start of the request, and the cache keeps working.

| Command | What it does |
| --- | --- |
| `/mcp add <name> <url>` | Adds a remote server. |
| `/mcp add <name> -- <command> [args]` | Adds a local server that runs over stdio. |
| `/mcp add --project ...` | Saves the server to the project's `.mcp.json`. |
| `/mcp list` | Lists servers, the file that defines each one, and their status. |
| `/mcp show <name>` | Connects and lists the server's tools. |
| `/mcp login <name>` | Signs in through the browser (OAuth). |
| `/mcp logout <name>` | Signs out. |
| `/mcp approve <name>` | Approves a project server. `--all` approves every one. |
| `/mcp reject <name>` | Keeps a project server from starting. |
| `/mcp remove <name>` | Removes a server and its saved login. |

The same commands work as `clue mcp <command>` in your terminal.

## Permissions

| Mode | Behavior |
| --- | --- |
| `ask` | clue asks before each action. |
| `auto` (default) | clue runs routine work directly and has other actions reviewed first. |
| `full-access` | clue runs every action without checks. |

In `auto` mode, clue runs these directly:

- Reading files and searching code or the web.
- Creating and editing files inside the project.
- A short list of project commands, such as `git status`, tests and builds, including chains of them joined by `&&`, `||`, `;` or `|`.

It has these reviewed first:

- Any other shell command, including one with a redirect, a substitution, a variable or a background `&`.
- Writing files outside the project.
- Changing sensitive configuration.
- Calling an MCP tool.

A review sends the exact action to a review model, which checks it for prompt injection and harmful behavior. If the reviewer finds no problem, clue runs the action. If it flags the action or can't finish the check, clue holds the action and tells the model why.

clue picks the reviewer from the keys you have:

| Key set | Reviewer |
| --- | --- |
| `OPENROUTER_API_KEY` | [Jev](https://openrouter.ai/typesafe/jev-1.14), TypeSafe's decision model, through OpenRouter. Reviewed actions go to OpenRouter. |
| No OpenRouter key | Claude Haiku 5.5 (`claude-haiku-5-5`) at `low` effort, on your Claude credentials. Reviewed actions go to Anthropic, like the rest of the conversation. |

Every review adds to your usage.

`auto` reduces risk, but it isn't a sandbox. An allowed command such as `bun test` still runs your project's code. Use a container or VM for untrusted repositories.

Switch modes with `/permissions <mode>`, `--permission-mode <mode>` for one run, or `permission_mode` in `~/.clue/settings.json`.

Allow and deny rules in `~/.clue/settings.json` skip the review. The last matching rule wins. For a shell chain, clue checks each command: a deny on one denies the chain, and an allow needs every command to match. A command clue can't parse never matches an allow rule. Deny rules also apply to read-only tools. `full-access` skips the review, but deny rules still apply.

```json
{
  "permission": {
    "*": "ask",
    "shell": { "git *": "allow", "git push *": "deny" },
    "edit_file": { "*": "deny", "docs/*": "allow" }
  }
}
```

## Sessions

clue saves each conversation as an append-only file under `~/.clue/sessions/<project>/<id>.jsonl`. Nothing is written into your repository.

| Command | What it does |
| --- | --- |
| `clue -c` | Continues the latest session in the current folder. |
| `clue -r` | Lists every past session to pick one. Sessions from the current folder come first. Type to search folders, titles and every prompt. |
| `clue -r <id>` | Continues one session by its ID. |
| `/resume` | Opens the same list from inside a session. |
| `clue ask --resume <id> ...` | Continues a session from a script. |

Each session belongs to the folder it started in. You can resume any session from anywhere, and clue always continues it in its own folder, so file paths and commands point at the same project. If that folder no longer exists, clue doesn't resume the session and tells you which folder is missing.

A small SQLite index, `~/.clue/sessions/index.db`, lists sessions and holds a full-text index of prompts for `clue -r`. The session files stay the source of truth.

A session file holds the exact messages sent to and received from Claude. clue never rewrites them. Claude requires unchanged history to continue a conversation that includes its thinking, and the cache depends on it too.

When a conversation nears the context limit, Claude's server-side compaction summarizes older turns. The full text stays in the session file, and the model can still read it with `read_tool_result`.

## Project instructions and skills

clue adds these files to the conversation when they exist:

- `AGENTS.md` and `CLAUDE.md` in the project root.
- Nested `AGENTS.md` and `CLAUDE.md` files, for the folders they cover.
- `~/.clue/AGENTS.md`, for your own instructions across projects.

Projects already set up for Claude Code work as they are.

clue loads skills from `.clue/skills`, `~/.clue/skills`, `.claude/skills` and `.agents/skills`. The model sees each skill's name and description, and reads the full instructions only when a task needs them.

## Where the time goes

| Wait | What clue does about it |
| --- | --- |
| Start | One compiled binary with precompiled bytecode, laid out from a recorded launch so the code a launch needs is read first. No UI framework. The prompt appears before anything else loads. The API connection opens in the background. |
| Resume | Bun parses the session file natively, and clue renders only the last screen, from the end. While you type, it sends the history with `max_tokens: 0`, which caches it without generating a reply. |
| First token | The start of every request is identical, so Claude reads it from cache. MCP tools load only on demand. Replies and tool inputs stream as they are generated, and Claude's progress notes show while it thinks. |

Warming the cache on resume costs a cache write even if you then quit without sending a message.

[`benchmarks/`](benchmarks/) holds the benchmark for each wait, and its README has the latest numbers. Run them with `bun run bench`.

## Configuration

| File | Purpose |
| --- | --- |
| `~/.clue/settings.json` | Model, effort, permission mode, permission rules and `bell`. Set `"bell": false` to turn the bell off. |
| `~/.clue/mcp.json` | MCP servers for all projects. |
| `.mcp.json` | MCP servers for one project. |
| `~/.clue/AGENTS.md` | Your instructions for every project. |

`CLUE_MODEL`, `CLUE_EFFORT` and `CLUE_PERMISSION_MODE` override `settings.json` for one process.

## Develop

```bash
bun install
bun run dev          # run from source
bun test             # tests, against a local stand-in for the API
bun run build        # dist/clue for this machine; --all for every platform
bun run bench        # start, resume and first-token benchmarks
bun run bench:check  # build, then fail if start or resume is over budget
bun run bench:tools  # each tool on its own, outside the agent loop
```

CI runs the type check, the tests and a build on macOS and Linux for every push and pull request. It also installs that build with `install.sh`.

### Release

The version in `package.json` is clue's only version number. `clue --version` reads it at build time.

Changes are listed in [CHANGELOG.md](CHANGELOG.md), under `## Unreleased` until they ship.

To release:

1. Rename `## Unreleased` in `CHANGELOG.md` to the new version, such as `## 0.2.0`, and add an empty `## Unreleased` above it.
2. Change the version in `package.json` to match.
3. Push both to `main`.

The release workflow then:

1. Reads the changelog section for the version. If the section is missing or empty, the release stops.
2. Runs the type check and the tests.
3. Builds the binary for each platform.
4. Creates the tag `v<version>` and a GitHub release with the binaries and `SHA256SUMS`. The changelog section becomes the release notes.

CI checks on every push that the version in `package.json` has a changelog section, so a missing entry fails before the release does.

If the tag already exists, the workflow skips the release. A change to `package.json` that keeps the version, such as a dependency update, publishes nothing.

### Prompts

The system prompt is in `prompts/system.md` and the reviewer's prompt is in `prompts/review.yaml`. Bun embeds both in the binary at build time. Tool descriptions stay in the code, next to each tool's parameters.

## Credits

clue builds on two projects:

- [pi](https://pi.dev) by Mario Zechner showed that a coding agent needs only a short prompt and a plain loop.
- [fx](https://github.com/vercel-labs/fx) by Vercel Labs shaped clue's terminal output, tool set, permission modes and MCP commands. clue's system prompt is adapted from fx's [`system_prompt.md`](https://github.com/vercel-labs/fx/blob/main/src/builtins/system_prompt.md), licensed under Apache-2.0.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

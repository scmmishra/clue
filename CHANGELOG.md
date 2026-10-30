# Changelog

All notable changes to clue are listed here. The release workflow publishes the section for the version in `package.json` as that release's notes.

## Unreleased

- `auto` mode now parses shell commands instead of matching them with a regex. A background `&`, a newline, or a program that runs other programs, such as `env`, `find` or `node`, now goes to review. The list of routine commands is shorter, so some commands that used to run directly are now reviewed.
- Allow rules, deny rules and "always allow" answers now apply to each command in a chain. Deny rules also apply to read-only tools.
- clue rings the terminal bell when it needs you, and when a turn ends after 30 seconds or more without input from you. Set `"bell": false` in `settings.json` to turn it off.
- clue tells the terminal when it is idle, working, waiting for you, finished or failed, through the Program Status Protocol (OSC 7501).
- The footer after each reply shows tokens in and out. Tokens in include cached input.
- `clue mcp add <name> -- <command>`, `clue mcp add --project` and `clue mcp approve --all` now work as they do in `/mcp`.
- A session that crashed during a tool call can continue. clue records the unfinished calls as failed before the next message.
- A half-written line in a session file no longer hides the records after it.
- A 400 from the API turns off an optional feature only when the error names that feature. A 400 that names none is reported as an error.

## 0.1.0

The first release.

- An interactive terminal agent on Claude's Messages API. It starts with Claude Opus 5.5 at medium effort.
- `clue ask` runs one request without the interactive screen. `--json` prints the result as JSON.
- Sessions are saved per project. `clue -c` resumes the last one and `clue -r` picks one. A resumed session sends its history to the cache while you type.
- Tools: read, find, search, write and edit files, shell commands with a terminal, web search, web fetch, subagents, skills and questions to the user.
- MCP servers over stdio, HTTP and SSE, with OAuth sign-in. Claude finds their tools through `capability_search`, so the tool list stays the same and stays cached.
- Permission modes `ask`, `auto` and `full-access`. In `auto`, a reviewer model checks risky actions before they run.
- Sign in with `ant auth login`, or store an API key with `clue login`.
- A single binary for macOS and Linux, on arm64 and x86_64, installed with `install.sh`. It starts in about 7 ms.

---
title: Tools
---

The model chooses these tools itself. [Permissions](/docs/permissions) decide which calls run.

| Tool | What it does |
| --- | --- |
| `glob_files` | Finds file paths that match a pattern. |
| `grep_files` | Searches file contents. The pattern is a regular expression. If it is invalid or finds nothing, clue searches for the same text literally. |
| `read_file` | Reads text files and images. |
| `write_file` | Creates a file, or replaces one it has read. |
| `edit_file` | Changes one or more parts of a file. If one change fails, the file stays as it was. |
| `shell` | Runs commands in your shell. Dev servers keep running across prompts. |
| `web_search` | Searches the web. |
| `web_fetch` | Reads a public URL. |
| `subagent` | Hands a task to another agent with its own context. The agent uses your model and effort, unless Claude sets a different model or effort for it, such as Haiku for a simple search. |
| `skill` | Reads a skill's instructions. |
| `install_skill` | Installs a skill. |
| `capability_search` | Finds installed skills and MCP tools. |
| `mcp_call` | Calls a tool on an MCP server. |
| `ask_user_question` | Asks you a question and waits. |
| `read_tool_result` | Reads the full output of an earlier tool call. |

Commands run with `AI_AGENT=clue` in their environment, so your tools can detect clue.

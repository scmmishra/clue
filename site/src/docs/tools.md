---
title: Tools
---

The model chooses these tools itself. [Permissions](/docs/permissions) decide which calls run.

| Tool | What it does |
| --- | --- |
| `glob_files` | Finds file paths that match a pattern. |
| `grep_files` | Searches file contents. |
| `read_file` | Reads text files and images. |
| `write_file` | Creates a file, or replaces one it has read. |
| `edit_file` | Changes part of a file. It refuses if the file changed since the last read. |
| `shell` | Runs commands in your shell. Dev servers keep running across prompts. |
| `web_search` | Searches the web. |
| `web_fetch` | Reads a public URL. |
| `subagent` | Hands a task to another agent with its own context. |
| `skill` | Reads a skill's instructions. |
| `install_skill` | Installs a skill. |
| `capability_search` | Finds installed skills and MCP tools. |
| `mcp_call` | Calls a tool on an MCP server. |
| `ask_user_question` | Asks you a question and waits. |
| `read_tool_result` | Reads the full output of an earlier tool call. |

Commands run with `AI_AGENT=clue` in their environment, so your tools can detect clue.

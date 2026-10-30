---
title: MCP servers
---

MCP servers give clue more tools. Servers start in the background, so they never delay the prompt.

## Add a server

```bash
clue mcp add docs https://example.com/mcp
clue mcp add local -- npx -y some-mcp-server
clue mcp add --project tools https://example.com/mcp
```

Each command also works inside clue as `/mcp add`.

## Config files

Servers are stored in `~/.clue/mcp.json`, or in `.mcp.json` for one project. If both define a name, `~/.clue/mcp.json` wins.

```json
{
  "mcpServers": {
    "docs": { "type": "http", "url": "https://example.com/mcp" },
    "local": { "command": "npx", "args": ["-y", "some-mcp-server"] }
  }
}
```

Set `"enabled": false` to turn a server off without removing it.

## Manage servers

| Command | What it does |
| --- | --- |
| `/mcp list` | Lists servers and their status. |
| `/mcp show <name>` | Lists a server's tools. |
| `/mcp login <name>` | Signs in through the browser. |
| `/mcp logout <name>` | Signs out. |
| `/mcp approve <name>` | Approves a project server. `--all` approves every one. |
| `/mcp reject <name>` | Keeps a project server from starting. |
| `/mcp remove <name>` | Removes a server and its login. |

A project server starts only after you approve it.

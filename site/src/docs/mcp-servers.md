---
title: MCP servers
---

MCP servers give clue more tools. Servers start in the background, so they never delay the prompt.

## Add a server

```bash
clue mcp add docs https://example.com/mcp
clue mcp add local -- npx -y some-mcp-server
clue mcp add --project tools https://example.com/mcp
clue mcp add --env API_KEY=secret local -- npx -y some-mcp-server
```

Each command also works inside clue as `/mcp add`.

`--env KEY=VALUE` sets an environment variable for a local server. Repeat it for more variables. Put it before the server name, and after `--project` if you use both. A local server also gets clue's own environment, and starts in the project folder.

## Config files

Servers are stored in `~/.clue/mcp.json`, or in `.mcp.json` for one project. If both define a name, `~/.clue/mcp.json` wins.

```json
{
  "mcpServers": {
    "docs": { "type": "http", "url": "https://example.com/mcp" },
    "events": { "type": "sse", "url": "https://example.com/sse" },
    "tickets": {
      "url": "https://example.com/mcp",
      "headers": { "X-Team": "support" },
      "bearer_token_env": "TICKETS_TOKEN"
    },
    "local": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "API_KEY": "secret" }
    }
  }
}
```

| Field | What it does |
| --- | --- |
| `type` | `http`, `sse` or `stdio`. Without it, a server with a `url` uses `http`, and a server with a `command` uses `stdio`. |
| `url` | The address of a remote server. |
| `headers` | Headers that clue sends with each request to a remote server. |
| `bearer_token_env` | The name of an environment variable that holds a token. clue sends the token as `Authorization: Bearer <token>`, and doesn't offer browser sign-in for that server. |
| `command`, `args` | The program that runs a local server, and its arguments. |
| `env` | Environment variables for a local server. |
| `enabled` | Set it to `false` to turn a server off without removing it. |

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

Servers keep running across `/new` and `/resume` in the same folder. clue reads a change you make to `.mcp.json` by hand at the next launch, or after a `/mcp` command that changes a server.

A project server starts only after you approve it. An approval covers the server's config as it was when you approved it. If `.mcp.json` changes that server, for example after a `git pull`, clue asks you to approve it again.

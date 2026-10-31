import { paths } from "../config";
import {
  loadServers,
  projectMcpFile,
  removeServer,
  saveServer,
  setApproval,
  transportOf,
  type ServerConfig,
} from "../mcp/config";
import { forgetLogin, McpManager } from "../mcp/manager";
import { homePath, style } from "../ui/ansi";

const STATUS_STYLE: Record<string, (text: string) => string> = {
  ready: style.green,
  starting: style.accent,
  failed: style.red,
  "needs-login": style.orange,
  "needs-approval": style.orange,
  rejected: style.faint,
  disabled: style.faint,
};

export const MCP_USAGE = [
  "/mcp add <name> <url>                 add a remote server",
  "/mcp add <name> -- <command> [args]   add a local server over stdio",
  "/mcp add --project ...                save to the project's .mcp.json",
  "/mcp list                             servers and their status",
  "/mcp show <name>                      connect and list its tools",
  "/mcp login <name> · logout <name>     browser sign-in",
  "/mcp approve <name>|--all · reject    project servers",
  "/mcp remove <name>                    remove a server and its login",
];

// Runs one /mcp (or `clue mcp`) command. Prints through `print`.
export async function mcpCommand(args: string[], cwd: string, manager: McpManager, print: (lines: string[]) => void) {
  const [sub, ...rest] = args;
  const line = (text: string) => `  ${text}`;
  switch (sub ?? "list") {
    case "list": {
      const entries = loadServers(cwd);
      if (entries.length === 0) {
        print([line(style.muted("No MCP servers. Add one with /mcp add <name> <url>.")), ""]);
        return;
      }
      await manager.settle(3000);
      const lines = entries.map((entry) => {
        const state = manager.servers.get(entry.name);
        const status = state?.status ?? "disabled";
        const color = STATUS_STYLE[status] ?? style.muted;
        const where = entry.scope === "project" ? ".mcp.json" : homePath(paths.mcp);
        const tools =
          state?.status === "ready"
            ? style.faint(`${state.tools.length} tools`)
            : state?.error
              ? style.faint(state.error)
              : "";
        return line(
          `${style.bold(entry.name)}  ${color(status)}  ${style.faint(`${transportOf(entry.config)} · ${where}`)}  ${tools}`,
        );
      });
      print([...lines, ""]);
      return;
    }
    case "add": {
      const project = rest[0] === "--project";
      const parts = project ? rest.slice(1) : rest;
      const env: Record<string, string> = {};
      while (parts[0] === "--env" && parts[1]?.includes("=")) {
        const [key, ...value] = parts[1].split("=");
        env[key] = value.join("=");
        parts.splice(0, 2);
      }
      const [name, ...spec] = parts;
      if (!name || spec.length === 0) {
        print([line(style.red("Usage: /mcp add <name> <url>  or  /mcp add <name> -- <command> [args]")), ""]);
        return;
      }
      let config: ServerConfig;
      if (spec[0] === "--") {
        const [command, ...commandArgs] = spec.slice(1);
        if (!command) {
          print([line(style.red("Give the command after --.")), ""]);
          return;
        }
        config = { command, args: commandArgs, ...(Object.keys(env).length ? { env } : {}) };
      } else config = { type: "http", url: spec[0] };
      const file = project ? projectMcpFile(cwd) : paths.mcp;
      try {
        saveServer(file, name, config);
        if (project) setApproval(cwd, name, "approved");
      } catch (error) {
        print([line(style.red((error as Error).message)), ""]);
        return;
      }
      await manager.reload();
      print([line(`${style.green("Added")} ${style.bold(name)} to ${homePath(file)}.`), ""]);
      return;
    }
    case "remove": {
      const name = rest[0];
      const entry = loadServers(cwd).find((item) => item.name === name);
      if (!entry) {
        print([line(style.red(`No server named ${name}.`)), ""]);
        return;
      }
      removeServer(entry.file, entry.name);
      forgetLogin(entry.name);
      await manager.reload();
      print([line(`Removed ${style.bold(entry.name)}.`), ""]);
      return;
    }
    case "approve":
    case "reject": {
      const all = rest[0] === "--all";
      const targets = loadServers(cwd).filter((entry) => entry.scope === "project" && (all || entry.name === rest[0]));
      if (targets.length === 0) {
        print([line(style.red(all ? "No project servers." : `No project server named ${rest[0]}.`)), ""]);
        return;
      }
      for (const entry of targets) setApproval(cwd, entry.name, sub === "approve" ? "approved" : "rejected");
      await manager.reload();
      print([
        line(
          `${sub === "approve" ? "Approved" : "Rejected"} ${targets.map((entry) => style.bold(entry.name)).join(", ")}.`,
        ),
        "",
      ]);
      return;
    }
    case "show": {
      const name = rest[0];
      await manager.settle(8000);
      const state = manager.servers.get(name);
      if (!state) {
        print([line(style.red(`No server named ${name}.`)), ""]);
        return;
      }
      if (state.status !== "ready") {
        print([line(`${style.bold(name)} is ${state.status}${state.error ? `: ${state.error}` : ""}.`), ""]);
        return;
      }
      print([
        line(`${style.bold(name)}  ${style.green("ready")}  ${style.faint(`${state.tools.length} tools`)}`),
        ...state.tools.map((tool) =>
          line(`  ${style.accent(tool.name)}  ${style.faint(tool.description.split("\n")[0].slice(0, 100))}`),
        ),
        "",
      ]);
      return;
    }
    case "login": {
      try {
        await manager.login(rest[0], (text) => print([line(style.muted(text))]));
        print([line(`${style.green("Signed in")} to ${style.bold(rest[0])}.`), ""]);
      } catch (error) {
        print([line(style.red((error as Error).message)), ""]);
      }
      return;
    }
    case "logout": {
      forgetLogin(rest[0]);
      await manager.reload();
      print([line(`Signed out of ${style.bold(rest[0])}.`), ""]);
      return;
    }
    default:
      print([...MCP_USAGE.map((text) => line(style.muted(text))), ""]);
  }
}

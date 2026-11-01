import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLUE_HOME, ensureDir, paths, readJson } from "../config";

export type ServerConfig = {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  bearer_token_env?: string;
  enabled?: boolean;
};

export type ServerEntry = { name: string; config: ServerConfig; scope: "profile" | "project"; file: string };

type McpFile = { mcpServers?: Record<string, ServerConfig> };

export const projectMcpFile = (cwd: string) => join(cwd, ".mcp.json");

// Profile servers win over project servers with the same name.
export function loadServers(cwd: string): ServerEntry[] {
  const entries = new Map<string, ServerEntry>();
  const project = readJson<McpFile>(projectMcpFile(cwd), {});
  for (const [name, config] of Object.entries(project.mcpServers ?? {})) {
    entries.set(name, { name, config, scope: "project", file: projectMcpFile(cwd) });
  }
  const profile = readJson<McpFile>(paths.mcp, {});
  for (const [name, config] of Object.entries(profile.mcpServers ?? {})) {
    entries.set(name, { name, config, scope: "profile", file: paths.mcp });
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const transportOf = (config: ServerConfig) => config.type ?? (config.url ? "http" : "stdio");

export function saveServer(file: string, name: string, config: ServerConfig) {
  const data = readJson<McpFile>(file, {});
  data.mcpServers ??= {};
  if (data.mcpServers[name]) throw new Error(`${name} already exists in ${file}.`);
  data.mcpServers[name] = config;
  if (file === paths.mcp) ensureDir(CLUE_HOME);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function removeServer(file: string, name: string) {
  const data = readJson<McpFile>(file, {});
  if (!data.mcpServers?.[name]) return false;
  delete data.mcpServers[name];
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return true;
}

// Project servers start only after the user approves them, per project folder. An approval
// covers one config: "approved:<hash>". When .mcp.json changes the server, such as after a
// git pull, it needs approval again. A plain "approved" from an older clue counts as none.
type Approval = "rejected" | `approved:${string}`;
type Approvals = Record<string, Record<string, Approval | "approved">>;
type Approvable = Pick<ServerEntry, "name" | "config">;

const configHash = (config: ServerConfig) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);

export function approvalOf(cwd: string, entry: Approvable): "approved" | "rejected" | null {
  const saved = readJson<Approvals>(paths.approvals, {})[cwd]?.[entry.name];
  if (saved === "rejected") return "rejected";
  return saved === `approved:${configHash(entry.config)}` ? "approved" : null;
}

export function setApproval(cwd: string, entry: Approvable, value: "approved" | "rejected") {
  ensureDir(CLUE_HOME);
  const approvals = readJson<Approvals>(paths.approvals, {});
  approvals[cwd] ??= {};
  approvals[cwd][entry.name] = value === "approved" ? `approved:${configHash(entry.config)}` : "rejected";
  writeFileSync(paths.approvals, `${JSON.stringify(approvals, null, 2)}\n`);
}

export const hasProjectMcp = (cwd: string) => existsSync(projectMcpFile(cwd));

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

// Project servers start only after the user approves them, per project folder.
type Approvals = Record<string, Record<string, "approved" | "rejected">>;

export function approvalOf(cwd: string, name: string) {
  return readJson<Approvals>(paths.approvals, {})[cwd]?.[name] ?? null;
}

export function setApproval(cwd: string, name: string, value: "approved" | "rejected") {
  ensureDir(CLUE_HOME);
  const approvals = readJson<Approvals>(paths.approvals, {});
  approvals[cwd] ??= {};
  approvals[cwd][name] = value;
  writeFileSync(paths.approvals, `${JSON.stringify(approvals, null, 2)}\n`);
}

export const hasProjectMcp = (cwd: string) => existsSync(projectMcpFile(cwd));

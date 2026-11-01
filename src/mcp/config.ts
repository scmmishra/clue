import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLUE_HOME, ensureDir, paths, readJson, readJsonForWriting, writeJsonFile } from "../config";

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
  const data = readJsonForWriting(file) as McpFile;
  data.mcpServers ??= {};
  if (data.mcpServers[name]) throw new Error(`${name} already exists in ${file}.`);
  data.mcpServers[name] = config;
  if (file === paths.mcp) ensureDir(CLUE_HOME);
  writeJsonFile(file, data);
}

export function removeServer(file: string, name: string) {
  const data = readJsonForWriting(file) as McpFile;
  if (!data.mcpServers?.[name]) return false;
  delete data.mcpServers[name];
  writeJsonFile(file, data);
  return true;
}

// Project servers start only after the user approves them, per project folder. An approval
// holds a hash of what the server runs, because the repository can change that later.
type Approvals = Record<string, Record<string, string>>;

const REJECTED = "rejected";

const sorted = (values?: Record<string, string>) => values && Object.entries(values).sort();

function configHash({ type, command, args, env, url, headers, bearer_token_env }: ServerConfig) {
  const facts = [type, command, args, sorted(env), url, sorted(headers), bearer_token_env];
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(facts)).digest("hex");
}

// null means it needs approval. So does an approval of a different config.
export function approvalOf(cwd: string, name: string, config: ServerConfig) {
  const stored = readJson<Approvals>(paths.approvals, {})[cwd]?.[name];
  if (stored === REJECTED) return "rejected";
  return stored === configHash(config) ? "approved" : null;
}

export function setApproval(cwd: string, name: string, value: "approved" | "rejected", config: ServerConfig) {
  ensureDir(CLUE_HOME);
  const approvals = readJsonForWriting(paths.approvals) as Approvals;
  approvals[cwd] ??= {};
  approvals[cwd][name] = value === "approved" ? configHash(config) : REJECTED;
  writeJsonFile(paths.approvals, approvals);
}

export const hasProjectMcp = (cwd: string) => existsSync(projectMcpFile(cwd));

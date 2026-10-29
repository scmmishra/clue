import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";

export const CLUE_HOME = process.env.CLUE_HOME ?? join(homedir(), ".clue");

export const paths = {
  settings: join(CLUE_HOME, "settings.json"),
  mcp: join(CLUE_HOME, "mcp.json"),
  approvals: join(CLUE_HOME, "mcp-approvals.json"),
  mcpAuth: join(CLUE_HOME, "mcp-auth"),
  sessions: join(CLUE_HOME, "sessions"),
  sessionIndex: join(CLUE_HOME, "sessions", "index.db"),
  history: join(CLUE_HOME, "history"),
  credentials: join(CLUE_HOME, "credentials"),
  skills: join(CLUE_HOME, "skills"),
  agents: join(CLUE_HOME, "AGENTS.md"),
};

export function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const PERMISSION_MODES = ["ask", "auto", "full-access"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type RuleValue = "allow" | "deny" | "ask";
export type PermissionRules = Record<string, RuleValue | Record<string, RuleValue>>;

export type Settings = {
  model: string;
  effort: Effort;
  permission_mode: PermissionMode;
  permission: PermissionRules;
  review_model: string;
};

const DEFAULTS: Settings = {
  model: "claude-opus-5-5",
  effort: "medium",
  permission_mode: "auto",
  permission: {},
  review_model: "typesafe/jev-1.14",
};

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// settings.json, then CLUE_* environment variables, then command-line flags.
export function loadSettings(flags: Partial<Settings> = {}): Settings {
  const file = readJson<Partial<Settings>>(paths.settings, {});
  const env: Partial<Settings> = {};
  if (process.env.CLUE_MODEL) env.model = process.env.CLUE_MODEL;
  if (process.env.CLUE_EFFORT) env.effort = process.env.CLUE_EFFORT as Effort;
  if (process.env.CLUE_PERMISSION_MODE) env.permission_mode = process.env.CLUE_PERMISSION_MODE as PermissionMode;
  const merged = { ...DEFAULTS, ...file, ...env, ...stripUndefined(flags) };
  if (!EFFORTS.includes(merged.effort)) merged.effort = DEFAULTS.effort;
  if (!PERMISSION_MODES.includes(merged.permission_mode)) merged.permission_mode = DEFAULTS.permission_mode;
  return merged;
}

const stripUndefined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

export async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  ensureDir(CLUE_HOME);
  const file = readJson<Partial<Settings>>(paths.settings, {});
  file[key] = value;
  await Bun.write(paths.settings, `${JSON.stringify(file, null, 2)}\n`);
}

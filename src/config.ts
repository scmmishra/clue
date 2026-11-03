import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// package.json is the one place the version is set. The release workflow publishes when it changes.
import { version } from "../package.json" with { type: "json" };
import { COMPACT_AT_PERCENT, MAX_COMPACT_PERCENT, MIN_COMPACT_AT, MIN_COMPACT_PERCENT } from "./agent/models";

export const VERSION = version;

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

export const RULE_VALUES = ["allow", "ask", "deny"] as const;
export type RuleValue = (typeof RULE_VALUES)[number];
export type PermissionRules = Record<string, RuleValue | Record<string, RuleValue>>;
export const isRuleValue = (value: unknown): value is RuleValue => RULE_VALUES.includes(value as RuleValue);

// The tools a rule can name, and "*" for all of them. A test keeps this in step with TOOLS,
// which can't be imported here: the tools import this file.
const RULE_TOOLS = [
  "*",
  "glob_files",
  "grep_files",
  "read_file",
  "write_file",
  "edit_file",
  "shell",
  "subagent",
  "skill",
  "install_skill",
  "capability_search",
  "mcp_call",
  "ask_user_question",
  "read_tool_result",
];

// The model behind a helper, such as the auto-mode reviewer. Both keys are optional.
export type HelperSetting = { provider?: string; model?: string };

export type Settings = {
  model: string;
  effort: Effort;
  fast: boolean;
  permission_mode: PermissionMode;
  permission: PermissionRules;
  // Who reviews actions in auto mode.
  review?: HelperSetting;
  // Who picks the parts of a reply that /copy <request> copies.
  copy?: HelperSetting;
  // When clue compacts the conversation: a token count, or a share of the model's context
  // window such as "30%". Each model has its own default.
  compact_at?: number | string;
  bell: boolean;
};

const DEFAULTS: Settings = {
  model: "claude-opus-5-5",
  effort: "medium",
  fast: false,
  permission_mode: "auto",
  permission: {},
  bell: true,
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

const HELPER_PROVIDERS = ["anthropic", "openrouter"];
const HELPERS = ["review", "copy"];
// A JSON object, such as settings.json or a group of settings in it.
export type JsonObject = { [key: string]: unknown };
export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = (options: readonly string[]) => (value: unknown) =>
  options.includes(value as string) ? null : `must be one of ${options.join(", ")}`;
const aString = (value: unknown) => (typeof value === "string" ? null : "must be a string");
const anObject = (value: unknown) => (isObject(value) ? null : "must be an object");

const aBoolean = (value: unknown) => (typeof value === "boolean" ? null : "must be true or false");

// A token count, or a share of the context window from 5% to 85%. The forms and the minimum come
// from models.ts, which reads the setting.
const aCompactionPoint = (value: unknown) => {
  if (typeof value === "number")
    return Number.isInteger(value) && value >= MIN_COMPACT_AT ? null : `must be at least ${MIN_COMPACT_AT}`;
  const share = typeof value === "string" ? COMPACT_AT_PERCENT.exec(value.trim()) : null;
  if (share && Number(share[1]) >= MIN_COMPACT_PERCENT && Number(share[1]) <= MAX_COMPACT_PERCENT) return null;
  return `must be a token count such as 300000, or a share of the context window from "${MIN_COMPACT_PERCENT}%" to "${MAX_COMPACT_PERCENT}%"`;
};

const SETTING_CHECKS = new Map<string, (value: unknown) => string | null>([
  ["model", aString],
  ["effort", oneOf(EFFORTS)],
  ["fast", aBoolean],
  ["permission_mode", oneOf(PERMISSION_MODES)],
  ["permission", anObject],
  ["compact_at", aCompactionPoint],
  ["bell", aBoolean],
  ...HELPERS.flatMap((helper): [string, (value: unknown) => string | null][] => [
    [helper, anObject],
    [`${helper}.provider`, oneOf(HELPER_PROVIDERS)],
    [`${helper}.model`, aString],
  ]),
]);

export const isSetting = (key: string) => SETTING_CHECKS.has(key);

// What's wrong with one setting, or null.
export function checkSetting(key: string, value: unknown) {
  if (key === "review_model") return "review_model was replaced by review";
  const check = SETTING_CHECKS.get(key);
  if (!check) return `${key} isn't a setting`;
  const problem = check(value);
  return problem && `${key} ${problem}`;
}

// What's wrong with the text of settings.json. loadSettings ignores a file it can't read,
// and that silently drops the user's deny rules, so startup warns about it.
export function settingsProblems(text: string): string[] {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return ["settings.json isn't valid JSON, so clue is using its defaults and your permission rules are off"];
  }
  if (!isObject(settings)) return ["settings.json must be a JSON object"];
  const problems = Object.entries(settings).flatMap(([key, value]) => checkSetting(key, value) ?? []);
  for (const helper of HELPERS) {
    const setting = settings[helper];
    if (isObject(setting))
      problems.push(
        ...Object.entries(setting).flatMap(([key, value]) => checkSetting(`${helper}.${key}`, value) ?? []),
      );
  }
  if (isObject(settings.permission)) problems.push(...ruleProblems(settings.permission));
  return problems;
}

// A rule that names no tool or has a mistyped value matches nothing, so a deny would
// silently stop working.
function ruleProblems(permission: JsonObject) {
  const values = RULE_VALUES.join(", ");
  return Object.entries(permission).flatMap(([tool, rule]) => {
    const problems = RULE_TOOLS.includes(tool) ? [] : [`permission.${tool} isn't a tool`];
    if (isObject(rule)) {
      for (const [pattern, value] of Object.entries(rule))
        if (!isRuleValue(value))
          problems.push(`permission.${tool} ${JSON.stringify(pattern)} must be one of ${values}`);
    } else if (!isRuleValue(rule))
      problems.push(`permission.${tool} must be one of ${values}, or an object of patterns`);
    return problems;
  });
}

// The problems with the file on disk, as warnings for startup.
export function settingsWarnings() {
  if (!existsSync(paths.settings)) return [];
  return settingsProblems(readFileSync(paths.settings, "utf8")).map(
    (problem) => `${problem}. Fix it with clue config edit.`,
  );
}

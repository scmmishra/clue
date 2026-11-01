import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// package.json is the one place the version is set. The release workflow publishes when it changes.
import { version } from "../package.json" with { type: "json" };

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
export const isRuleValue = (value: unknown): value is RuleValue => RULE_VALUES.includes(value as RuleValue);

// The tool names a permission rule can use. Importing the tools here would load every tool
// at startup, so test/config.test.ts checks that this list matches them.
export const TOOL_NAMES = [
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
export type PermissionRules = Record<string, RuleValue | Record<string, RuleValue>>;

// Who reviews actions in auto mode. Both keys are optional.
export type ReviewSetting = { provider?: string; model?: string };

export type Settings = {
  model: string;
  effort: Effort;
  fast: boolean;
  permission_mode: PermissionMode;
  permission: PermissionRules;
  review?: ReviewSetting;
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

// The settings an environment variable can set.
export const ENV_SETTINGS: Record<string, string> = {
  model: "CLUE_MODEL",
  effort: "CLUE_EFFORT",
  permission_mode: "CLUE_PERMISSION_MODE",
};

// settings.json, then CLUE_* environment variables, then command-line flags.
export function loadSettings(flags: Partial<Settings> = {}): Settings {
  const file = readJson<Partial<Settings>>(paths.settings, {});
  const env: Partial<Settings> = {};
  for (const [key, name] of Object.entries(ENV_SETTINGS)) {
    if (process.env[name]) Object.assign(env, { [key]: process.env[name] });
  }
  const merged = { ...DEFAULTS, ...file, ...env, ...stripUndefined(flags) };
  if (!EFFORTS.includes(merged.effort)) merged.effort = DEFAULTS.effort;
  if (!PERMISSION_MODES.includes(merged.permission_mode)) merged.permission_mode = DEFAULTS.permission_mode;
  return merged;
}

// A JSON file about to be changed and written back. It throws on a file that exists and
// can't be read, because writing back from an empty result would destroy that file.
export function readJsonForWriting(path: string): JsonObject {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} isn't valid JSON. Fix it and try again.`);
  }
  if (!isObject(parsed)) throw new Error(`${path} isn't a JSON object. Fix it and try again.`);
  return parsed;
}

// A rename, so a crash can't leave half a file. The file keeps its mode. The temporary name is
// random and `wx` refuses an existing path, because a repository can ship a link at a fixed name.
export function writeJsonFile(path: string, value: object) {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
  const temporary = `${path}.${crypto.randomUUID()}.new`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
  renameSync(temporary, path);
}

const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY"];

// An environment for code clue runs. Project code and MCP servers have no need for clue's keys.
export function withoutProviderKeys(env: Record<string, string | undefined>) {
  const rest = { ...env };
  for (const key of PROVIDER_KEYS) delete rest[key];
  return rest as Record<string, string>;
}

const stripUndefined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

const REVIEW_PROVIDERS = ["anthropic", "openrouter"];
// A JSON object, such as settings.json or a group of settings in it.
export type JsonObject = { [key: string]: unknown };
export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = (options: readonly string[]) => (value: unknown) =>
  options.includes(value as string) ? null : `must be one of ${options.join(", ")}`;
const aString = (value: unknown) => (typeof value === "string" ? null : "must be a string");
const anObject = (value: unknown) => (isObject(value) ? null : "must be an object");

const aBoolean = (value: unknown) => (typeof value === "boolean" ? null : "must be true or false");

const SETTING_CHECKS = new Map<string, (value: unknown) => string | null>([
  ["model", aString],
  ["effort", oneOf(EFFORTS)],
  ["fast", aBoolean],
  ["permission_mode", oneOf(PERMISSION_MODES)],
  ["bell", aBoolean],
  ["review", anObject],
  ["review.provider", oneOf(REVIEW_PROVIDERS)],
  ["review.model", aString],
  ["permission", anObject],
]);

// What `clue config show` lists. `review` shows through its two keys.
export const SHOWN_SETTINGS = [...SETTING_CHECKS.keys()].filter((key) => key !== "review");

export const isBooleanSetting = (key: string) => SETTING_CHECKS.get(key) === aBoolean;

export const isSetting = (key: string) => SETTING_CHECKS.has(key);

// What's wrong with one setting, or null.
export function checkSetting(key: string, value: unknown) {
  if (key === "review_model") return "review_model was replaced by review";
  const check = SETTING_CHECKS.get(key);
  if (!check) return `${key} isn't a setting`;
  const problem = check(value);
  return problem && `${key} ${problem}`;
}

const RULE_VALUE_HELP = `must be ${RULE_VALUES.slice(0, -1).join(", ")} or ${RULE_VALUES.at(-1)}`;

// A rule with a value other than allow, ask or deny does nothing, and a mistyped deny is easy to miss.
function permissionProblems(permission: JsonObject) {
  const problems: string[] = [];
  for (const [tool, value] of Object.entries(permission)) {
    if (tool !== "*" && !TOOL_NAMES.includes(tool))
      problems.push(`permission.${tool} isn't a tool name or *. Tool names: ${TOOL_NAMES.join(", ")}`);
    if (isObject(value)) {
      for (const [pattern, ruleValue] of Object.entries(value)) {
        if (!isRuleValue(ruleValue))
          problems.push(
            `permission.${tool} ${JSON.stringify(pattern)} is ${JSON.stringify(ruleValue)}, which ${RULE_VALUE_HELP}`,
          );
      }
    } else if (!isRuleValue(value)) {
      problems.push(
        `permission.${tool} is ${JSON.stringify(value)}, which ${RULE_VALUE_HELP}, or an object of patterns`,
      );
    }
  }
  return problems;
}

// A CLUE_PERMISSION_MODE that isn't a mode. loadSettings would run it as auto, which is looser
// than a mistyped ask, so clue stops instead.
export function permissionModeEnvProblem() {
  const mode = process.env.CLUE_PERMISSION_MODE;
  if (!mode || PERMISSION_MODES.includes(mode as PermissionMode)) return null;
  return `CLUE_PERMISSION_MODE must be one of ${PERMISSION_MODES.join(", ")}`;
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
  if (isObject(settings.review)) {
    problems.push(
      ...Object.entries(settings.review).flatMap(([key, value]) => checkSetting(`review.${key}`, value) ?? []),
    );
  }
  if (isObject(settings.permission)) problems.push(...permissionProblems(settings.permission));
  return problems;
}

// MCP files that can't be read. clue starts without their servers, so this is the only sign of it.
export function mcpFileProblems(cwd: string) {
  return [paths.mcp, join(cwd, ".mcp.json"), paths.approvals].flatMap((file) => {
    try {
      readJsonForWriting(file);
      return [];
    } catch (error) {
      return [(error as Error).message];
    }
  });
}

// The problems with the files on disk, as warnings for startup.
export function settingsWarnings() {
  const settings = existsSync(paths.settings)
    ? settingsProblems(readFileSync(paths.settings, "utf8")).map(
        (problem) => `${problem}. Fix it with clue config edit.`,
      )
    : [];
  return [...settings, ...mcpFileProblems(process.cwd())];
}

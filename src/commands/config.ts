import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { checkSetting, isSetting, loadSettings, paths, readJson, settingsProblems } from "../config";

const USAGE = `Usage:
  clue config show [--json]         the settings in use, and where each comes from
  clue config path                  the path of settings.json
  clue config edit [editor]         open settings.json, then check it
  clue config set <key> <value>     change one setting
  clue config unset <key>           go back to the default`;

const SHOWN = ["model", "effort", "permission_mode", "bell", "review.provider", "review.model", "permission"];
const ENV: Record<string, string> = {
  model: "CLUE_MODEL",
  effort: "CLUE_EFFORT",
  permission_mode: "CLUE_PERMISSION_MODE",
};
// `set` handles single values. These hold nested rules, which order and shape matter for.
const EDIT_ONLY = new Set(["permission", "review"]);

function stop(message: string, code = 2): never {
  process.stderr.write(`clue: ${message}\n`);
  process.exit(code);
}

const valueAt = (settings: object, key: string) => key.split(".").reduce<any>((value, part) => value?.[part], settings);

function sourceOf(key: string, value: unknown, file: object) {
  const env = ENV[key];
  if (env && process.env[env] === value) return env;
  const saved = valueAt(file, key);
  return saved !== undefined && JSON.stringify(saved) === JSON.stringify(value) ? "settings.json" : "default";
}

function displayed(key: string, value: unknown) {
  if (value === null) return "automatic";
  if (key === "permission") return Object.keys(value as object).length ? "rules set" : "none";
  return String(value);
}

function show(json: boolean) {
  const file = readJson<object>(paths.settings, {});
  const settings = loadSettings();
  const rows = SHOWN.map((key) => {
    const value = valueAt(settings, key) ?? null;
    return { key, value, source: sourceOf(key, value, file) };
  });
  const problems = fileProblems();
  if (json) {
    const shown = Object.fromEntries(rows.map(({ key, value, source }) => [key, { value, source }]));
    return console.log(JSON.stringify({ path: paths.settings, settings: shown, problems }, null, 2));
  }
  const keyWidth = Math.max(...rows.map(({ key }) => key.length));
  const valueWidth = Math.max(...rows.map(({ key, value }) => displayed(key, value).length));
  for (const { key, value, source } of rows)
    console.log(`${key.padEnd(keyWidth)}  ${displayed(key, value).padEnd(valueWidth)}  ${source}`);
  for (const problem of problems) process.stderr.write(`clue: ${problem}\n`);
}

const fileProblems = () => (existsSync(paths.settings) ? settingsProblems(readFileSync(paths.settings, "utf8")) : []);

// The file as an object. A file that can't be read is left alone, so nothing overwrites it.
function readForWriting() {
  if (!existsSync(paths.settings)) return {};
  try {
    return JSON.parse(readFileSync(paths.settings, "utf8")) as Record<string, any>;
  } catch {
    stop("settings.json isn't valid JSON. Fix it with clue config edit.");
  }
}

function write(settings: object) {
  mkdirSync(dirname(paths.settings), { recursive: true });
  // A rename, so a crash can't leave half a settings file.
  writeFileSync(`${paths.settings}.new`, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(`${paths.settings}.new`, paths.settings);
}

function set(args: string[]) {
  if (args.length !== 2) stop(`Usage: clue config set <key> <value>`);
  const [key, text] = args;
  if (EDIT_ONLY.has(key)) stop(`${key} holds nested settings. Use clue config edit.`);
  const value = key === "bell" && (text === "true" || text === "false") ? text === "true" : text;
  const problem = checkSetting(key, value);
  if (problem) stop(problem);
  const settings = readForWriting();
  const parts = key.split(".");
  const parent = parts.slice(0, -1).reduce((object, part) => (object[part] ??= {}), settings);
  parent[parts.at(-1)!] = value;
  write(settings);
  console.log(`Set ${key} to ${text}.`);
}

function unset(args: string[]) {
  if (args.length !== 1) stop("Usage: clue config unset <key>");
  const [key] = args;
  // review_model is gone, but an old file can still hold it.
  if (!isSetting(key) && key !== "review_model") stop(`${key} isn't a setting`);
  const settings = readForWriting();
  if (valueAt(settings, key) === undefined) return console.log(`${key} isn't set.`);
  const [first, second] = key.split(".");
  if (second === undefined) delete settings[first];
  else {
    delete settings[first][second];
    if (Object.keys(settings[first]).length === 0) delete settings[first];
  }
  write(settings);
  console.log(`Unset ${key}.`);
}

async function edit(chosen?: string) {
  const editor = chosen ?? process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  if (!existsSync(paths.settings)) {
    mkdirSync(dirname(paths.settings), { recursive: true });
    writeFileSync(paths.settings, "{}\n");
  }
  let code: number;
  try {
    const proc = Bun.spawn([...editor.trim().split(/\s+/), paths.settings], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    code = await proc.exited;
  } catch {
    stop(`Could not open ${editor}.`, 1);
  }
  if (code !== 0) stop(`${editor} exited with status ${code}.`, 1);
  const problems = fileProblems();
  if (problems.length) stop(problems.join("\nclue: "), 1);
}

export async function runConfig(args: string[]) {
  const [command, ...rest] = args;
  if (command === "path") return console.log(paths.settings);
  if (command === "show") return show(rest.includes("--json"));
  if (command === "set") return set(rest);
  if (command === "unset") return unset(rest);
  if (command === "edit") return edit(rest[0]);
  stop(USAGE);
}

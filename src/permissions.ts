import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { PermissionMode, PermissionRules, ReviewSetting, RuleValue } from "./config";
import { KNOWN_MODELS, modelLabel, resolveModel, REVIEW_FALLBACK_MODEL } from "./agent/models";
import { getClient } from "./agent/provider";
import { absolute, isInside } from "./paths";
import { parseCommand } from "./shell-command";
import { fieldOf, type Tool } from "./tools/types";
import reviewPrompt from "../prompts/review.yaml";

// Decides whether a tool call runs, asks the user, or goes to the reviewer.
//   ask:          every action that changes something asks first
//   auto:         routine work runs; other actions are reviewed by a model
//   full-access:  everything runs

export type Decision = { action: "run" | "ask" | "review" | "deny"; reason?: string; subject: string };

// A test for the arguments after a routine prefix. True when they make the command unsafe.
type UnsafeArgs = (args: string[]) => boolean;

const anyArg =
  (pattern: RegExp): UnsafeArgs =>
  (args) =>
    args.some((arg) => pattern.test(arg));
const routine = (commands: string, unsafe: UnsafeArgs | null = null) =>
  commands.split(",").map((command) => [command, unsafe] as const);
const forEach = (programs: string, commands: string) =>
  programs
    .split(" ")
    .flatMap((program) => commands.split(" ").map((command) => `${program} ${command}`))
    .join(",");

// git reads these as prefixes of the long options --output, --ext-diff and --open-files-in-pager.
const GIT_READ = anyArg(/^(--ou|--ext|--op|-O)/);
const PACKAGE_NAME = anyArg(/^[^-]/);
const NOT_A_SCRIPT_NAME: UnsafeArgs = ([name = ""]) => !/^\w[\w:-]*$/.test(name);
// A line range to print, such as sed -n '1,20p' a.ts. GNU sed reads a later -i as an option.
const NOT_A_LINE_RANGE: UnsafeArgs = ([script = "", ...files]) =>
  !/^(\d+|\$)(,(\d+|\$))?p$/.test(script) || files.some((file) => file.startsWith("-"));

const anyOf =
  (...checks: UnsafeArgs[]): UnsafeArgs =>
  (args) =>
    checks.some((check) => check(args));

// A path that leaves the project: absolute, under the home folder, or climbing with `..`.
const leavesProject = (path: string) => /^[/~]/.test(path) || path.split("/").includes("..");
// Tests an argument, and the value of a --flag=value. An absolute path inside the project also fails.
const PATH_LEAVES_PROJECT: UnsafeArgs = (args) =>
  args.some((arg) => leavesProject(arg) || (arg.includes("=") && leavesProject(arg.slice(arg.indexOf("=") + 1))));

// Flags that load code, config or plugins, or that point at another folder. Names are
// space separated. A one-letter name is a short flag, which may have its value attached
// (-Iinc). Any other name matches as -name or --name, with the value after = or in the next
// argument. With abbreviations, a long flag also matches its unique prefixes, which Python
// argparse accepts.
const flagged =
  (names: string, abbreviations = false): UnsafeArgs =>
  (args) => {
    const flags = names.split(" ");
    return args.some((arg) => {
      if (!arg.startsWith("-")) return false;
      const name = arg.replace(/^--?/, "").split("=")[0] ?? "";
      return flags.some((flag) =>
        flag.length === 1
          ? arg.startsWith(`-${flag}`) && !arg.startsWith("--")
          : name === flag || (abbreviations && arg.startsWith("--") && name.length >= 3 && flag.startsWith(name)),
      );
    });
  };

// make and ninja take many flags, so only plain targets and -j, -k and -n pass.
// A VAR=value argument is not a target, because `make CC=./x` runs that program.
const NOT_TARGETS_AND_JOBS: UnsafeArgs = anyArg(/^(?!(-(j\d*|k|n)|[\w.][\w.+/-]*)$)/);

// A project's test and build runners, with the flags that load code from outside it.
// Every runner also gets PATH_LEAVES_PROJECT.
const runner = (commands: string, ...checks: UnsafeArgs[]) => routine(commands, anyOf(PATH_LEAVES_PROJECT, ...checks));
const viaNpx = (tools: string) => `${tools.replaceAll(" ", ",")},${forEach("npx bunx", tools)}`;

const PACKAGE_MANAGER = "script-shell prefix registry dir C cwd g global userconfig";
const BUN = `${PACKAGE_MANAGER} preload r config c env-file tsconfig-override`;
const GO = "exec toolexec vettool overlay modfile pkgdir C o";
const CARGO = "config config-path manifest-path target-dir artifact-dir out-dir lockfile-path Z";
const TEST_RUNNER = [
  "config c root rootDir setupFiles setupFilesAfterEnv globalSetup globalTeardown require",
  "testRunner testEnvironment transform preset watchPlugins resolver snapshotResolver testSequencer",
  "environment workspace dir outputFile",
].join(" ");
const LINTER =
  "config c plugin plugin-search-dir rulesdir resolve-plugins-relative-to config-path parser output-file o";
const TSC = "project p outDir outFile plugins declarationDir tsBuildInfoFile generateTrace";
const PYTEST = "p c rootdir confcutdir override-ini o basetemp";
const RSPEC = "r require I O options";
const RUBOCOP = "r require I c config";
const RUFF = "config config-file output-file";
const MYPY = "config config-file python-executable";
const BLACK = "config config-file";
const ZIG = "build-file zig-lib-dir cache-dir global-cache-dir build-runner prefix p libc sysroot";
const GRADLE =
  "build-file b settings-file c project-dir p init-script I gradle-user-home g project-cache-dir include-build";
const MAVEN = "file f settings s global-settings gs toolchains t";
const SWIFT = "package-path scratch-path build-path cache-path config-path toolset sdk";
const MIX = "dot-formatter";

// Commands that only read, or that are a normal part of working on a project, keyed by
// their leading words. Everything else goes to review.
// Programs that run whatever code they are given, such as awk, node or xargs, stay off it.
// Test and build runners, such as make, bun test and cargo build, are on it although they
// run the project's own code, so a file written to the project can be run through them.
// The runners get an argument check, so a flag that loads code or config from elsewhere,
// or a path outside the project, goes to review.
const ROUTINE_COMMANDS = new Map<string, UnsafeArgs | null>([
  ...routine(
    "ls,pwd,cat,head,tail,wc,echo,printf,which,file,stat,du,df,true,false,cut,tr,cmp,basename,dirname,realpath,readlink,grep,egrep,fgrep,jq",
  ),
  ...routine("nl,rev,seq,paste,column,od,hexdump,md5,md5sum,shasum,sha1sum,sha256sum,id,uname,whoami,test,["),
  ...routine("find", anyArg(/^-(exec|execdir|ok|okdir|delete|fls|fprint|fprint0|fprintf)$/)),
  ...routine("sed -n", NOT_A_LINE_RANGE),
  ...routine("base64", anyArg(/^(-[a-zA-Z]*o|--o)/)),
  ...routine("sort", anyArg(/^(-[a-zA-Z]*o|--o|--c)/)),
  ...routine("uniq", (args) => args.filter((arg) => !arg.startsWith("-")).length > 1),
  ...routine("diff", anyArg(/^--o/)),
  ...routine("rg", anyArg(/^--(pre|hostname-bin)/)),
  ...routine("fd", anyArg(/^(-[a-zA-Z]*[xX]|--exec)/)),
  ...routine("tree", anyArg(/^(-[a-zA-Z]*o|--fromfile)/)),
  ...routine("date", anyArg(/^(-[a-zA-Z]*s|--s)/)),

  ...routine(
    "git status,git diff,git log,git show,git grep,git blame,git ls-files,git rev-parse,git describe,git stash list,git worktree list",
    GIT_READ,
  ),
  ...routine("git branch", anyArg(/^(?!(-a|-r|-v|-vv|--all|--remotes|--verbose|--list|--show-current)$)/)),
  ...routine("git remote -v", anyArg(/./)),
  ...routine("git tag --list,git tag -l", anyArg(/^-/)),
  ...routine("git add,git checkout -b"),
  ...routine("git commit", anyArg(/^(--am|--no-v|-[a-zA-Z]*n)/)),
  ...routine("git switch", anyArg(/^(-f|-C|--f|--d)/)),
  ...routine("git restore --staged", anyArg(/^(-W|--w)/)),
  ...routine("git fetch", anyArg(/^-(?!-all$|-tags$)/)),

  ...routine(forEach("node bun deno npm pnpm yarn python python3 ruby cargo rustc git", "--version"), anyArg(/./)),
  ...routine("node -v,bun -v,npm -v,pnpm -v,yarn -v,go version,zig version", anyArg(/./)),

  ...runner(forEach("npm pnpm yarn", "test outdated ls list why"), flagged(PACKAGE_MANAGER)),
  ...runner(forEach("bun", "test outdated ls list why") + ",bun check,bun fmt", flagged(BUN)),
  ...runner(forEach("npm pnpm yarn", "install i ci"), PACKAGE_NAME, flagged(PACKAGE_MANAGER)),
  ...runner(forEach("bun", "install i ci"), PACKAGE_NAME, flagged(BUN)),
  ...runner(forEach("npm pnpm yarn", "run"), NOT_A_SCRIPT_NAME, flagged(PACKAGE_MANAGER)),
  ...runner(forEach("bun", "run"), NOT_A_SCRIPT_NAME, flagged(BUN)),
  ...runner(forEach("pnpm yarn", "build lint typecheck format"), flagged(PACKAGE_MANAGER)),

  ...runner(viaNpx("tsc"), flagged(TSC)),
  ...runner(viaNpx("vitest jest"), flagged(TEST_RUNNER)),
  ...runner(viaNpx("eslint prettier biome"), flagged(LINTER)),
  ...runner("pytest,python -m pytest,python3 -m pytest", flagged(PYTEST, true)),
  ...runner("rspec,bundle exec rspec", flagged(RSPEC)),
  ...runner("rubocop,bundle exec rubocop", flagged(RUBOCOP)),
  ...runner("ruff", flagged(RUFF)),
  ...runner("mypy", flagged(MYPY, true)),
  ...runner("black", flagged(BLACK)),
  ...runner("make,ninja", NOT_TARGETS_AND_JOBS),
  ...runner("rails test", flagged("I")),
  ...runner("gradle test,gradle build", flagged(GRADLE)),
  ...runner("mvn test", flagged(MAVEN)),
  ...runner("zig build", flagged(ZIG)),
  ...runner(forEach("cargo", "test build check clippy fmt"), flagged(CARGO)),
  ...runner(forEach("go", "test build vet fmt"), flagged(GO)),
  ...runner(forEach("swift", "test build"), flagged(SWIFT)),
  ...runner(forEach("mix", "test compile format"), flagged(MIX)),
  ...routine("docker ps,docker images,docker logs,docker compose ps,docker compose logs"),
]);

// Case-insensitive, because the default macOS volume reads .GIT as .git.
const SENSITIVE_PATH =
  /(^|\/)(\.env(\..*)?|\.git\/|\.ssh\/|\.aws\/|\.npmrc|\.netrc|\.gnupg\/|id_rsa|\.clue\/settings\.json|\.mcp\.json|credentials)/i;

// Variables that change how a command prints or which mode it runs in, never what it runs.
// The value can't hold a path, so LANG or TZ can't point at a file.
const SAFE_VARIABLE =
  /^(CI|NODE_ENV|BUN_ENV|DENO_ENV|RUST_LOG|RUST_BACKTRACE|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|LANG|LC_ALL|LC_CTYPE|TZ)=[\w.,:@=+-]*$/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/;

// The command without the words in front that only set how it runs: safe variables,
// `env` with those or with `-u NAME`, `time`, and `timeout <duration>`.
function unwrap(words: string[]) {
  let start = 0;
  for (;;) {
    const word = words[start];
    if (word === "time" || SAFE_VARIABLE.test(word ?? "")) start += 1;
    else if (word === "timeout" && DURATION.test(words[start + 1] ?? "")) start += 2;
    else if (word === "env") {
      start += 1;
      while (words[start] === "-u" && start + 1 < words.length) start += 2;
    } else return words.slice(start);
  }
}

// `cd` to the project or a folder in it. A relative path can't climb, so this holds
// after an earlier `cd` in the same line too.
function cdStaysInProject(args: string[], cwd?: string) {
  const [path = ""] = args;
  if (args.length !== 1 || path === "" || /^[-+]|[*?[]/.test(path)) return false;
  if (!path.startsWith("/")) return !path.split("/").includes("..");
  return cwd !== undefined && isInside(cwd, path);
}

function wordsAreRoutine(words: string[], cwd?: string) {
  const command = unwrap(words);
  if (command[0] === "cd") return cdStaysInProject(command.slice(1), cwd);
  for (let length = command.length; length > 0; length--) {
    const prefix = command.slice(0, length).join(" ");
    if (ROUTINE_COMMANDS.has(prefix)) return !ROUTINE_COMMANDS.get(prefix)?.(command.slice(length));
  }
  return false;
}

// cwd is the project folder, for `cd` with an absolute path.
export function commandIsRoutine(command: string, cwd?: string) {
  const commands = parseCommand(command);
  return commands !== null && commands.length > 0 && commands.every((words) => wordsAreRoutine(words, cwd));
}

// The path a file tool names, when it names one.
function pathOf(tool: Tool, input: unknown) {
  const path = tool.name === "shell" || tool.name === "mcp_call" ? null : fieldOf(input, "path");
  return path ? String(path) : null;
}

// The file a write reaches, with every link followed. The deepest parent that exists is
// resolved and the rest is added back, because a new file has no real path yet.
// Null when it can't be told, which callers treat as outside the project.
function realPath(path: string): string | null {
  const rest: string[] = [];
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      return rest.includes("..") ? null : join(realpathSync(dir), ...rest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      // A link with no target exists but fails realpath, and a write would create the target.
      try {
        lstatSync(dir);
        return null;
      } catch {}
      if (dirname(dir) === dir) return null;
      rest.unshift(basename(dir));
    }
  }
}

// Where a path lands, with links followed. `real` is null when that can't be told. `local` is the
// real path relative to the project, and empty unless the path is inside it.
function resolveTarget(cwd: string, path: string): { real: string | null; local: string } {
  const real = realPath(absolute(cwd, path));
  let root: string | null = null;
  try {
    root = realpathSync(cwd);
  } catch {}
  if (real === null || root === null || real === root || !isInside(root, real)) return { real, local: "" };
  return { real, local: relative(root, real) };
}

// The text rules match against: the command, the file path, or "server.tool".
export function subjectOf(tool: Tool, input: unknown): string {
  const field = (key: string) => fieldOf(input, key);
  const action = field("action");
  if (tool.name === "shell")
    return action && action !== "run" ? `${String(action)} ${String(field("id"))}` : String(field("command") ?? "");
  if (tool.name === "mcp_call") return `${String(field("server"))}.${String(field("tool"))}`;
  if (field("path")) return String(field("path"));
  if (tool.name === "install_skill") return String(field("source") ?? "");
  return "";
}

// With bareCommand, a trailing " *" also matches the command alone, so `git push *` matches `git push`.
// Only deny and ask rules use it, so an allow never covers more than it names.
const globToRegex = (pattern: string, bareCommand = false) => {
  const bare = bareCommand && pattern.endsWith(" *");
  const body = (bare ? pattern.slice(0, -2) : pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}${bare ? "( .*)?" : ""}$`, "s");
};

// The last matching rule wins: a tool-wide value, then patterns in order.
export function ruleFor(rules: PermissionRules, toolName: string, subject: string): RuleValue | null {
  let result: RuleValue | null = null;
  const apply = (value: RuleValue | Record<string, RuleValue> | undefined) => {
    if (!value) return;
    if (typeof value === "string") {
      result = value;
      return;
    }
    for (const [pattern, ruleValue] of Object.entries(value)) {
      if (globToRegex(pattern, toolName === "shell" && ruleValue !== "allow").test(subject)) result = ruleValue;
    }
  };
  apply(rules["*"]);
  apply(rules[toolName]);
  return result;
}

// A rule for a file path. Deny and ask rules test the path as written, the absolute path, the
// project-relative path, and the real path behind any link, absolute and project-relative. A
// match on any of them wins. An allow rule tests only the path as written and the
// project-relative path. A path with a .. segment can't match as written, because it can leave
// the pattern's folder, so it needs the project-relative form, which is already normalised.
function pathRule(rules: PermissionRules, toolName: string, path: string, cwd: string): RuleValue | null {
  const file = absolute(cwd, path);
  const local = isInside(cwd, file) ? relative(cwd, file) : "";
  const writtenForms = path.split("/").includes("..") ? [local] : [path, local];
  const granting = writtenForms.filter(Boolean).map((form) => ruleFor(rules, toolName, form));
  const target = resolveTarget(cwd, path);
  const restricting = [path, file, target.real ?? "", target.local].filter(Boolean);
  const forms = [...granting, ...restricting.map((form) => ruleFor(rules, toolName, form))];
  return forms.includes("deny") ? "deny" : forms.includes("ask") ? "ask" : granting.includes("allow") ? "allow" : null;
}

const VARIABLE_ASSIGNMENT = /^[A-Za-z_]\w*=/;

// The command a deny or ask rule should also test: no time, env, timeout or leading
// NAME=value, whether or not the variable is safe.
function withoutWrappers(words: string[]) {
  let rest = words;
  for (;;) {
    let next = unwrap(rest);
    while (VARIABLE_ASSIGNMENT.test(next[0] ?? "")) next = next.slice(1);
    if (next.length === rest.length) return next;
    rest = next;
  }
}

const WRAPPER_WORDS = new Set(["time", "timeout", "env"]);

// The pattern for an "always allow" answer on one command: its program without wrappers or
// variables, with two words for git, npm and bun. When no program can be told, such as for
// `time`, `env -i ./x` or `timeout -s KILL 5 ./x`, the pattern is that command and nothing
// else. Wildcard characters are dropped from it, so it can't match more than it names.
function shellGrantPattern(words: string[]) {
  const program = withoutWrappers(words);
  const [name = ""] = program;
  if (name === "" || name.startsWith("-") || WRAPPER_WORDS.has(name)) return words.join(" ").replace(/[*?]/g, "");
  return `${program.slice(0, name === "git" || name === "npm" || name === "bun" ? 2 : 1).join(" ")} *`;
}

// Deny and ask rules test the text as written and without its wrappers. Either can win.
function restrictiveRule(rules: PermissionRules, text: string, words: string[]): RuleValue | null {
  const forms = [ruleFor(rules, "shell", text), ruleFor(rules, "shell", withoutWrappers(words).join(" "))];
  return forms.includes("deny") ? "deny" : forms.includes("ask") ? "ask" : null;
}

// The rule for a shell command line. Each command in a chain gets its own rule, so a deny
// can't hide behind `cd x &&`, and an allow can't carry a second command along. A line that
// can't be parsed is split on its separators, so it can match a deny or an ask but never an
// allow. Splitting ignores quotes, so a separator inside a string can over-match.
function shellRule(rules: PermissionRules, line: string): RuleValue | null {
  const commands = parseCommand(line);
  if (!commands?.length) {
    const pieces = line.split(/&&|\|\||[;|&\n]/).map((piece) => piece.trim());
    const found = [line, ...pieces].map((piece) => restrictiveRule(rules, piece, piece.split(/\s+/)));
    return found.includes("deny") ? "deny" : found.includes("ask") ? "ask" : null;
  }
  const values = commands.map((words) => {
    const raw = ruleFor(rules, "shell", words.join(" "));
    return restrictiveRule(rules, words.join(" "), words) ?? raw;
  });
  if (values.includes("deny")) return "deny";
  if (values.includes("ask")) return "ask";
  return values.every((value) => value === "allow") ? "allow" : null;
}

// The text an `interact` call writes to a live process, or "" when it only reads output.
const inputOf = (tool: Tool, input: unknown) =>
  tool.name === "shell" && fieldOf(input, "action") === "interact" ? String(fieldOf(input, "input") ?? "") : "";

const SHOWN_INPUT_LENGTH = 80;

// The question an approval prompt asks, such as "Run git push origin main?".
export function approvalQuestion(tool: Tool, input: unknown) {
  const subject = subjectOf(tool, input);
  switch (tool.name) {
    case "shell": {
      const sent = inputOf(tool, input).replace(/\s+/g, " ").trim();
      if (!sent) return `Run ${subject}?`;
      const shown = sent.length > SHOWN_INPUT_LENGTH ? `${sent.slice(0, SHOWN_INPUT_LENGTH)}...` : sent;
      return `Send "${shown}" to process ${String(fieldOf(input, "id"))}?`;
    }
    case "edit_file":
      return `Edit ${subject}?`;
    case "write_file":
      return `Write ${subject}?`;
    case "mcp_call":
      return `Call ${subject}?`;
    case "install_skill":
      return `Install a skill from ${subject}?`;
    default:
      return `Allow ${tool.name}${subject ? ` ${subject}` : ""}?`;
  }
}

export class Permissions {
  // "Always allow" answers from this session, keyed by tool name.
  private grants = new Map<string, string[]>();

  constructor(
    public mode: PermissionMode,
    private rules: PermissionRules,
    private cwd: string,
  ) {}

  grant(toolName: string, pattern: string) {
    this.grants.set(toolName, [...(this.grants.get(toolName) ?? []), pattern]);
  }

  // The pattern an "always allow" answer saves: the command's program, or the whole tool.
  static grantPattern(tool: Tool, subject: string) {
    if (tool.name === "shell") {
      const words =
        parseCommand(subject)?.[0] ??
        subject
          .split(/&&|\|\||[;|&\n]/)[0]!
          .trim()
          .split(/\s+/);
      return shellGrantPattern(words);
    }
    if (tool.name === "mcp_call") return subject;
    return "*";
  }

  // An "always allow" answer must cover every command in a chain. A command also counts
  // without its wrappers, so a grant for cargo covers `time cargo publish`. A variable
  // that unwrap keeps, such as PATH=/tmp, stays in the text, so the grant doesn't match.
  private granted(toolName: string, subject: string, runsCommand: boolean) {
    const patterns = this.grants.get(toolName) ?? [];
    const matches = (text: string) => patterns.some((pattern) => globToRegex(pattern).test(text));
    if (!runsCommand) return matches(subject);
    const commands = parseCommand(subject);
    return (
      commands !== null &&
      commands.length > 0 &&
      commands.every((words) => matches(words.join(" ")) || matches(unwrap(words).join(" ")))
    );
  }

  decide(tool: Tool, input: unknown): Decision {
    const subject = subjectOf(tool, input);
    const path = pathOf(tool, input);
    const action = fieldOf(input, "action");
    const runsCommand = tool.name === "shell" && (action ?? "run") === "run";
    // Input to a live process can be any command. Deny and ask rules see it, but allow rules and grants never cover it.
    const sends = inputOf(tool, input) !== "";
    const sentRule = sends ? shellRule(this.rules, inputOf(tool, input).replace(/[\r\n]+$/, "")) : null;
    const rule = runsCommand
      ? shellRule(this.rules, subject)
      : sends
        ? sentRule === "allow"
          ? null
          : sentRule
        : path !== null
          ? pathRule(this.rules, tool.name, path, this.cwd)
          : ruleFor(this.rules, tool.name, subject);
    if (rule === "deny") return { action: "deny", subject, reason: "a deny rule in ~/.clue/settings.json" };
    if (tool.readOnly) return { action: "run", subject };
    if (rule === "allow") return { action: "run", subject };
    if (!sends && this.granted(tool.name, subject, runsCommand)) return { action: "run", subject };
    if (this.mode === "full-access") return { action: "run", subject };
    if (rule === "ask" || this.mode === "ask") return { action: "ask", subject };
    // auto mode
    if (tool.name === "subagent") return { action: "run", subject };
    if (tool.name === "write_file" || tool.name === "edit_file") {
      const { local } = resolveTarget(this.cwd, subject);
      const inside = local !== "";
      const written = relative(this.cwd, absolute(this.cwd, subject));
      if (inside && !SENSITIVE_PATH.test(local) && !SENSITIVE_PATH.test(written)) return { action: "run", subject };
      return { action: "review", subject, reason: inside ? "sensitive file" : "outside the project" };
    }
    if (tool.name === "shell") {
      if (sends) return { action: "review", subject, reason: "input to a running process" };
      if (action === "interact" || action === "stop") return { action: "run", subject };
      return commandIsRoutine(subject, this.cwd)
        ? { action: "run", subject }
        : { action: "review", subject, reason: "unrecognized command" };
    }
    return { action: "review", subject, reason: tool.name === "mcp_call" ? "MCP tool call" : "not routine" };
  }
}

// ---------------------------------------------------------------------------
// Reviewer: the `review` setting picks one. Without it, Claude Haiku. Jev through
// OpenRouter only when the setting asks for it. Whichever it is, Haiku at low effort
// takes over if it breaks. Anthropic sees the conversation anyway, so that never leaks
// anything, and nothing falls back the other way.

// The reviewer's wording lives in prompts/review.yaml, embedded at build time.
const {
  instructions: REVIEW_INSTRUCTIONS,
  clear: CLEAR,
  caution: CAUTION,
  policy: POLICY,
} = reviewPrompt as Record<"instructions" | "clear" | "caution" | "policy", string>;

// `unreviewed` marks a hold that happened without any model reading the action.
export type Review = { approved: boolean; reviewer: string; reason?: string; unreviewed?: true };
export type Reviewer = { provider: "anthropic" | "openrouter"; model: string };
type Verdict = Pick<Review, "approved" | "reason">;

const JEV = /^(?:typesafe\/)?(jev(?:-[\d.]+)?)$/;
const LATEST_JEV = "typesafe/jev-1.14";
const REVIEW_TIMEOUT_MS = 20_000;
const MAX_REVIEWED_ACTION_CHARS = 8000;

// Throws when the setting can't work, which counts as a broken reviewer.
export function chooseReviewer(review: ReviewSetting = {}, openrouterKey?: string): Reviewer {
  const { model } = review;
  const jev = model?.match(JEV);
  const provider = review.provider ?? (jev ? "openrouter" : "anthropic");
  if (provider === "openrouter") {
    if (!openrouterKey) throw new Error("OPENROUTER_API_KEY isn't set");
    if (model && !jev) throw new Error(`OpenRouter can't run ${model}`);
    return { provider, model: !jev || jev[1] === "jev" ? LATEST_JEV : `typesafe/${jev[1]}` };
  }
  if (provider !== "anthropic") throw new Error(`${provider} isn't a review provider`);
  const id = resolveModel(model ?? "haiku");
  if (!KNOWN_MODELS.includes(id)) throw new Error(`${model} isn't a Claude model`);
  return { provider, model: id };
}

const reviewerName = ({ provider, model }: Reviewer) =>
  provider === "openrouter" ? "jev" : modelLabel(model).split(" ")[0];

// What OpenRouter's decisions endpoint sends back. Every field is checked before use.
type JevReply = { error?: { message?: string }; answers?: { decision?: { choice?: unknown } } };

async function askJev(model: string, state: object, signal: AbortSignal): Promise<Verdict> {
  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai"}/api/alpha/decisions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "clue",
    },
    body: JSON.stringify({
      model,
      state: JSON.stringify(state),
      questions: {
        decision: { type: "choice", instructions: REVIEW_INSTRUCTIONS, criteria: { clear: CLEAR, caution: CAUTION } },
      },
    }),
  });
  const body = (await response.json().catch(() => null)) as JevReply | null;
  if (!response.ok || body?.error) throw new Error(body?.error?.message ?? `Jev returned ${response.status}`);
  const choice = body?.answers?.decision?.choice;
  if (choice !== "clear" && choice !== "caution") throw new Error(`Jev answered ${choice}`);
  return {
    approved: choice === "clear",
    reason: choice === "clear" ? undefined : "found possible prompt injection or harmful activity",
  };
}

async function askClaude(model: string, state: object, signal: AbortSignal): Promise<Verdict> {
  const client = await getClient();
  const response = await client.messages.create(
    {
      model,
      max_tokens: 2048,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { decision: { type: "string", enum: ["clear", "caution"] }, reason: { type: "string" } },
            required: ["decision", "reason"],
            additionalProperties: false,
          },
        },
      },
      system: `${REVIEW_INSTRUCTIONS}\nclear: ${CLEAR}\ncaution: ${CAUTION}\nReply with JSON only.`,
      messages: [{ role: "user", content: JSON.stringify(state) }],
    },
    { signal },
  );
  const text = response.content.find((block) => block.type === "text")?.text ?? "{}";
  const { decision, reason } = JSON.parse(text) as { decision?: string; reason?: string };
  if (decision !== "clear" && decision !== "caution") throw new Error(`the reviewer answered ${decision}`);
  return { approved: decision === "clear", reason: decision === "clear" ? undefined : reason };
}

export async function reviewAction(
  toolName: string,
  input: unknown,
  userRequest: string,
  review: ReviewSetting | undefined,
  signal: AbortSignal,
  // For input to a running shell process: the command that started it.
  processCommand?: string,
): Promise<Review> {
  const action = JSON.stringify(input);
  // Approval covers the whole action, so the reviewer must be able to read all of it.
  if (action.length > MAX_REVIEWED_ACTION_CHARS) {
    return {
      approved: false,
      reviewer: "clue",
      reason: "the action is too long for a reviewer to read in full",
      unreviewed: true,
    };
  }
  const state = {
    review_policy: POLICY,
    user_request: userRequest.slice(0, 4000),
    pending_action_tool: toolName,
    pending_action_arguments: action,
    ...(processCommand === undefined ? {} : { process_command: processCommand.slice(0, 2000) }),
  };
  const ask = ({ provider, model }: Reviewer) => {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]);
    return provider === "openrouter" ? askJev(model, state, timeout) : askClaude(model, state, timeout);
  };
  const fallback: Reviewer = { provider: "anthropic", model: REVIEW_FALLBACK_MODEL };
  const held = (reviewer: string, ...errors: unknown[]): Review => ({
    approved: false,
    reviewer,
    reason: `the review could not finish: ${errors.map((error) => (error as Error).message).join(". ")}`,
  });

  let chosen: Reviewer | null = null;
  let failure: unknown;
  try {
    chosen = chooseReviewer(review, process.env.OPENROUTER_API_KEY);
    return { ...(await ask(chosen)), reviewer: reviewerName(chosen) };
  } catch (error) {
    failure = error;
  }
  // An interrupt isn't a broken reviewer, and Haiku shouldn't be asked the same thing twice.
  if (signal.aborted || chosen?.model === fallback.model) return held(chosen ? reviewerName(chosen) : "haiku", failure);
  try {
    return {
      ...(await ask(fallback)),
      reviewer: `haiku (${chosen ? reviewerName(chosen) : "the review setting"} failed)`,
    };
  } catch (error) {
    return held("haiku", failure, error);
  }
}

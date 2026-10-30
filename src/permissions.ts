import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import type { PermissionMode, PermissionRules, ReviewSetting, RuleValue } from "./config";
import { KNOWN_MODELS, modelLabel, resolveModel, REVIEW_FALLBACK_MODEL } from "./agent/models";
import { getClient } from "./agent/provider";
import { parseCommand } from "./shell-command";
import type { Tool } from "./tools/types";
import reviewPrompt from "../prompts/review.yaml";

// Decides whether a tool call runs, asks the user, or goes to the reviewer.
//   ask:          every action that changes something asks first
//   auto:         routine work runs; other actions are reviewed by a model
//   full-access:  everything runs

export type Decision = { action: "run" | "ask" | "review" | "deny"; reason?: string; subject: string };

// A test for the arguments after a routine prefix. True when they make the command unsafe.
type UnsafeArgs = (args: string[]) => boolean;

const anyArg = (pattern: RegExp): UnsafeArgs => (args) => args.some((arg) => pattern.test(arg));
const routine = (commands: string, unsafe: UnsafeArgs | null = null) => commands.split(",").map((command) => [command, unsafe] as const);
const forEach = (programs: string, commands: string) => programs.split(" ").flatMap((program) => commands.split(" ").map((command) => `${program} ${command}`)).join(",");

// git reads these as prefixes of the long options --output, --ext-diff and --open-files-in-pager.
const GIT_READ = anyArg(/^(--ou|--ext|--op|-O)/);
const PACKAGE_NAME = anyArg(/^[^-]/);
const NOT_A_SCRIPT_NAME: UnsafeArgs = ([name = ""]) => !/^\w[\w:-]*$/.test(name);

// Commands that only read, or that are a normal part of working on a project, keyed by
// their leading words. Everything else goes to review, so this list stays short.
// Programs that run other programs, such as env, find, awk, node or xargs, stay off it.
const ROUTINE_COMMANDS = new Map<string, UnsafeArgs | null>([
  ...routine("ls,pwd,cat,head,tail,wc,echo,printf,which,file,stat,du,df,true,false,cut,tr,cmp,basename,dirname,realpath,grep,egrep,fgrep,jq"),
  ...routine("sort", anyArg(/^(-[a-zA-Z]*o|--o|--c)/)),
  ...routine("uniq", (args) => args.filter((arg) => !arg.startsWith("-")).length > 1),
  ...routine("diff", anyArg(/^--o/)),
  ...routine("rg", anyArg(/^--(pre|hostname-bin)/)),
  ...routine("fd", anyArg(/^(-[a-zA-Z]*[xX]|--exec)/)),
  ...routine("tree", anyArg(/^(-[a-zA-Z]*o|--fromfile)/)),
  ...routine("date", anyArg(/^(-[a-zA-Z]*s|--s)/)),

  ...routine("git status,git diff,git log,git show,git grep,git blame,git ls-files,git rev-parse,git describe,git stash list,git worktree list", GIT_READ),
  ...routine("git branch", anyArg(/^(?!(-a|-r|-v|-vv|--all|--remotes|--verbose|--list|--show-current)$)/)),
  ...routine("git remote -v", anyArg(/./)),
  ...routine("git tag --list,git tag -l", anyArg(/^-/)),
  ...routine("git add,git checkout -b"),
  ...routine("git commit", anyArg(/^(--am|--no-v|-[a-zA-Z]*n)/)),
  ...routine("git switch", anyArg(/^(-f|-C|--f|--d)/)),
  ...routine("git restore --staged", anyArg(/^(-W|--w)/)),
  ...routine("git fetch", anyArg(/^-(?!-all$|-tags$)/)),

  ...routine(forEach("npm pnpm yarn bun", "test outdated ls list why")),
  ...routine(forEach("npm pnpm yarn bun", "install i ci"), PACKAGE_NAME),
  ...routine(forEach("npm pnpm yarn bun", "run"), NOT_A_SCRIPT_NAME),
  ...routine(forEach("pnpm yarn", "build lint typecheck format")),
  ...routine(forEach("npx bunx", "tsc vitest jest eslint prettier biome")),

  ...routine("tsc,vitest,jest,eslint,prettier,biome,pytest,rspec,rubocop,ruff,mypy,black,make,ninja"),
  ...routine("python -m pytest,python3 -m pytest,bundle exec rspec,bundle exec rubocop,rails test,gradle test,gradle build,mvn test,zig build"),
  ...routine(forEach("cargo", "test build check clippy fmt")),
  ...routine(forEach("go", "test build vet fmt")),
  ...routine(forEach("swift", "test build")),
  ...routine(forEach("mix", "test compile format")),
  ...routine("docker ps,docker images,docker logs,docker compose ps,docker compose logs"),
]);

const SENSITIVE_PATH = /(^|\/)(\.env(\..*)?|\.git\/|\.ssh\/|\.aws\/|\.npmrc|\.netrc|\.gnupg\/|id_rsa|\.clue\/settings\.json|credentials)/;

function wordsAreRoutine(words: string[]) {
  for (let length = words.length; length > 0; length--) {
    const prefix = words.slice(0, length).join(" ");
    if (ROUTINE_COMMANDS.has(prefix)) return !ROUTINE_COMMANDS.get(prefix)?.(words.slice(length));
  }
  return false;
}

export function commandIsRoutine(command: string) {
  const commands = parseCommand(command);
  return commands !== null && commands.length > 0 && commands.every(wordsAreRoutine);
}

function insideProject(cwd: string, path: string) {
  const target = resolve(cwd, path.replace(/^~(?=\/)/, homedir()));
  const rel = relative(cwd, target);
  return rel !== "" && !rel.startsWith("..") && !resolve(rel).startsWith("..");
}

// The text rules match against: the command, the file path, or "server.tool".
export function subjectOf(tool: Tool, input: any): string {
  if (tool.name === "shell") return input?.action && input.action !== "run" ? `${input.action} ${input.id}` : (input?.command ?? "");
  if (tool.name === "mcp_call") return `${input?.server}.${input?.tool}`;
  if (input?.path) return String(input.path);
  if (tool.name === "install_skill") return String(input?.source ?? "");
  return "";
}

const globToRegex = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

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
      if (globToRegex(pattern).test(subject)) result = ruleValue;
    }
  };
  apply(rules["*"]);
  apply(rules[toolName]);
  return result;
}

// The rule for a shell command line. Each command in a chain gets its own rule, so a deny
// can't hide behind `cd x &&`, and an allow can't carry a second command along. A line that
// can't be parsed can match a deny or an ask, but never an allow.
function shellRule(rules: PermissionRules, line: string): RuleValue | null {
  const commands = parseCommand(line);
  if (!commands?.length) {
    const rule = ruleFor(rules, "shell", line);
    return rule === "allow" ? null : rule;
  }
  const values = commands.map((words) => ruleFor(rules, "shell", words.join(" ")));
  if (values.includes("deny")) return "deny";
  if (values.includes("ask")) return "ask";
  return values.every((value) => value === "allow") ? "allow" : null;
}

// The question an approval prompt asks, such as "Run git push origin main?".
export function approvalQuestion(tool: Tool, input: any) {
  const subject = subjectOf(tool, input);
  switch (tool.name) {
    case "shell":
      return `Run ${subject}?`;
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
      const words = subject.trim().split(/\s+/);
      return words[0] === "git" || words[0] === "npm" || words[0] === "bun" ? `${words.slice(0, 2).join(" ")} *` : `${words[0]} *`;
    }
    if (tool.name === "mcp_call") return subject;
    return "*";
  }

  // An "always allow" answer must cover every command in a chain.
  private granted(toolName: string, subject: string, runsCommand: boolean) {
    const patterns = this.grants.get(toolName) ?? [];
    const matches = (text: string) => patterns.some((pattern) => globToRegex(pattern).test(text));
    if (!runsCommand) return matches(subject);
    const commands = parseCommand(subject);
    return commands !== null && commands.length > 0 && commands.every((words) => matches(words.join(" ")));
  }

  decide(tool: Tool, input: any): Decision {
    const subject = subjectOf(tool, input);
    const runsCommand = tool.name === "shell" && (input?.action ?? "run") === "run";
    const rule = runsCommand ? shellRule(this.rules, subject) : ruleFor(this.rules, tool.name, subject);
    if (rule === "deny") return { action: "deny", subject, reason: "a deny rule in ~/.clue/settings.json" };
    if (tool.readOnly) return { action: "run", subject };
    if (rule === "allow") return { action: "run", subject };
    if (this.granted(tool.name, subject, runsCommand)) return { action: "run", subject };
    if (this.mode === "full-access") return { action: "run", subject };
    if (rule === "ask" || this.mode === "ask") return { action: "ask", subject };
    // auto mode
    if (tool.name === "subagent") return { action: "run", subject };
    if (tool.name === "write_file" || tool.name === "edit_file") {
      if (insideProject(this.cwd, subject) && !SENSITIVE_PATH.test(subject)) return { action: "run", subject };
      return { action: "review", subject, reason: insideProject(this.cwd, subject) ? "sensitive file" : "outside the project" };
    }
    if (tool.name === "shell") {
      if (input?.action === "interact" || input?.action === "stop") return { action: "run", subject };
      return commandIsRoutine(subject) ? { action: "run", subject } : { action: "review", subject, reason: "unrecognized command" };
    }
    return { action: "review", subject, reason: tool.name === "mcp_call" ? "MCP tool call" : "not routine" };
  }
}

// ---------------------------------------------------------------------------
// Reviewer: the `review` setting picks one. Without it, Jev through OpenRouter when
// OPENROUTER_API_KEY is set, otherwise Claude Haiku. Whichever it is, Haiku at low effort
// takes over if it breaks. Anthropic sees the conversation anyway, so that never leaks
// anything, and nothing falls back the other way.

// The reviewer's wording lives in prompts/review.yaml, embedded at build time.
const { instructions: REVIEW_INSTRUCTIONS, clear: CLEAR, caution: CAUTION, policy: POLICY } = reviewPrompt as Record<"instructions" | "clear" | "caution" | "policy", string>;

export type Review = { approved: boolean; reviewer: string; reason?: string };
export type Reviewer = { provider: "anthropic" | "openrouter"; model: string };
type Verdict = Pick<Review, "approved" | "reason">;

const JEV = /^(?:typesafe\/)?(jev(?:-[\d.]+)?)$/;
const LATEST_JEV = "typesafe/jev-1.14";
const REVIEW_TIMEOUT_MS = 20_000;

// Throws when the setting can't work, which counts as a broken reviewer.
export function chooseReviewer(review: ReviewSetting = {}, openrouterKey?: string): Reviewer {
  const { model } = review;
  const jev = model?.match(JEV);
  const provider = review.provider ?? (model ? (jev ? "openrouter" : "anthropic") : openrouterKey ? "openrouter" : "anthropic");
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

const reviewerName = ({ provider, model }: Reviewer) => (provider === "openrouter" ? "jev" : modelLabel(model).split(" ")[0]);

async function askJev(model: string, state: object, signal: AbortSignal): Promise<Verdict> {
  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai"}/api/alpha/decisions`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "X-Title": "clue" },
    body: JSON.stringify({
      model,
      state: JSON.stringify(state),
      questions: { decision: { type: "choice", instructions: REVIEW_INSTRUCTIONS, criteria: { clear: CLEAR, caution: CAUTION } } },
    }),
  });
  const body = (await response.json().catch(() => null)) as any;
  if (!response.ok || body?.error) throw new Error(body?.error?.message ?? `Jev returned ${response.status}`);
  const choice = body?.answers?.decision?.choice;
  if (choice !== "clear" && choice !== "caution") throw new Error(`Jev answered ${choice}`);
  return { approved: choice === "clear", reason: choice === "clear" ? undefined : "Jev flagged it as possible prompt injection or harmful activity" };
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

export async function reviewAction(toolName: string, input: unknown, userRequest: string, review: ReviewSetting | undefined, signal: AbortSignal): Promise<Review> {
  const state = {
    review_policy: POLICY,
    user_request: userRequest.slice(0, 4000),
    pending_action_tool: toolName,
    pending_action_arguments: JSON.stringify(input).slice(0, 8000),
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
    return { ...(await ask(fallback)), reviewer: `haiku (${chosen ? reviewerName(chosen) : "the review setting"} failed)` };
  } catch (error) {
    return held("haiku", failure, error);
  }
}

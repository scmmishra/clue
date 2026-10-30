#!/usr/bin/env bun
// clue's entry point. It does as little as possible before the first paint:
// parse flags, read settings, and hand off. Everything slow loads afterwards.

import { existsSync } from "node:fs";
import { loadSettings, PERMISSION_MODES, VERSION, EFFORTS, type Effort, type PermissionMode, type Settings } from "./config";
import { Session, findSession, latestSessionFile, sessionFile } from "./session";

const HELP = `clue ${VERSION}: a coding agent for the terminal

Usage
  clue                       start a session in this folder
  clue -c                    continue the latest session in this folder
  clue -r [id]               pick any past session, or resume one by id
  clue ask [prompt]          one request; prompt from arguments or stdin
  clue login | logout        save or remove Claude credentials
  clue mcp <command>         manage MCP servers (list, add, remove, login, ...)

Options
  --model <id>               model for this run, such as sonnet or claude-opus-5-5
  --effort <level>           low, medium, high, xhigh or max
  --permission-mode <mode>   ask, auto or full-access
  --full-access              shorthand for --permission-mode full-access
  --json                     with ask: print a JSON result
  --resume <id>              with ask: continue a saved session
  -v, --version              print the version
`;

type Parsed = { command: string; positional: string[]; flags: Record<string, string | boolean> };

function parse(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const takesValue = new Set(["model", "effort", "permission-mode", "resume"]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    // `clue mcp` has its own arguments, such as `--project` and `--`. They reach it untouched.
    if (arg === "mcp" && positional.length === 0) {
      positional.push(...argv.slice(index));
      break;
    }
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) flags[name] = inline;
      else if (takesValue.has(name) && argv[index + 1] && !argv[index + 1].startsWith("-")) flags[name] = argv[++index];
      else flags[name] = true;
    } else if (arg === "-c") flags.continue = true;
    else if (arg === "-r") {
      flags.pick = true;
      if (argv[index + 1] && !argv[index + 1].startsWith("-")) flags.resume = argv[++index];
    } else if (arg === "-v") flags.version = true;
    else if (arg === "-h") flags.help = true;
    else positional.push(arg);
  }
  const commands = new Set(["ask", "login", "logout", "mcp", "help", "version"]);
  const command = positional[0] && commands.has(positional[0]) ? positional.shift()! : "";
  return { command, positional, flags };
}

function fail(message: string): never {
  process.stderr.write(`clue: ${message}\n`);
  process.exit(2);
}

function settingsFrom(flags: Parsed["flags"]): Settings {
  const overrides: Partial<Settings> = {};
  if (typeof flags.model === "string") overrides.model = flags.model;
  if (typeof flags.effort === "string") {
    if (!EFFORTS.includes(flags.effort as Effort)) fail(`--effort must be one of ${EFFORTS.join(", ")}`);
    overrides.effort = flags.effort as Effort;
  }
  if (typeof flags["permission-mode"] === "string") {
    if (!PERMISSION_MODES.includes(flags["permission-mode"] as PermissionMode)) fail(`--permission-mode must be one of ${PERMISSION_MODES.join(", ")}`);
    overrides.permission_mode = flags["permission-mode"] as PermissionMode;
  }
  if (flags["full-access"]) overrides.permission_mode = "full-access";
  return loadSettings(overrides);
}

// Loads a session by id from any folder. The session runs in its own folder.
function sessionById(id: string): Session {
  const meta = findSession(id);
  if (!meta) fail(`no session with id ${id}. Run clue -r to pick one.`);
  if (!existsSync(meta.cwd)) fail(`session ${meta.id} belongs to ${meta.cwd}, which no longer exists.`);
  const session = Session.load(sessionFile(meta));
  if (!session) fail(`session ${meta.id} could not be read.`);
  return session;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  return (await Bun.stdin.text()).trim();
}

async function main() {
  const { command, positional, flags } = parse(process.argv.slice(2));
  if (flags.version || command === "version") return console.log(VERSION);
  if (flags.help || command === "help") return process.stdout.write(HELP);

  if (command === "login" || command === "logout") {
    const { login, logout } = await import("./commands/login");
    return command === "login" ? login() : logout();
  }

  if (command === "mcp") {
    const [{ mcpCommand }, { McpManager }] = await Promise.all([import("./commands/mcp"), import("./mcp/manager")]);
    const manager = new McpManager(process.cwd());
    manager.startAll();
    await mcpCommand(positional, process.cwd(), manager, (lines) => process.stdout.write(`${lines.join("\n")}\n`));
    await manager.closeAll();
    process.exit(0);
  }

  const settings = settingsFrom(flags);
  const { resolveModel } = await import("./agent/models");
  settings.model = resolveModel(settings.model);

  if (command === "ask") {
    const prompt = [positional.join(" "), await readStdin()].filter(Boolean).join("\n\n");
    if (!prompt) fail("clue ask needs a prompt, as arguments or on stdin.");
    const session = typeof flags.resume === "string" ? sessionById(flags.resume) : Session.create(process.cwd());
    if (session.cwd !== process.cwd()) process.chdir(session.cwd);
    const { runAsk } = await import("./commands/ask");
    return runAsk(prompt, settings, session, flags.json === true);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("the interactive shell needs a terminal. Use `clue ask` in scripts.");

  let session: Session | null = null;
  let resumed = false;
  if (typeof flags.resume === "string") {
    session = sessionById(flags.resume);
    resumed = true;
  } else if (flags.continue) {
    const file = latestSessionFile(process.cwd());
    session = file ? Session.load(file) : null;
    resumed = session !== null && !session.isEmpty;
    if (!session) process.stderr.write("clue: no earlier session in this folder. Starting a new one.\n");
  }

  const { App } = await import("./app");
  if (flags.pick && !session) {
    // clue -r with no id: pick first, then start.
    const [{ Screen, Keyboard }, { pickSession }] = await Promise.all([import("./ui/screen"), import("./ui/picker")]);
    const screen = new Screen();
    const keyboard = new Keyboard();
    keyboard.start();
    const choice = await pickSession(screen, keyboard, process.cwd());
    keyboard.stop();
    if (!choice) process.exit(0);
    session = sessionById(choice.id);
    resumed = true;
  }
  session ??= Session.create(process.cwd());
  if (session.cwd !== process.cwd()) process.chdir(session.cwd);
  const app = new App({ settings, session, resumed, benchReady: process.env.CLUE_BENCH_READY === "1" });
  await app.start();
}

main().catch((error) => {
  process.stderr.write(`clue: ${(error as Error)?.stack ?? error}\n`);
  process.exit(1);
});

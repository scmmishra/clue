import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLUE_HOME, ensureDir } from "../config";
import { checkFields, type Tool } from "./types";

// Commands run in the user's shell with the environment their startup files
// produce. Startup files run once; the result is cached until one changes,
// so a slow .zshrc doesn't slow every command.

const SHELL = process.env.SHELL || "/bin/sh";
const ENV_CACHE = join(CLUE_HOME, "shell-env.json");
const STARTUP_FILES = [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile"].map((name) => join(homedir(), name));
const DEFAULT_WAIT_MS = 120_000;
const MAX_BUFFER = 2_000_000;
const DRAIN_MAX_TURNS = 40;

let shellEnv: Promise<Record<string, string>> | null = null;

function startupStamp() {
  return STARTUP_FILES.map((file) => (existsSync(file) ? `${file}:${statSync(file).mtimeMs}` : "")).join("|") + SHELL;
}

async function captureEnv(): Promise<Record<string, string>> {
  const stamp = startupStamp();
  try {
    const cached = JSON.parse(readFileSync(ENV_CACHE, "utf8"));
    if (cached.stamp === stamp) return cached.env;
  } catch {}
  try {
    const marker = "__CLUE_ENV__";
    const proc = Bun.spawn([SHELL, "-ilc", `printf '${marker}'; env -0`], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const text = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const body = text.slice(text.indexOf(marker) + marker.length);
    const env: Record<string, string> = {};
    for (const entry of body.split("\0")) {
      const split = entry.indexOf("=");
      if (split > 0) env[entry.slice(0, split)] = entry.slice(split + 1);
    }
    if (Object.keys(env).length > 3) {
      ensureDir(CLUE_HOME);
      writeFileSync(ENV_CACHE, JSON.stringify({ stamp, env }), { mode: 0o600 });
      return env;
    }
  } catch {}
  return { ...process.env } as Record<string, string>;
}

// Starts capturing the shell environment in the background.
export const warmShellEnv = () => (shellEnv ??= captureEnv());

type Running = {
  id: string;
  command: string;
  proc: Bun.Subprocess;
  terminal: Bun.Terminal;
  // True when background children outlived the shell, so its process group is still alive.
  orphaned: boolean;
  output: string;
  read: number;
  exitCode: number | null;
  exited: Promise<void>;
  startedAt: number;
};

const processes = new Map<string, Running>();
let nextId = 1;

// Terminal output, as plain text: no escape codes, and progress bars redrawn
// with carriage returns keep only their final state.
function plain(chunk: string) {
  return Bun.stripANSI(chunk)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

// Commands run in a real pseudo-terminal, so interactive programs and tools
// that check for a TTY behave as they do in the user's own shell.
//
// The Terminal is built here and passed in as an object. Bun's inline
// `terminal: { ... }` option makes every spawn wait about 16 ms for the PTY to
// close; a Terminal object costs 0.4 ms to build and spawns as fast as pipes.
async function start(command: string, cwd: string): Promise<Running> {
  const env = { ...(await warmShellEnv()), AI_AGENT: "clue", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1", FORCE_COLOR: "0" };
  const decoder = new TextDecoder();
  const running = { id: String(nextId++), command, output: "", read: 0, exitCode: null, orphaned: false, startedAt: Date.now() } as Running;
  const append = (text: string) => {
    running.output += text;
    if (running.output.length > MAX_BUFFER) {
      const cut = running.output.length - MAX_BUFFER;
      running.output = running.output.slice(cut);
      running.read = Math.max(0, running.read - cut);
    }
  };
  const terminal = new Bun.Terminal({
    cols: 160,
    rows: 48,
    data: (_terminal, data) => append(plain(decoder.decode(data, { stream: true }))),
  });
  running.terminal = terminal;
  try {
    // detached makes the command lead its own process group. Without it a PTY command
    // stays in clue's group, so stop could only kill the wrapper shell, not its children.
    running.proc = Bun.spawn([SHELL, "-c", command], { cwd, env, terminal, detached: true });
  } catch (error) {
    terminal.close();
    running.output = (error as Error).message;
    running.exitCode = 127;
    running.exited = Promise.resolve();
    return running;
  }
  running.exited = running.proc.exited.then(async (code) => {
    running.exitCode = code ?? 1;
    // Output written just before exit can land a moment later. Wait until it stops
    // growing, up to a cap, since a background child may keep writing forever.
    let seen = -1;
    for (let turn = 0; turn < DRAIN_MAX_TURNS && running.output.length !== seen; turn++) {
      seen = running.output.length;
      await Bun.sleep(1);
    }
    // A child that outlives the shell, such as `server &`, keeps the PTY open until stopAllProcesses.
    running.orphaned = groupAlive(running.proc.pid);
    if (!running.orphaned) running.terminal.close();
  });
  processes.set(running.id, running);
  return running;
}

// True while any process of the command's group, including its background children, is alive.
function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function kill(running: Running) {
  // A finished command has nothing to stop, unless background children outlived its shell.
  // Only then is the pid still ours: a group's id can't be reused while the group exists.
  if (running.exitCode !== null && !(running.orphaned && groupAlive(running.proc.pid))) return;
  // The command leads its own group (detached), so its pid is the group id.
  try {
    process.kill(-running.proc.pid, "SIGTERM");
  } catch {
    running.proc.kill("SIGTERM");
  }
  setTimeout(() => {
    if (running.exitCode !== null && !groupAlive(running.proc.pid)) return;
    try {
      process.kill(-running.proc.pid, "SIGKILL");
    } catch {
      running.proc.kill("SIGKILL");
    }
  }, 2000).unref();
}

export function stopAllProcesses() {
  for (const running of processes.values()) {
    kill(running);
    if (!running.terminal.closed) running.terminal.close();
  }
}

// Resolves after `ms` or when the signal aborts. Call cancel() when done, so a
// finished command doesn't leave a long timer behind.
function waitFor(ms: number, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout>;
  let onAbort = () => {};
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

// Waits for the process to exit, or for the timeout. True when it exited.
async function exitedWithin(running: Running, ms: number, signal: AbortSignal) {
  const timeout = waitFor(ms, signal);
  const exited = await Promise.race([running.exited.then(() => true), timeout.promise.then(() => false)]);
  timeout.cancel();
  return exited;
}

function takeOutput(running: Running) {
  const fresh = running.output.slice(running.read);
  running.read = running.output.length;
  return fresh;
}

function report(running: Running, fresh: string) {
  const status =
    running.exitCode === null
      ? `[Still running as process ${running.id}. Use action "interact" with id "${running.id}" to read more output or send input, or "stop" to end it.]`
      : `[Exit code ${running.exitCode}]`;
  return `${fresh.trimEnd() || "(no output)"}\n\n${status}`;
}

type ShellInput = { action?: "run" | "interact" | "stop"; command?: string; id?: string; input?: string; wait_ms?: number };

export const shell: Tool<ShellInput> = {
  name: "shell",
  description: [
    "Run commands in the user's shell, in the project folder.",
    'action "run" (default) starts command and waits until it exits or wait_ms passes (default 120000).',
    'A command still running after wait_ms keeps running in the background: use a short wait_ms for dev servers and watchers.',
    'action "interact" reads new output from a running process and optionally writes input to its stdin.',
    'action "stop" ends a running process.',
    "Commands run in a pseudo-terminal, so interactive programs work; output comes back as plain text with no colors or pager.",
  ].join(" "),
  schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["run", "interact", "stop"] },
      command: { type: "string", description: 'Command to run, for action "run".' },
      id: { type: "string", description: 'Process id from an earlier "run", for "interact" and "stop".' },
      input: { type: "string", description: 'Text to write to stdin, for "interact". Include "\\n" to press Enter.' },
      wait_ms: { type: "number", description: "How long to wait for output, in milliseconds." },
    },
  },
  kind: "command",
  label: (input, done) => {
    if (input.action === "stop") return `${done ? "Stopped" : "Stopping"} process ${input.id}`;
    if (input.action === "interact") return `${done ? "Checked" : "Checking"} process ${input.id}`;
    return `${done ? "Ran" : "Running"} ${input.command ?? ""}`;
  },
  validate(input) {
    const error = checkFields(input, { action: "string?", command: "string?", id: "string?", input: "string?", wait_ms: "number?" });
    if (error) return error;
    const action = input.action ?? "run";
    if (action === "run" && !input.command) return 'action "run" needs a command.';
    if (action !== "run" && !input.id) return `action "${action}" needs an id.`;
    return null;
  },
  async run(input, context) {
    const action = input.action ?? "run";
    if (action === "run") {
      const running = await start(input.command!, context.cwd);
      const limit = Math.max(500, input.wait_ms ?? DEFAULT_WAIT_MS);
      const done = await exitedWithin(running, limit, context.signal);
      if (context.signal.aborted && !done) kill(running);
      const fresh = takeOutput(running);
      const failed = running.exitCode !== null && running.exitCode !== 0;
      return {
        content: report(running, fresh),
        full: `$ ${running.command}\n${running.output}`,
        isError: failed,
        note: running.exitCode === null ? `running as ${running.id}` : failed ? `exit ${running.exitCode}` : undefined,
      };
    }
    const running = processes.get(input.id!);
    if (!running) return { content: `No process with id ${input.id}.`, isError: true };
    if (action === "stop") {
      kill(running);
      await exitedWithin(running, 3000, context.signal);
      return { content: report(running, takeOutput(running)) };
    }
    if (input.input && running.exitCode === null) running.terminal.write(input.input);
    await exitedWithin(running, Math.max(100, input.wait_ms ?? 1500), context.signal);
    return { content: report(running, takeOutput(running)) };
  },
};

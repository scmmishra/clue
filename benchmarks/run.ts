// Benchmarks for clue's three waits: start, resume and first token.
//   bun benchmarks/run.ts [--runs 30] [--check]
// Times are wall-clock from spawn, measured with Bun.nanoseconds(). Each
// benchmark runs in a pseudo-terminal, the way a person starts clue.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockApi } from "../test/mock-api";
import { BUDGETS_MS, overBudget } from "./budget";

const ROOT = join(import.meta.dir, "..");
const BINARY = join(ROOT, "dist", "clue");
// The Bun running this script, not whatever "bun" is on PATH (a version-manager shim adds ~30 ms).
const SOURCE = [process.execPath, join(ROOT, "src", "main.ts")];
const runsFlag = process.argv.indexOf("--runs");
const RUNS = runsFlag > 0 ? Number(process.argv[runsFlag + 1]) : 30;
const WARMUP = 3;

// The benchmark's own clue home. Set before any clue module loads, so nothing touches ~/.clue.
const home = realpathSync(mkdtempSync(join(tmpdir(), "clue-bench-")));
process.env.CLUE_HOME = home;
const { Session, latestSessionFile } = await import("../src/session");
const project = join(home, "project");
mkdirSync(project, { recursive: true });

type Stats = { median: number; p90: number; min: number };

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { median: at(0.5), p90: at(0.9), min: sorted[0] };
}

// Runs a command in a PTY. Returns wall time and what it printed.
async function inPty(command: string[], env: Record<string, string> = {}) {
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 120, rows: 40, data: (_t, data) => (output += decoder.decode(data)) });
  const start = Bun.nanoseconds();
  const proc = Bun.spawn(command, { cwd: project, env: { ...process.env, CLUE_HOME: home, ...env }, terminal });
  await proc.exited;
  const ms = (Bun.nanoseconds() - start) / 1e6;
  terminal.close();
  return { ms, output };
}

async function sample(command: string[], env: Record<string, string> = {}, pick?: (output: string) => number | null) {
  const wall: number[] = [];
  const internal: number[] = [];
  for (let run = 0; run < WARMUP + RUNS; run++) {
    const result = await inPty(command, env);
    if (run < WARMUP) continue;
    wall.push(result.ms);
    const value = pick?.(result.output);
    if (value !== null && value !== undefined) internal.push(value);
  }
  return { wall: stats(wall), internal: internal.length ? stats(internal) : null };
}

const readyMs = (output: string) => {
  const match = output.match(/ready ([\d.]+)ms/);
  return match ? Number(match[1]) : null;
};

// A long session to resume: 120 prompts, each with text and two tool calls.
function seedSession(turns: number) {
  const session = Session.create(project);
  for (let index = 0; index < turns; index++) {
    session.appendMessage({ role: "user", content: `Change number ${index}: update the handler and run the tests` });
    session.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: `I'll update the handler for change ${index}.` },
        { type: "tool_use", id: `toolu_${index}_a`, name: "read_file", input: { path: "src/handler.ts" } },
        { type: "tool_use", id: `toolu_${index}_b`, name: "shell", input: { command: "bun test" } },
      ],
    });
    for (const [suffix, kind, label] of [["a", "read", "Read src/handler.ts"], ["b", "command", "Ran bun test"]] as const) {
      session.append({ t: "tool", tool: { id: `toolu_${index}_${suffix}`, name: kind === "read" ? "read_file" : "shell", input: {}, label, kind, output: "x".repeat(2000), isError: false, startedAt: Date.now(), ms: 120 } });
    }
    session.appendMessage({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `toolu_${index}_a`, content: "export function handler() {}\n".repeat(40) },
        { type: "tool_result", tool_use_id: `toolu_${index}_b`, content: "12 pass\n0 fail" },
      ],
    });
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: `## Done\n\nUpdated the handler. **12 tests pass.**\n\n- one\n- two\n` }] });
    session.append({ t: "turn", turn: { prompt: `Change number ${index}`, startedAt: Date.now(), ms: 9000, firstTokenMs: 800, tools: 2, usage: { input: 100, output: 300, cacheRead: 40000, cacheWrite: 900, webSearches: 0 }, cost: 0.02, model: "claude-opus-5-5", stop: "end_turn" } });
  }
  return session;
}

function row(name: string, value: Stats | null) {
  if (!value) return `| ${name} | – | – | – |`;
  return `| ${name} | ${value.median.toFixed(1)} | ${value.p90.toFixed(1)} | ${value.min.toFixed(1)} |`;
}

const lines: string[] = [];
const table = (title: string, rows: string[]) => lines.push(`\n### ${title}\n`, "| | median ms | p90 ms | min ms |", "|---|---|---|---|", ...rows);

console.error(`clue benchmarks: ${RUNS} runs each after ${WARMUP} warmups, Bun ${Bun.version}, ${process.platform}-${process.arch}`);

// 1. Process start and exit, no UI.
const versionBinary = await sample([BINARY, "--version"]);
const versionSource = await sample([...SOURCE, "--version"]);
table("clue --version (start and exit)", [row("binary", versionBinary.wall), row("from source", versionSource.wall)]);

// 2. Start to a ready prompt.
const readyBinary = await sample([BINARY], { CLUE_BENCH_READY: "1" }, readyMs);
const readySource = await sample(SOURCE, { CLUE_BENCH_READY: "1" }, readyMs);
table("Start to ready prompt", [
  row("binary, inside the process", readyBinary.internal),
  row("binary, wall clock incl. exit", readyBinary.wall),
  row("from source, inside the process", readySource.internal),
]);

// 3. Resume a long session to a ready prompt, last screen printed.
seedSession(120);
const check = await inPty([BINARY, "-c"], { CLUE_BENCH_READY: "1" });
if (!Bun.stripANSI(check.output).includes("120 prompts")) throw new Error("clue -c did not resume the seeded session");
const resumeBinary = await sample([BINARY, "-c"], { CLUE_BENCH_READY: "1" }, readyMs);
table("Resume a 120-prompt session to ready prompt (clue -c)", [row("binary, inside the process", resumeBinary.internal), row("binary, wall clock incl. exit", resumeBinary.wall)]);

// 4. First token, client side: against a local stand-in API, so this is clue's own overhead.
const server = startMockApi();
const firstToken: number[] = [];
const askWall: number[] = [];
for (let run = 0; run < WARMUP + RUNS; run++) {
  const start = Bun.nanoseconds();
  const proc = Bun.spawn([BINARY, "ask", "--json", "what is this package?"], {
    cwd: project,
    env: { ...process.env, CLUE_HOME: home, ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "sk-ant-bench" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  if (run < WARMUP) continue;
  askWall.push((Bun.nanoseconds() - start) / 1e6);
  const result = JSON.parse(text);
  if (typeof result.first_token_ms === "number") firstToken.push(result.first_token_ms);
}
server.stop(true);
table("First token, clue's own overhead (local stand-in API, no model time)", [
  row("prompt sent to first token", stats(firstToken)),
  row("clue ask, whole run with one tool call", stats(askWall)),
]);

// 5. Hot paths inside one process.
const { renderMarkdown } = await import("../src/ui/markdown");
const { replay } = await import("../src/ui/replay");
const markdown = `## Summary\n\nThe spec compares \`last_activity_at\` with **Time.now**.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`;
const micro = (fn: () => unknown, iterations: number) => {
  for (let index = 0; index < 50; index++) fn();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = Bun.nanoseconds();
    fn();
    samples.push((Bun.nanoseconds() - start) / 1e6);
  }
  return stats(samples);
};
const latest = latestSessionFile(project)!;
const micros = (value: Stats) => ({ median: value.median * 1000, p90: value.p90 * 1000, min: value.min * 1000 });
lines.push("\n### Hot paths, inside one process\n", "| | median µs | p90 µs | min µs |", "|---|---|---|---|");
lines.push(
  row("render a Markdown reply (Bun.markdown.ansi)", micros(micro(() => renderMarkdown(markdown, 100), 2000))),
  row("load the 120-prompt session file (Bun.JSONL)", micros(micro(() => Session.load(latest), 200))),
  row("render its last screen for resume", micros(micro(() => replay(Session.load(latest)!, 32), 200))),
);

console.log(lines.join("\n"));
rmSync(home, { recursive: true, force: true });

// --check fails the run when a wait is over its budget. `bun run bench:check` uses it.
if (process.argv.includes("--check")) {
  const problems = overBudget({ launch: readyBinary.internal?.p90 ?? null, resume: resumeBinary.internal?.p90 ?? null });
  for (const problem of problems) console.error(`Over budget: ${problem}`);
  if (problems.length) process.exit(1);
  console.error(`Within budget: launch under ${BUDGETS_MS.launch} ms, resume under ${BUDGETS_MS.resume} ms.`);
}

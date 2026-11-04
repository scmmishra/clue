// Compares two clue builds on the same machine, for CI. A shared runner is too slow and too noisy
// for absolute budgets, but it slows both builds alike, so the ratio between them holds.
//   bun benchmarks/compare.ts --base <binary> --head <binary> [--rounds 8] [--runs 10] [--out results.json]
// The builds take turns, in a different order each round. A wait counts as a regression only when
// the head is more than THRESHOLD slower overall and slower in most rounds.

import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockApi } from "../test/mock-api";
import { seedSession } from "./seed";

// More than this much slower overall...
const THRESHOLD = 0.15;
// ...and slower in at least this share of rounds.
const ROUNDS_SLOWER = 0.75;
const WARMUP = 2;

function flag(name: string, fallback?: string) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const builds = { base: resolve(flag("base")), head: resolve(flag("head")) };
const ROUNDS = Number(flag("rounds", "8"));
const RUNS = Number(flag("runs", "10"));
const out = process.argv.includes("--out") ? resolve(flag("out")) : null;

// Both builds read the same clue home and the same seeded session. Set before any clue module loads.
const home = realpathSync(mkdtempSync(join(tmpdir(), "clue-compare-")));
process.env.CLUE_HOME = home;
const { Session } = await import("../src/session");
const project = join(home, "project");
mkdirSync(project, { recursive: true });
seedSession(Session, project, 120);

const server = startMockApi();
const env = {
  ...process.env,
  CLUE_HOME: home,
  ANTHROPIC_BASE_URL: server.url.origin,
  ANTHROPIC_API_KEY: "sk-ant-bench",
};

// The time clue reports to its ready prompt, run in a pseudo-terminal the way a person starts it.
async function readyMs(command: string[]) {
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 120, rows: 40, data: (_t, data) => (output += decoder.decode(data)) });
  const proc = Bun.spawn(command, { cwd: project, env: { ...env, CLUE_BENCH_READY: "1" }, terminal });
  const code = await proc.exited;
  // On Linux the output can land just after the process exits, so wait for it before closing the PTY.
  const ready = /ready ([\d.]+)ms/;
  for (let waited = 0; !ready.test(output) && waited < 2000; waited += 10) await Bun.sleep(10);
  terminal.close();
  const match = output.match(ready);
  if (!match) {
    const tail = Bun.stripANSI(output).trim().slice(-500);
    throw new Error(`${command.join(" ")} never reported a ready prompt (exit ${code}):\n${tail}`);
  }
  return Number(match[1]);
}

// clue's own time from sending the prompt to the first streamed token, against the local stand-in API.
async function firstTokenMs(binary: string) {
  const proc = Bun.spawn([binary, "ask", "--json", "what is this package?"], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const value = JSON.parse(text).first_token_ms;
  if (typeof value !== "number") throw new Error(`${binary} ask reported no first token`);
  return value;
}

const WAITS = {
  "Start to ready prompt": (binary: string) => readyMs([binary]),
  "Resume a 120-prompt session": (binary: string) => readyMs([binary, "-c"]),
  "First token, clue's own time": firstTokenMs,
};
type Wait = keyof typeof WAITS;
type Build = keyof typeof builds;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// samples[wait][build] holds every run. rounds[wait][build] holds each round's median.
const samples = {} as Record<Wait, Record<Build, number[]>>;
const rounds = {} as Record<Wait, Record<Build, number[]>>;
for (const wait of Object.keys(WAITS) as Wait[]) {
  samples[wait] = { base: [], head: [] };
  rounds[wait] = { base: [], head: [] };
}

console.error(`Comparing ${builds.base} with ${builds.head}: ${ROUNDS} rounds of ${RUNS} runs, Bun ${Bun.version}`);
for (let round = 0; round < ROUNDS; round++) {
  const order: Build[] = round % 2 ? ["head", "base"] : ["base", "head"];
  for (const [wait, measure] of Object.entries(WAITS) as [Wait, (binary: string) => Promise<number>][]) {
    for (const build of order) {
      const values: number[] = [];
      for (let run = 0; run < WARMUP + RUNS; run++) {
        const value = await measure(builds[build]);
        if (run >= WARMUP) values.push(value);
      }
      samples[wait][build].push(...values);
      rounds[wait][build].push(median(values));
    }
  }
  console.error(`round ${round + 1} of ${ROUNDS} done`);
}
server.stop(true);

const results = (Object.keys(WAITS) as Wait[]).map((wait) => {
  const base = median(samples[wait].base);
  const head = median(samples[wait].head);
  const ratio = head / base;
  const slowerRounds = rounds[wait].head.filter((value, index) => value > rounds[wait].base[index]).length;
  const regressed = ratio > 1 + THRESHOLD && slowerRounds >= Math.ceil(ROUNDS * ROUNDS_SLOWER);
  return { wait, base, head, ratio, slowerRounds, regressed };
});

const percent = (ratio: number) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(1)}%`;
const lines = [
  "### Performance against the base build",
  "",
  `Medians of ${ROUNDS * RUNS} runs per build, taking turns over ${ROUNDS} rounds on one runner. A shared runner is slower than a laptop, so compare the two columns, not the milliseconds. A wait fails when the head is more than ${THRESHOLD * 100}% slower and slower in at least ${Math.ceil(ROUNDS * ROUNDS_SLOWER)} of ${ROUNDS} rounds.`,
  "",
  "| Wait | Base | Head | Change | Rounds slower | |",
  "|---|---|---|---|---|---|",
  ...results.map(
    (r) =>
      `| ${r.wait} | ${r.base.toFixed(1)} ms | ${r.head.toFixed(1)} ms | ${percent(r.ratio)} | ${r.slowerRounds} of ${ROUNDS} | ${r.regressed ? "regressed" : "ok"} |`,
  ),
  "",
];
const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
if (out) {
  const record = {
    at: new Date().toISOString(),
    sha: process.env.GITHUB_SHA ?? null,
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
    rounds: ROUNDS,
    runs: RUNS,
    results,
    samples,
  };
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
}
process.exit(results.some((r) => r.regressed) ? 1 : 0);

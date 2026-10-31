// Benchmarks clue's tools outside the agent loop: each tool's run() is called
// directly against a generated repository, and compared with the fastest
// straightforward way to do the same job.
//   bun benchmarks/tools.ts [--runs 50]

import { UndoStack } from "../src/agent/undo";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "clue-tools-bench-")));
// Set before any clue module loads, so nothing touches ~/.clue.
process.env.CLUE_HOME = join(root, ".clue-home");

const { Session } = await import("../src/session");
const { editFile, globFiles, grepFiles, readFile, writeFile } = await import("../src/tools/files");
const { shell, stopAllProcesses, warmShellEnv } = await import("../src/tools/shell");
const { capabilitySearch } = await import("../src/tools/mcp");
const { skillTool, discoverSkills } = await import("../src/tools/skills");
const { readToolResult } = await import("../src/tools/misc");
const { buildContext, prefetchGitStatus } = await import("../src/agent/context");
const { Permissions, commandIsRoutine } = await import("../src/permissions");
type Ctx = import("../src/tools/types").ToolContext;

const runsFlag = process.argv.indexOf("--runs");
const RUNS = runsFlag > 0 ? Number(process.argv[runsFlag + 1]) : 50;

// ---------------------------------------------------------------------------
// A repository shaped like a real one: sources, docs, a large node_modules,
// a .git folder (so ripgrep honors .gitignore) and a 20 MB log file.

const repo = join(root, "repo");
const SOURCE_FILES = 1500;
const MODULE_FILES = 9000;
const NEEDLE = "NEEDLE_7731";

function sourceFile(index: number) {
  const lines: string[] = [`// Module ${index}`, `import { helper } from "./helper";`, ""];
  for (let fn = 0; fn < 40; fn++) {
    lines.push(`export function handler${index}_${fn}(input: string, options: Record<string, unknown> = {}) {`);
    lines.push(`  // TODO: validate input for handler ${fn}`);
    lines.push(`  const trimmed = input.trim().toLowerCase();`);
    lines.push(index % 50 === 0 && fn === 7 ? `  return helper(trimmed, "${NEEDLE}");` : `  return helper(trimmed, options);`);
    lines.push(`}`, "");
  }
  return lines.join("\n");
}

async function generate() {
  mkdirSync(join(repo, "src"), { recursive: true });
  const jobs: Promise<unknown>[] = [];
  const flush = async () => {
    await Promise.all(jobs);
    jobs.length = 0;
  };
  for (let index = 0; index < SOURCE_FILES; index++) {
    const dir = join(repo, "src", `area${index % 30}`, `part${index % 7}`);
    mkdirSync(dir, { recursive: true });
    jobs.push(Bun.write(join(dir, `module${index}.ts`), sourceFile(index)));
    if (jobs.length >= 200) await flush();
  }
  for (let index = 0; index < 120; index++) {
    mkdirSync(join(repo, "docs"), { recursive: true });
    jobs.push(Bun.write(join(repo, "docs", `page${index}.md`), `# Page ${index}\n\n${"Some documentation text about handlers.\n".repeat(30)}`));
  }
  await flush();
  for (let index = 0; index < MODULE_FILES; index++) {
    const dir = join(repo, "node_modules", `pkg${index % 300}`, "lib");
    mkdirSync(dir, { recursive: true });
    jobs.push(Bun.write(join(dir, `file${index}.js`), `exports.value${index} = function () { return ${index}; };\n`.repeat(12)));
    if (jobs.length >= 300) await flush();
  }
  await flush();
  await Bun.write(join(repo, ".gitignore"), "node_modules\ndist\n");
  await Bun.write(join(repo, "AGENTS.md"), "Use Bun. Keep functions small.\n");
  // 20 MB log: 200,000 lines.
  const line = "2026-10-30T10:15:42.123Z INFO request completed in 18ms status=200 path=/api/v1/items/42\n";
  await Bun.write(join(repo, "big.log"), line.repeat(200_000));
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
}

const context = (): Ctx => {
  const session = Session.create(repo);
  session.ephemeral = true;
  return {
    cwd: repo,
    session,
    signal: new AbortController().signal,
    mcp: { settle: async () => {}, tools: () => [], servers: new Map(), configuredNames: () => [] } as never,
    skills: () => [],
    readStamps: new Map(),
  undo: new UndoStack(),
    seenInstructions: new Set(),
    ask: async () => null,
    progress: () => {},
    subagent: async () => ({ content: "" }),
    interactive: false,
  };
};

// ---------------------------------------------------------------------------
// Measuring

type Stats = { median: number; p90: number; min: number };

// `setup` runs before each timed call and is not counted.
async function time(fn: () => unknown | Promise<unknown>, runs = RUNS, warmup = 5, setup?: () => unknown | Promise<unknown>): Promise<Stats> {
  for (let index = 0; index < warmup; index++) {
    await setup?.();
    await fn();
  }
  const samples: number[] = [];
  for (let index = 0; index < runs; index++) {
    await setup?.();
    const start = Bun.nanoseconds();
    await fn();
    samples.push((Bun.nanoseconds() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(runs * 0.5)], p90: samples[Math.floor(runs * 0.9)], min: samples[0] };
}

const lines: string[] = [];
const fmt = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(ms < 10 ? 2 : 1)} ms`);

type Row = [name: string, fn: () => unknown | Promise<unknown>, baseline?: boolean, setup?: () => unknown | Promise<unknown>];

async function compare(group: string, rows: Row[], runs = RUNS) {
  lines.push(`\n### ${group}\n`, "| | median | p90 | vs baseline |", "|---|---|---|---|");
  let base: number | null = null;
  const results: [string, Stats, boolean][] = [];
  for (const [name, fn, isBaseline, setup] of rows) {
    const stats = await time(fn, runs, 5, setup);
    results.push([name, stats, !!isBaseline]);
    if (isBaseline) base = stats.median;
  }
  for (const [name, stats, isBaseline] of results) {
    const ratio = base === null || isBaseline ? "baseline" : `${(stats.median / base).toFixed(1)}×`;
    lines.push(`| ${name} | ${fmt(stats.median)} | ${fmt(stats.p90)} | ${ratio} |`);
  }
}

console.error(`clue tool benchmarks: ${RUNS} runs each, Bun ${Bun.version}, ${process.platform}-${process.arch}`);
const generated = Bun.nanoseconds();
await generate();
console.error(`generated ${SOURCE_FILES} sources, ${MODULE_FILES} node_modules files, 20 MB log in ${((Bun.nanoseconds() - generated) / 1e9).toFixed(1)}s`);
await warmShellEnv();

const small = "src/area0/part0/module0.ts";
const smallAbs = join(repo, small);

// ---------------------------------------------------------------------------

await compare("read_file", [
  ["200-line source file, whole", async () => readFile.run({ path: small }, context())],
  ["  baseline: Bun.file().text()", async () => Bun.file(smallAbs).text(), true],
  ["first 50 lines of the 20 MB log", async () => readFile.run({ path: "big.log", limit: 50 }, context())],
  ["  baseline: read the first 16 KB", async () => Bun.file(join(repo, "big.log")).slice(0, 16384).text(), true],
  ["100 lines from the middle of the 20 MB log", async () => readFile.run({ path: "big.log", offset: 150_000, limit: 100 }, context())],
]);

await compare("glob_files", [
  ['"src/**/*.ts" (1,500 matches, node_modules present)', async () => globFiles.run({ pattern: "src/**/*.ts" }, context())],
  ['"**/*.ts" over the whole repo', async () => globFiles.run({ pattern: "**/*.ts" }, context())],
  ['"**/*.md"', async () => globFiles.run({ pattern: "**/*.md" }, context())],
  ["  baseline: rg --files -g '**/*.ts'", async () => Bun.spawn(["rg", "--files", "-g", "**/*.ts"], { cwd: repo, stdout: "pipe" }).stdout.text(), true],
]);

await compare("grep_files", [
  ["literal, 30 matches across the repo", async () => grepFiles.run({ pattern: NEEDLE }, context())],
  ["  baseline: rg (same flags, spawned)", async () => {
    const proc = Bun.spawn(["rg", "--line-number", "--no-heading", "--color", "never", "--max-columns", "400", "--max-count", "50", "--fixed-strings", "--", NEEDLE, "."], { cwd: repo, stdout: "pipe" });
    await proc.stdout.text();
    await proc.exited;
  }, true],
  ["common word, hits in every file (400-line cap)", async () => grepFiles.run({ pattern: "handler" }, context())],
  ["regex with glob filter", async () => grepFiles.run({ pattern: "handler\\d+_7\\(", regex: true, glob: "*.ts" }, context())],
]);

await compare("edit_file and write_file", [
  ["edit_file: one replacement in a 200-line file", async () => {
    const ctx = context();
    const file = join(repo, "scratch-edit.ts");
    await Bun.write(file, sourceFile(1));
    await readFile.run({ path: "scratch-edit.ts" }, ctx);
    await editFile.run({ path: "scratch-edit.ts", old_string: "// Module 1", new_string: "// Module one" }, ctx);
  }],
  ["  baseline: read, replace, write", async () => {
    const file = join(repo, "scratch-edit-base.ts");
    await Bun.write(file, sourceFile(1));
    const text = await Bun.file(file).text();
    await Bun.write(file, text.replace("// Module 1", "// Module one"));
  }, true],
  ["write_file: new 5 KB file", async () => {
    const ctx = context();
    await writeFile.run({ path: `scratch/new-${Bun.nanoseconds()}.ts`, content: sourceFile(2) }, ctx);
  }],
  ["  baseline: Bun.write", async () => Bun.write(join(repo, `scratch/base-${Bun.nanoseconds()}.ts`), sourceFile(2)), true],
]);

await compare("shell", [
  ["echo hi, through the tool (PTY)", async () => shell.run({ command: "echo hi" }, context())],
  ["  baseline: Bun.spawn, pipes, no PTY", async () => {
    const proc = Bun.spawn([process.env.SHELL || "/bin/sh", "-c", "echo hi"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    await proc.stdout.text();
    await proc.exited;
  }, true],
  ["git status, through the tool", async () => shell.run({ command: "git status --short" }, context())],
  ["exit 3 (non-zero), through the tool", async () => shell.run({ command: "exit 3" }, context())],
], 30);

// In-process pieces.
const names = (count: number) => Array.from({ length: count }, (_, index) => ({ server: `srv${index % 20}`, name: `tool_${index}`, description: `Does thing number ${index} with records and files`, inputSchema: { type: "object", properties: { id: { type: "string" } } } }));
const bigMcp = { settle: async () => {}, tools: () => names(500), servers: new Map(), configuredNames: () => [] };

await compare("in-process tools", [
  ["capability_search over 500 MCP tools", async () => capabilitySearch.run({ query: "records files thing 42" }, { ...context(), mcp: bigMcp as never })],
  ["read_tool_result, page of a 200 KB result", (() => {
    const ctx = context();
    ctx.session.tools.set("toolu_big", { id: "toolu_big", name: "shell", input: {}, label: "", kind: "command", output: "x".repeat(200_000), isError: false, startedAt: 0, ms: 0 });
    return async () => readToolResult.run({ id: "toolu_big", offset: 100_000 }, ctx);
  })()],
  ["permission decision for a shell command", () => new Permissions("auto", {}, repo).decide(shell, { command: "bun test && git diff" })],
  ["commandIsRoutine", () => commandIsRoutine("git status && bun run typecheck | head -20")],
]);

// Skills: 40 skills on disk.
const skillsHome = join(repo, ".clue", "skills");
for (let index = 0; index < 40; index++) {
  mkdirSync(join(skillsHome, `skill${index}`), { recursive: true });
  await Bun.write(join(skillsHome, `skill${index}`, "SKILL.md"), `---\nname: skill${index}\ndescription: Does task number ${index} when asked about widgets\n---\n\n# Skill ${index}\n\nSteps go here.\n`);
}
await compare("skills and first-turn setup", [
  ["discoverSkills: 40 skills on disk", () => discoverSkills(repo)],
  ["skill tool: read one SKILL.md", async () => skillTool.run({ name: "skill3" }, { ...context(), skills: () => discoverSkills(repo) })],
  ["buildContext, cold: runs git status now", async () => buildContext(repo, discoverSkills(repo), [], new Set())],
  // The app starts git status at launch. By the time a prompt is sent, it is done.
  ["buildContext, git status prefetched while typing", async () => buildContext(repo, discoverSkills(repo), [], new Set()), false, async () => {
    prefetchGitStatus(repo);
    await Bun.sleep(60);
  }],
]);

console.log(lines.join("\n"));
stopAllProcesses();
// CLUE_BENCH_KEEP=1 leaves the generated repository in place, for trying other tools on it.
if (process.env.CLUE_BENCH_KEEP) console.error(`kept ${repo}`);
else rmSync(root, { recursive: true, force: true });

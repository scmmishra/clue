import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDuration, readSession, runUsage, sessionFiles, usageAcross } from "../src/commands/usage";
import { paths } from "../src/config";
import { projectKey, type TurnRecord } from "../src/session";

const MINUTE = 60_000;
const here = realpathSync(mkdtempSync(join(tmpdir(), "clue-usage-here-")));
const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "clue-usage-elsewhere-")));

const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  prompt: "fix the bug",
  startedAt: 0,
  ms: MINUTE,
  firstTokenMs: 1000,
  tools: 0,
  usage: { input: 0, output: 100, cacheRead: 9000, cacheWrite: 1000, webSearches: 0 },
  cost: 1,
  model: "claude-opus-5-5",
  stop: "end_turn",
  ...overrides,
});

// Writes a session file the way clue does: one JSON record per line.
function writeSession(cwd: string, id: string, records: object[]) {
  const dir = join(paths.sessions, projectKey(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const lines = [{ t: "session", id, cwd, created: 0, version: "test" }, ...records];
  writeFileSync(file, `${lines.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

const plain = (lines: string[]) => lines.map((line) => Bun.stripANSI(line)).join("\n");

beforeEach(() => rmSync(paths.sessions, { recursive: true, force: true }));

test("a session adds up its prompts, compactions, warm-ups and advisor calls", () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 500, webSearches: 0 };
  const file = writeSession(here, "a", [
    { t: "turn", turn: turn({ prompt: "first line\nsecond line", cost: 2 }) },
    { t: "tool", tool: { id: "x", name: "advisor", kind: "advisor", startedAt: 10, ms: 1 } },
    { t: "compacted", summary: "s", usage, cost: 0.5, model: "claude-opus-5-5", at: 20 },
    { t: "spend", usage, cost: 0.25, model: "claude-opus-5-5", at: 30 },
  ]);
  const session = readSession(file)!;
  expect(session.cost).toBe(2.75);
  expect(session.title).toBe("first line");
  expect(session.advisorCalls).toBe(1);
  expect(session.compactions).toHaveLength(1);
  expect(session.warmUps).toHaveLength(1);
});

test("a named session shows its name, and one with nothing paid for is left out", () => {
  const named = writeSession(here, "b", [
    { t: "name", name: "release" },
    { t: "turn", turn: turn() },
  ]);
  expect(readSession(named)!.title).toBe("release");
  expect(readSession(writeSession(here, "c", []))).toBeNull();
});

test("--since leaves out what was paid for before it", () => {
  const file = writeSession(here, "d", [
    { t: "turn", turn: turn({ startedAt: 0, cost: 5 }) },
    { t: "turn", turn: turn({ startedAt: 100, cost: 1 }) },
  ]);
  expect(readSession(file, 50)!.cost).toBe(1);
  expect(readSession(file, 200)).toBeNull();
});

test("the report shows totals, models, fast mode, cache shares and the top sessions", () => {
  writeSession(here, "e", [
    { t: "turn", turn: turn({ cost: 3 }) },
    { t: "turn", turn: turn({ startedAt: 2 * MINUTE, cost: 1, fast: true, costIsMinimum: true }) },
  ]);
  writeSession(elsewhere, "f", [{ t: "turn", turn: turn({ model: "claude-sonnet-5-5", cost: 0.5, prompt: "cheap" }) }]);
  const sessions = sessionFiles().flatMap((file) => readSession(file) ?? []);
  const text = plain(usageAcross(sessions, "all time"));
  expect(text).toContain("2 sessions · 3 prompts · all time");
  expect(text).toContain("Total               $4.50+");
  expect(text).toMatch(/opus 5\.5 +█+▍ +\$4\.00 +89%/);
  expect(text).toMatch(/sonnet 5\.5 +██▋ +\$0\.50 +11%/);
  expect(text).toContain("Fast mode           $1.00 at the fast price");
  expect(text).toMatch(/Read +█+▋ +27k +90%/);
  expect(text).toMatch(/Written +██▍ +3\.0k +10%/);
  expect(text).toMatch(/Uncached +0 +0%/);
  const top = text.slice(text.indexOf("Top sessions"));
  expect(top.indexOf("fix the bug")).toBeLessThan(top.indexOf("cheap"));
});

test("gaps over 5 minutes count, with the cache writes of the prompts after them", () => {
  writeSession(here, "g", [
    { t: "turn", turn: turn({ startedAt: 0 }) },
    // Starts 3 minutes after the first ends: the cache is still alive.
    { t: "turn", turn: turn({ startedAt: 4 * MINUTE }) },
    // Starts 10 minutes after the second ends, and writes three times as much.
    { t: "turn", turn: turn({ startedAt: 15 * MINUTE, usage: { ...turn().usage, cacheWrite: 3000 } }) },
  ]);
  const sessions = sessionFiles().flatMap((file) => readSession(file) ?? []);
  const text = plain(usageAcross(sessions, "all time"));
  // Opus 5.5 writes the cache at $5 per million tokens: 5,000 tokens in all, 3,000 after the long gap.
  expect(text).toContain("Gaps over 5m        1 of 2 (50%). The cache expires after 5 minutes.");
  expect(text).toContain("$0.01 of cache writes came right after them, 60% of all writes.");
});

test("--here reads only this folder, and a bad --since is refused", () => {
  writeSession(here, "h", [{ t: "turn", turn: turn({ cost: 2 }) }]);
  writeSession(elsewhere, "i", [{ t: "turn", turn: turn({ cost: 7 }) }]);
  const result = runUsage({ here: true }, here);
  expect("lines" in result && plain(result.lines!)).toContain("Total               $2.00");
  expect(runUsage({ since: "soon" }, here)).toEqual({ error: "--since takes a duration such as 30d, 12h or 2w." });
  expect(runUsage({ since: true }, here)).toHaveProperty("error");
});

test("a share too small to round shows as under 1%, with a sliver of bar", () => {
  writeSession(here, "k", [
    { t: "turn", turn: turn({ cost: 500 }) },
    { t: "turn", turn: turn({ startedAt: MINUTE, model: "claude-haiku-5-5", cost: 1 }) },
  ]);
  const text = plain(
    usageAcross(
      sessionFiles().flatMap((file) => readSession(file) ?? []),
      "all time",
    ),
  );
  expect(text).toMatch(/haiku 5\.5 +▏ +\$1\.00 +<1%/);
});

test("with no sessions the report says so", () => {
  const result = runUsage({ since: "30d" }, here);
  expect("lines" in result && plain(result.lines!)).toContain("No sessions last 30d.");
});

test("a duration is hours, days or weeks", () => {
  expect(parseDuration("12h")).toBe(12 * 3_600_000);
  expect(parseDuration("30d")).toBe(30 * 86_400_000);
  expect(parseDuration("2w")).toBe(14 * 86_400_000);
  expect(parseDuration("30")).toBeNull();
  expect(parseDuration("1y")).toBeNull();
});

test("clue usage prints the report without color codes when piped", async () => {
  writeSession(here, "j", [{ t: "turn", turn: turn() }]);
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "usage"], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  expect(stdout).toContain("1 session · 1 prompt · all time");
  expect(stdout).not.toContain("\x1b[");
});

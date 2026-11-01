import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cost } from "../src/agent/models";
import { Session, type TurnRecord } from "../src/session";
import { usageReport } from "../src/ui/usage";
import { fastMode, requests, startMockApi, usage } from "./mock-api";

let server: ReturnType<typeof startMockApi>;
beforeAll(() => {
  server = startMockApi();
});
afterAll(() => server.stop(true));
afterEach(() => {
  fastMode.rejectedFromRequest = Infinity;
});

async function ask(prompt: string, ...flags: string[]) {
  const home = mkdtempSync(join(tmpdir(), "clue-spend-"));
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "ask", "--json", ...args], {
      cwd: realpathSync(mkdtempSync(join(tmpdir(), "clue-spend-cwd-"))),
      env: {
        ...process.env,
        CLUE_HOME: home,
        ANTHROPIC_BASE_URL: server.url.origin,
        ANTHROPIC_API_KEY: "sk-ant-test",
        OPENROUTER_API_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return JSON.parse(stdout);
  };
  const records = (id: string) => {
    const sessions = join(home, "sessions");
    const folder = readdirSync(sessions).find((name) => !name.startsWith("index"))!;
    const lines = readFileSync(join(sessions, folder, `${id}.jsonl`), "utf8")
      .trim()
      .split("\n");
    return lines.map((line) => JSON.parse(line));
  };
  const found = async (id: string) => {
    const code = `const { listSessions } = await import(${JSON.stringify(join(import.meta.dir, "../src/session.ts"))});
console.log(listSessions().map((meta) => meta.id).join(" "), ${JSON.stringify(id)}.length);
process.exit(0);`;
    const proc = Bun.spawn(["bun", "-e", code], { env: { ...process.env, CLUE_HOME: home }, stdout: "pipe" });
    return new Response(proc.stdout).text();
  };
  return { result: await run(...flags, prompt), records, found };
}

const oneRequest = (output: number) => ({
  input: usage.input_tokens,
  output,
  cacheRead: usage.cache_read_input_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
  webSearches: 0,
});

test("a turn that loses fast mode pays the fast price only for its fast requests", async () => {
  requests.length = 0;
  fastMode.rejectedFromRequest = 2;
  const { result } = await ask("read it", "--fast");
  const model = "claude-opus-5-5";
  const expected = cost(model, oneRequest(40), true)! + cost(model, oneRequest(60))!;
  expect(result.cost_usd).toBeCloseTo(expected, 10);
}, 15_000);

test("a compaction the API ran during a turn is counted and priced", async () => {
  const { result } = await ask("compact on the server");
  expect(result.usage.input).toBe(usage.input_tokens * 2 + 5000);
  expect(result.usage.output).toBe(40 + 60 + 700);
}, 15_000);

test("a turn that fails keeps a record of what it already spent, and the session stays findable", async () => {
  const { result, records, found } = await ask("fail midway");
  expect(result.error).toBeDefined();
  const turn = records(result.session_id).find((record) => record.t === "turn")?.turn;
  expect(turn?.stop).toBe("error");
  expect(turn?.prompt).toBe("fail midway");
  expect(turn?.cost).toBeGreaterThan(0);
  expect(await found(result.session_id)).toContain(result.session_id);
}, 15_000);

const turn = (cost: number): TurnRecord =>
  ({
    prompt: "hi",
    startedAt: 0,
    ms: 1,
    firstTokenMs: 1,
    tools: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, webSearches: 0 },
    cost,
    model: "claude-opus-5-5",
    stop: "end_turn",
  }) as TurnRecord;

test("/cost shows what was spent after a rewind to the first prompt", () => {
  const text = usageReport([], [], [turn(1.5)]).join("\n");
  expect(Bun.stripANSI(text)).toContain("$1.50");
});

test("spending outside a turn counts toward the session and /cost", () => {
  const session = Session.create(realpathSync(mkdtempSync(join(tmpdir(), "clue-spend-"))));
  session.append({ t: "spend", usage: turn(0).usage, cost: 0.75, model: "claude-opus-5-5", at: 1 });
  expect(session.spent).toBe(0.75);
  const text = usageReport(session.turns, session.compactions, session.rewound, session.spends).join("\n");
  expect(Bun.stripANSI(text)).toContain("$0.75");
});

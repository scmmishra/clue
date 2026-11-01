import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestSessionFile, resolveSession, Session } from "../src/session";
import { startMockApi } from "./mock-api";

let server: ReturnType<typeof startMockApi>;
beforeAll(() => {
  server = startMockApi();
});
afterAll(() => server.stop(true));

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "clue-lookup-")));

function setup() {
  const home = folder();
  const cwd = folder();
  const env = {
    ...process.env,
    CLUE_HOME: home,
    ANTHROPIC_BASE_URL: server.url.origin,
    ANTHROPIC_API_KEY: "sk-ant-test",
    OPENROUTER_API_KEY: "",
  };
  const clue = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
  const first = async () => JSON.parse((await clue("ask", "--json", "read it")).stdout).session_id as string;
  const breakIndex = () => writeFileSync(join(home, "sessions", "index.db"), "not a database, not at all");
  const script = async (code: string) => {
    const proc = Bun.spawn(["bun", "-e", code], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return stdout + stderr;
  };
  return { home, cwd, clue, first, breakIndex, script };
}

test("clue ask --resume needs the whole id", async () => {
  const { clue, first } = setup();
  const id = await first();
  const truncated = await clue("ask", "--resume", id.slice(0, 6), "again");
  expect(truncated.code).toBe(2);
  expect(truncated.stderr).toContain("no session with id");
  const empty = await clue("ask", "--resume=", "again");
  expect(empty.code).toBe(2);
}, 15_000);

test("an id prefix that matches several sessions reports them all", () => {
  const cwd = folder();
  for (const id of ["prefix-one", "prefix-two"]) {
    const session = new Session(id, cwd);
    session.appendMessage({ role: "user", content: "hi" });
    session.append({
      t: "turn",
      turn: { prompt: "hi", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 } } as never,
    });
  }
  expect(resolveSession("prefix", cwd)).toHaveLength(2);
  expect(resolveSession("prefix-o", cwd).map((meta) => meta.id)).toEqual(["prefix-one"]);
  expect(resolveSession("", cwd)).toEqual([]);
});

test("a session resumes by id with a broken index", async () => {
  const { clue, first, breakIndex } = setup();
  const id = await first();
  breakIndex();
  const { stdout, code } = await clue("ask", "--json", "--resume", id, "again");
  expect(code).toBe(0);
  expect(JSON.parse(stdout).session_id).toBe(id);
}, 15_000);

test("a session the index has lost resumes by id", async () => {
  const { home, clue, first } = setup();
  const id = await first();
  for (const name of readdirSync(join(home, "sessions")))
    if (name.startsWith("index.db")) rmSync(join(home, "sessions", name));
  const { code } = await clue("ask", "--resume", id, "again");
  expect(code).toBe(0);
}, 15_000);

test("with a broken index, sessions and names still come from their files", async () => {
  const { cwd, first, breakIndex, script } = setup();
  await first();
  const session = join(import.meta.dir, "../src/session.ts");
  await script(`
const { latestSessionFile, Session } = await import(${JSON.stringify(session)});
Session.load(latestSessionFile(process.cwd())).rename("kept");
process.exit(0);
`);
  breakIndex();
  const output = await script(`
const { listSessions, sessionNamedIn, nameProblem } = await import(${JSON.stringify(session)});
console.log(JSON.stringify({ listed: listSessions().length, named: sessionNamedIn(process.cwd(), "kept")?.name, problem: nameProblem(process.cwd(), "kept") }));
process.exit(0);
`);
  const result = JSON.parse(output.trim().split("\n").at(-1)!);
  expect(result.listed).toBe(1);
  expect(result.named).toBe("kept");
  expect(result.problem).toContain("already exists");
  expect(cwd).toBeTruthy();
}, 15_000);

test("clue doctor reports a broken index", async () => {
  const { clue, first, breakIndex } = setup();
  await first();
  breakIndex();
  expect((await clue("doctor")).stdout).toContain("session index");
}, 20_000);

test("clue -c ignores a session from another folder with the same key", () => {
  const root = folder();
  const hyphen = join(root, "foo-bar");
  const nested = join(root, "foo", "bar");
  mkdirSync(hyphen, { recursive: true });
  mkdirSync(nested, { recursive: true });
  const other = Session.create(hyphen);
  other.appendMessage({ role: "user", content: "hi" });
  expect(latestSessionFile(hyphen)).toBe(other.file);
  expect(latestSessionFile(nested)).toBeNull();
  const mine = Session.create(nested);
  mine.appendMessage({ role: "user", content: "mine" });
  expect(latestSessionFile(nested)).toBe(mine.file);
});

test("a second clue refuses a session that a live process holds, and takes it from a dead one", async () => {
  const { home, clue, first } = setup();
  const id = await first();
  const dir = readdirSync(join(home, "sessions")).find((name) => !name.startsWith("index"))!;
  const lock = join(home, "sessions", dir, `${id}.jsonl.lock`);
  expect(existsSync(lock)).toBe(false);
  writeFileSync(lock, String(process.pid));
  const refused = await clue("ask", "--resume", id, "again");
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("open in another clue");
  writeFileSync(lock, "999999");
  expect((await clue("ask", "--resume", id, "again")).code).toBe(0);
  expect(existsSync(lock)).toBe(false);
}, 15_000);

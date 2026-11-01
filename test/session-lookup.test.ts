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
  // What `clue -r <id>` loads, without needing a terminal.
  const session = join(import.meta.dir, "../src/session.ts");
  const find = (id: string) =>
    script(`const { findSession } = await import(${JSON.stringify(session)});
console.log(findSession(${JSON.stringify(id)})?.id ?? "nothing");
process.exit(0);`);
  return { home, cwd, clue, first, breakIndex, script, find };
}

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

test("a session is found by its whole id, not part of it", async () => {
  const { first, find } = setup();
  const id = await first();
  expect(await find(id)).toContain(id);
  expect(await find(id.slice(0, 6))).toContain("nothing");
  expect(await find("")).toContain("nothing");
}, 15_000);

test("a session is found by id with a broken index", async () => {
  const { first, breakIndex, find } = setup();
  const id = await first();
  breakIndex();
  expect(await find(id)).toContain(id);
}, 15_000);

test("a session the index has lost is found by id", async () => {
  const { home, first, find } = setup();
  const id = await first();
  for (const name of readdirSync(join(home, "sessions")))
    if (name.startsWith("index.db")) rmSync(join(home, "sessions", name));
  expect(await find(id)).toContain(id);
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
  const { home, script, first } = setup();
  const id = await first();
  const dir = readdirSync(join(home, "sessions")).find((name) => !name.startsWith("index"))!;
  const file = join(home, "sessions", dir, `${id}.jsonl`);
  const lock = `${file}.lock`;
  expect(existsSync(lock)).toBe(false);
  const acquire = () =>
    script(`const { Session } = await import(${JSON.stringify(join(import.meta.dir, "../src/session.ts"))});
try { Session.load(${JSON.stringify(file)}).acquire(); console.log("taken"); } catch (error) { console.log(error.message); }
process.exit(0);`);
  writeFileSync(lock, String(process.pid));
  expect(await acquire()).toContain("open in another clue");
  writeFileSync(lock, "999999");
  expect(await acquire()).toContain("taken");
  expect(existsSync(lock)).toBe(false);
}, 15_000);

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, nameProblem, projectKey, resolveSession, Session, sessionFile } from "../src/session";

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "clue-names-")));
const unique = (() => {
  let next = 0;
  return () => `name-${Date.now().toString(36)}-${next++}`;
})();

// A session with one saved message, optionally named.
function saved(cwd: string, name?: string) {
  const session = Session.create(cwd);
  if (name) session.rename(name);
  session.appendMessage({ role: "user", content: "hello" });
  session.append({ t: "turn", turn: { prompt: "hello", startedAt: 1, ms: 1, firstTokenMs: 1, tools: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 }, cost: 0, model: "claude-opus-5-5", stop: "end_turn" } });
  return session;
}

const ids = (metas: { id: string }[]) => metas.map((meta) => meta.id);

test("a name survives a reload", () => {
  const session = saved(folder(), unique());
  expect(Session.load(session.file)!.name).toBe(session.name);
});

test("the last rename wins, and the id never changes", () => {
  const session = saved(folder());
  const [first, second] = [unique(), unique()];
  session.rename(first);
  session.rename(second);
  const loaded = Session.load(session.file)!;
  expect(loaded.name).toBe(second);
  expect(loaded.id).toBe(session.id);
});

test("a rename only appends to the session file", () => {
  const session = saved(folder());
  const before = Bun.file(session.file).size;
  session.rename(unique());
  expect(Session.load(session.file)!.messages).toHaveLength(1);
  expect(Bun.file(session.file).size).toBeGreaterThan(before);
});

test("naming a session before its first message writes no file", () => {
  const session = Session.create(folder());
  session.rename(unique());
  expect(session.name).not.toBeNull();
  expect(Bun.file(session.file).size).toBe(0);
});

test("a held name is saved with the first message, and can be found before the first turn ends", () => {
  const name = unique();
  const cwd = folder();
  const session = Session.create(cwd);
  session.rename(name);
  session.appendMessage({ role: "user", content: "hello" });
  expect(Session.load(session.file)!.name).toBe(name);
  expect(ids(resolveSession(name, cwd))).toEqual([session.id]);
});

test("a subagent's session stays out of the index", () => {
  const name = unique();
  const session = new Session("sub", folder());
  session.ephemeral = true;
  session.rename(name);
  session.appendMessage({ role: "user", content: "hello" });
  expect(resolveSession(name, session.cwd)).toEqual([]);
});

test.each(["", "has space", "a/b", "-flag", "a".repeat(65), "naïve", "a:b"])("%j is not a valid name", (name) => {
  expect(nameProblem(folder(), name)).toContain("A session name");
});

test.each(["auth-fix", "a", "v1.2_final", "A".repeat(64)])("%s is a valid name", (name) => {
  expect(nameProblem(folder(), name)).toBeNull();
});

test("a name taken in this folder is refused, and says how to resume it", () => {
  const cwd = folder();
  const name = unique();
  saved(cwd, name);
  expect(nameProblem(cwd, name)).toBe(`A session named ${name} already exists here. Resume it with clue -r ${name}.`);
});

test("names compare without case, and show the capitals as typed", () => {
  const cwd = folder();
  const name = `Auth-${unique()}`;
  const session = saved(cwd, name);
  expect(nameProblem(cwd, name.toLowerCase())).toContain("already exists");
  expect(ids(resolveSession(name.toUpperCase(), cwd))).toEqual([session.id]);
  expect(resolveSession(name.toUpperCase(), cwd)[0].name).toBe(name);
});

test("two folders can use the same name", () => {
  const name = unique();
  saved(folder(), name);
  expect(nameProblem(folder(), name)).toBeNull();
});

test("a session can change the case of its own name", () => {
  const cwd = folder();
  const name = `lower-${unique()}`;
  const session = saved(cwd, name);
  expect(nameProblem(cwd, name.toUpperCase(), session.id)).toBeNull();
});

test("a deleted session frees its name", () => {
  const cwd = folder();
  const name = unique();
  const session = saved(cwd, name);
  rmSync(session.file);
  expect(nameProblem(cwd, name)).toBeNull();
});

test("an exact id wins over a session with that name", () => {
  const cwd = folder();
  const target = saved(cwd);
  saved(cwd, target.id);
  expect(ids(resolveSession(target.id, cwd))).toEqual([target.id]);
});

test("a name wins over an id that starts with it", () => {
  const cwd = folder();
  const target = saved(cwd);
  const prefix = target.id.slice(0, 7);
  const named = saved(cwd, prefix);
  expect(ids(resolveSession(prefix, cwd))).toEqual([named.id]);
});

test("an id prefix still resolves", () => {
  const cwd = folder();
  const target = saved(cwd);
  expect(ids(resolveSession(target.id.slice(0, -1), cwd))).toEqual([target.id]);
});

test("the name in this folder wins over the same name elsewhere", () => {
  const name = unique();
  const here = folder();
  saved(folder(), name);
  const mine = saved(here, name);
  expect(ids(resolveSession(name, here))).toEqual([mine.id]);
});

test("one match in another folder resolves", () => {
  const name = unique();
  const elsewhere = saved(folder(), name);
  expect(ids(resolveSession(name, folder()))).toEqual([elsewhere.id]);
});

test("several matches in other folders are all returned, for the caller to list", () => {
  const name = unique();
  const [a, b] = [saved(folder(), name), saved(folder(), name)];
  expect(ids(resolveSession(name, folder())).sort()).toEqual([a.id, b.id].sort());
});

test("nothing found returns nothing", () => {
  expect(resolveSession(unique(), folder())).toEqual([]);
});

test("the picker's search finds a session by name", () => {
  const name = unique();
  const session = saved(folder(), name);
  expect(ids(listSessions(name))).toContain(session.id);
});

const run = async (args: string[], cwd: string, env: Record<string, string> = {}) => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], { cwd, env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-test", ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
};

// Starts clue in a terminal, as far as its first paint, and returns what it printed.
const firstPaint = async (args: string[], cwd: string, env: Record<string, string> = {}) => {
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 120, rows: 30, data: (_terminal, data) => (output += decoder.decode(data, { stream: true })) });
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], { cwd, env: { ...process.env, CLUE_BENCH_READY: "1", ...env }, terminal });
  const code = await proc.exited;
  // On Linux the output can land just after the process exits.
  for (let waited = 0; !output && waited < 2000; waited += 10) await Bun.sleep(10);
  for (let seen = -1; seen !== output.length; await Bun.sleep(20)) seen = output.length;
  terminal.close();
  return { output: Bun.stripANSI(output), code };
};

const ONLY_NEW = "clue: --name only works for a new session. Use /rename after resuming.";

test.each([
  ["-c", ["--name", "x", "-c"]],
  ["-r", ["-r", "--name", "x"]],
  ["-r with an id", ["-r", "abc", "--name", "x"]],
  ["--resume", ["--name", "x", "--resume", "abc"]],
])("--name with %s stops", async (_flag, args) => {
  const { stderr, code } = await run(args, folder());
  expect(stderr).toContain(ONLY_NEW);
  expect(code).toBe(2);
});

test("--name with no value stops", async () => {
  const { stderr, code } = await run(["--name"], folder());
  expect(stderr).toContain("--name needs a name");
  expect(code).toBe(2);
});

test("--name is for the interactive shell, not clue ask", async () => {
  const { stderr, code } = await run(["ask", "--name", "x", "hello"], folder());
  expect(stderr).toContain("--name doesn't work with clue ask");
  expect(code).toBe(2);
});

test("--name with a name in this folder resumes that session", async () => {
  const cwd = folder();
  const name = unique();
  saved(cwd, name);
  const { output, code } = await firstPaint(["--name", name], cwd);
  expect(code).toBe(0);
  expect(output).toContain(`session ${name} · `);
});

test("--name never opens a session from another folder", async () => {
  const name = unique();
  saved(folder(), name);
  const { output, code } = await firstPaint(["--name", name], folder());
  expect(code).toBe(0);
  expect(output).not.toContain(`session ${name} · `);
});

test("--name with an invalid name stops", async () => {
  const { stderr, code } = await run(["--name", "a/b"], folder());
  expect(stderr).toContain("A session name");
  expect(code).toBe(2);
});

test("clue --name shows the name when the session is resumed by it", async () => {
  const cwd = folder();
  const name = unique();
  const session = saved(cwd, name);
  const { output, code } = await firstPaint(["-r", name], cwd);
  expect(code).toBe(0);
  expect(output).toContain(`session ${name} · `);
  expect(session.name).toBe(name);
});

test("clue -r with a name resumes from another folder, in the session's own folder", async () => {
  const name = unique();
  saved(folder(), name);
  const { output, code } = await firstPaint(["-r", name], folder());
  expect(code).toBe(0);
  expect(output).toContain(`session ${name} · `);
});

test("clue -r with a name used in several other folders lists them and stops", async () => {
  const name = unique();
  const [a, b] = [saved(folder(), name), saved(folder(), name)];
  const { output, code } = await firstPaint(["-r", name], folder());
  expect(code).toBe(2);
  expect(output).toContain(`several sessions are named ${name}`);
  for (const text of [a.cwd, b.cwd, a.id, b.id]) expect(output).toContain(text);
});

test("clue -r with an unknown name says so", async () => {
  const { output, code } = await firstPaint(["-r", unique()], folder());
  expect(output).toContain("Run clue -r to pick one.");
  expect(code).toBe(2);
});

test("clue ask --resume takes an id, not a name", async () => {
  const cwd = folder();
  const name = unique();
  saved(cwd, name);
  const { stderr, code } = await run(["ask", "--resume", name, "hello"], cwd);
  expect(stderr).toContain(`no session with id ${name}`);
  expect(code).toBe(2);
});

test("an index from before names is upgraded, and its sessions still resolve", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clue-old-index-")));
  const cwd = folder();
  const id = "old-session";
  const dir = join(home, "sessions", projectKey(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ t: "session", id, cwd, created: 1, version: "0.1.0" })}\n${JSON.stringify({ t: "message", message: { role: "user", content: "hi" } })}\n`);
  const old = new Database(join(home, "sessions", "index.db"), { create: true });
  old.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL, prompts INTEGER NOT NULL)");
  old.run("CREATE VIRTUAL TABLE prompts USING fts5(session_id UNINDEXED, text)");
  old.run("INSERT INTO sessions VALUES (?, ?, 'hi', 1, 0)", [id, cwd]);
  old.close();
  const { output, code } = await firstPaint(["-r", id], cwd, { CLUE_HOME: home });
  expect(code).toBe(0);
  expect(output).toContain(`session ${id} · `);
});

test("sessionFile still points at the file a named session writes", () => {
  const session = saved(folder(), unique());
  expect(sessionFile(session)).toBe(session.file);
});

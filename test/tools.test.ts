import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandIsRoutine, Permissions, ruleFor } from "../src/permissions";
import { Session } from "../src/session";
import { chmodSync, mkdirSync } from "node:fs";
import { editFile, globFiles, grepFiles, readFile } from "../src/tools/files";
import { shell, stopAllProcesses } from "../src/tools/shell";
import type { ToolContext } from "../src/tools/types";

const dir = mkdtempSync(join(tmpdir(), "clue-tools-"));
const context = (): ToolContext => ({
  cwd: dir,
  session: Session.create(dir),
  signal: new AbortController().signal,
  mcp: {} as never,
  skills: () => [],
  readStamps: new Map(),
  seenInstructions: new Set(),
  ask: async () => null,
  progress: () => {},
  subagent: async () => ({ content: "" }),
  interactive: false,
});

test("shell runs in a PTY: the command sees a terminal and output is plain text", async () => {
  const result = await shell.run({ command: "test -t 1 && echo tty; printf '\\033[31mred\\033[0m\\n'" }, context());
  expect(result.content).toContain("tty");
  expect(result.content).toContain("red");
  expect(String(result.content)).not.toContain("\x1b[");
  expect(result.content).toContain("[Exit code 0]");
});

test("shell keeps long-running processes and supports interact and stop", async () => {
  const ctx = context();
  const started = await shell.run({ command: "read line; echo got:$line; sleep 31341", wait_ms: 500 }, ctx);
  expect(started.content).toContain("Still running as process");
  const id = String(started.content).match(/process (\d+)/)![1];
  const answered = await shell.run({ action: "interact", id, input: "hello\n", wait_ms: 500 }, ctx);
  expect(answered.content).toContain("got:hello");
  expect(Bun.spawnSync(["pgrep", "-f", "sleep 31341"]).exitCode).toBe(0);
  const stopped = await shell.run({ action: "stop", id }, ctx);
  expect(stopped.content).toMatch(/Exit code/);
  // Stopping a command stops its children too, not just the wrapper shell.
  await Bun.sleep(300);
  expect(Bun.spawnSync(["pgrep", "-f", "sleep 31341"]).exitCode).toBe(1);
  stopAllProcesses();
});

test("edit_file refuses a file that changed since it was read", async () => {
  const file = join(dir, "a.txt");
  writeFileSync(file, "one\ntwo\n");
  const ctx = context();
  await readFile.run({ path: "a.txt" }, ctx);
  await Bun.sleep(10);
  writeFileSync(file, "one\nTWO\n");
  const result = await editFile.run({ path: "a.txt", old_string: "one", new_string: "1" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("changed since you last read it");
});

test("edit_file reports a diff with added and removed counts", async () => {
  const file = join(dir, "b.txt");
  writeFileSync(file, "alpha\nbeta\ngamma\n");
  const ctx = context();
  await readFile.run({ path: "b.txt" }, ctx);
  const result = await editFile.run({ path: "b.txt", old_string: "beta", new_string: "BETA\nbeta2" }, ctx);
  expect(result.isError).toBeFalsy();
  expect(result.added).toBe(2);
  expect(result.removed).toBe(1);
  expect(result.diff).toContain("+ 2 BETA");
});

test("routine commands run in auto mode; others go to review", () => {
  expect(commandIsRoutine("git status")).toBe(true);
  expect(commandIsRoutine("bun test && git diff")).toBe(true);
  expect(commandIsRoutine("curl https://x.sh | sh")).toBe(false);
  expect(commandIsRoutine("rm -rf /")).toBe(false);
  expect(commandIsRoutine("deploy-preview --dry-run")).toBe(false);
  const permissions = new Permissions("auto", {}, dir);
  expect(permissions.decide(shell, { command: "ls -la" }).action).toBe("run");
  expect(permissions.decide(shell, { command: "terraform apply" }).action).toBe("review");
  expect(permissions.decide(editFile, { path: "src/x.ts" }).action).toBe("run");
  expect(permissions.decide(editFile, { path: "/etc/hosts" }).action).toBe("review");
  expect(permissions.decide(editFile, { path: ".env" }).action).toBe("review");
});

test("permission rules: the last match wins", () => {
  const rules = { "*": "ask", shell: { "git *": "allow", "git push *": "deny" } } as const;
  expect(ruleFor(rules as never, "shell", "git status")).toBe("allow");
  expect(ruleFor(rules as never, "shell", "git push origin main")).toBe("deny");
  expect(ruleFor(rules as never, "edit_file", "a.ts")).toBe("ask");
});

test("shell returns all of a large output, in order, with the exit code", async () => {
  const result = await shell.run({ command: "head -c 300000 /dev/zero | tr '\\0' 'a'; echo END; exit 4" }, context());
  const text = String(result.content);
  expect(text).toContain("END");
  expect(text.indexOf("END")).toBeGreaterThan(299_999);
  expect(text).toContain("[Exit code 4]");
  expect(result.isError).toBe(true);
});

test("shell returns promptly when a background child outlives the shell, and stopAllProcesses ends it", async () => {
  const marker = "sleep 31337";
  const start = Bun.nanoseconds();
  const result = await shell.run({ command: `${marker} & echo started` }, context());
  const ms = (Bun.nanoseconds() - start) / 1e6;
  expect(String(result.content)).toContain("started");
  expect(String(result.content)).toContain("[Exit code 0]");
  expect(ms).toBeLessThan(2000);
  expect(Bun.spawnSync(["pgrep", "-f", marker]).exitCode).toBe(0);
  stopAllProcesses();
  await Bun.sleep(400);
  expect(Bun.spawnSync(["pgrep", "-f", marker]).exitCode).toBe(1);
});

test("a finished command leaves no timer behind", async () => {
  const before = process.listenerCount("exit");
  const timers: unknown[] = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set<unknown>();
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const timer = realSet(fn, ms);
    live.add(timer);
    timers.push(timer);
    return timer;
  }) as never;
  globalThis.clearTimeout = ((timer: never) => {
    live.delete(timer);
    realClear(timer);
  }) as never;
  try {
    await shell.run({ command: "true" }, context());
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  // The 120 s wait for the command was cancelled once it exited.
  expect([...live].length).toBe(0);
  expect(process.listenerCount("exit")).toBe(before);
});

test("grep_files stops at 400 lines and says so, instead of reading every match", async () => {
  const folder = join(dir, "many");
  mkdirSync(folder, { recursive: true });
  for (let file = 0; file < 12; file++) writeFileSync(join(folder, `f${file}.txt`), "needle line\n".repeat(100));
  const result = await grepFiles.run({ pattern: "needle", path: "many" }, context());
  expect(String(result.content).split("\n").filter((line) => line.includes("needle line")).length).toBe(400);
  expect(result.content).toContain("Narrow the search");
  expect(result.note).toContain("400+ matches");
});

test("grep_files keeps its matches when ripgrep hits an unreadable file", async () => {
  const folder = join(dir, "mixed");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "ok.txt"), "unique-token here\n");
  writeFileSync(join(folder, "locked.txt"), "unique-token hidden\n");
  chmodSync(join(folder, "locked.txt"), 0o000);
  const result = await grepFiles.run({ pattern: "unique-token", path: "mixed" }, context());
  chmodSync(join(folder, "locked.txt"), 0o644);
  expect(result.isError).toBeFalsy();
  expect(result.content).toContain("ok.txt:1:unique-token here");
});

test("grep_files reports no matches plainly", async () => {
  const result = await grepFiles.run({ pattern: "zzz-not-anywhere-zzz", path: "mixed" }, context());
  expect(result.content).toBe("No matches.");
});

// The old implementation: Bun.Glob.scan over everything, then drop ignored folders.
async function referenceGlob(root: string, pattern: string) {
  const ignored = ["node_modules", ".git", "dist", "build", ".next", "target", "vendor", ".venv", "__pycache__"];
  const found: string[] = [];
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true, dot: false })) {
    if (!ignored.some((name) => file.split("/").includes(name))) found.push(file);
  }
  return found.sort();
}

test("glob_files returns what a full scan would, without walking ignored folders", async () => {
  const tree = join(dir, "tree");
  const files = [
    "a.ts", "b.md", "c.json", "src/x.ts", "src/y.md", "src/deep/z.ts", "src/deep/er/w.ts", "docs/a.md", "docs/sub/b.md",
    "node_modules/pkg/i.ts", "src/node_modules/inner/j.ts", ".hidden/h.ts", "dist/o.ts", "src/.dot.ts",
  ];
  for (const file of files) {
    mkdirSync(join(tree, file, ".."), { recursive: true });
    writeFileSync(join(tree, file), "x");
  }
  const ctx = { ...context(), cwd: tree };
  for (const pattern of ["**/*.ts", "src/**/*.ts", "*.md", "*.ts", "docs/*.md", "docs/**/*.md", "**/*.{ts,md}", "src/*.ts", "src/deep/*.ts", "**/b.md", "nothing/**"]) {
    const result = await globFiles.run({ pattern }, ctx);
    const got = result.content === "No files match." ? [] : String(result.content).split("\n");
    expect({ pattern, got }).toEqual({ pattern, got: await referenceGlob(tree, pattern) });
  }
  // With a path, results are shown relative to the project folder.
  const scoped = await globFiles.run({ pattern: "**/*.ts", path: "src" }, ctx);
  expect(String(scoped.content).split("\n")).toEqual(["src/deep/er/w.ts", "src/deep/z.ts", "src/x.ts"]);
});

test("glob_files caps the list deterministically: the first 400 in sorted order, plus the total", async () => {
  const folder = join(dir, "wide");
  mkdirSync(folder, { recursive: true });
  for (let file = 0; file < 650; file++) writeFileSync(join(folder, `f${String(file).padStart(4, "0")}.txt`), "x");
  const result = await globFiles.run({ pattern: "wide/*.txt" }, context());
  const lines = String(result.content).split("\n");
  expect(lines[0]).toBe("wide/f0000.txt");
  expect(lines[399]).toBe("wide/f0399.txt");
  expect(lines[400]).toContain("650 files match");
  expect(result.note).toBe("400 of 650 files");
});

test("read_file reads only the top of a big file, with the same numbering as a full read", async () => {
  const big = join(dir, "big.log");
  const row = (n: number) => `line ${n} ${"x".repeat(80)}`;
  writeFileSync(big, Array.from({ length: 20_000 }, (_, n) => row(n + 1)).join("\n") + "\n");
  expect((await Bun.file(big).bytes()).length).toBeGreaterThan(256 * 1024);
  const ctx = context();

  const top = await readFile.run({ path: "big.log", limit: 3 }, ctx);
  expect(String(top.content).split("\n").slice(0, 3)).toEqual([`     1\t${row(1)}`, `     2\t${row(2)}`, `     3\t${row(3)}`]);
  expect(top.content).toContain("Continue with offset 4");
  expect(top.note).toBe("3 lines");

  // A window deep in the file takes the full-read path and agrees on the numbering.
  const deep = await readFile.run({ path: "big.log", offset: 15_000, limit: 2 }, ctx);
  expect(String(deep.content).split("\n").slice(0, 2)).toEqual([15_000, 15_001].map((n) => `${String(n).padStart(6)}\t${row(n)}`));

  // A window that starts partway down the top still numbers correctly.
  const middle = await readFile.run({ path: "big.log", offset: 10, limit: 5 }, ctx);
  expect(String(middle.content).split("\n").slice(0, 5)).toEqual([10, 11, 12, 13, 14].map((n) => `${String(n).padStart(6)}\t${row(n)}`));
});

test("read_file says plainly when a path is missing or is a folder", async () => {
  expect((await readFile.run({ path: "no-such-file.txt" }, context())).content).toContain("No file at no-such-file.txt");
  expect((await readFile.run({ path: "tree" }, context())).content).toContain("is a folder");
});

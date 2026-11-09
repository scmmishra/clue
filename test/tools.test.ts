import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandIsRoutine, Permissions, ruleFor } from "../src/permissions";
import { Session } from "../src/session";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { UndoStack } from "../src/agent/undo";
import { editFile, encodeImage, globFiles, grepFiles, readFile, writeFile } from "../src/tools/files";
import { shell, stopAllProcesses } from "../src/tools/shell";
import { subagent } from "../src/tools/misc";
import type { ToolContext } from "../src/tools/types";

const dir = mkdtempSync(join(tmpdir(), "clue-tools-"));
const context = (): ToolContext => ({
  cwd: dir,
  session: Session.create(dir),
  signal: new AbortController().signal,
  mcp: {} as never,
  skills: () => [],
  readStamps: new Map(),
  undo: new UndoStack(),
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

test("edit_file works on a file it hasn't read, because old_string shows Claude knows the text", async () => {
  const file = join(dir, "unread.txt");
  writeFileSync(file, "one\ntwo\n");
  const result = await editFile.run({ path: "unread.txt", edits: [{ old_string: "two", new_string: "2" }] }, context());
  expect(result.isError).toBeFalsy();
  expect(readFileSync(file, "utf8")).toBe("one\n2\n");
});

test("edit_file keeps changes made since the last read", async () => {
  const file = join(dir, "a.txt");
  writeFileSync(file, "one\ntwo\n");
  const ctx = context();
  await readFile.run({ path: "a.txt" }, ctx);
  await Bun.sleep(10);
  writeFileSync(file, "one\nTWO\n");
  const result = await editFile.run({ path: "a.txt", edits: [{ old_string: "one", new_string: "1" }] }, ctx);
  expect(result.isError).toBeFalsy();
  expect(readFileSync(file, "utf8")).toBe("1\nTWO\n");
});

test("an edit without a read doesn't let write_file replace the file", async () => {
  const file = join(dir, "partial.txt");
  writeFileSync(file, "one\ntwo\n");
  const ctx = context();
  await editFile.run({ path: "partial.txt", edits: [{ old_string: "one", new_string: "1" }] }, ctx);
  const result = await writeFile.run({ path: "partial.txt", content: "new" }, ctx);
  expect(result.isError).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("1\ntwo\n");
});

test("an edit after a read leaves the read current for write_file", async () => {
  const file = join(dir, "current.txt");
  writeFileSync(file, "one\n");
  const ctx = context();
  await readFile.run({ path: "current.txt" }, ctx);
  await Bun.sleep(10);
  await editFile.run({ path: "current.txt", edits: [{ old_string: "one", new_string: "1" }] }, ctx);
  expect((await writeFile.run({ path: "current.txt", content: "new" }, ctx)).isError).toBeFalsy();
});

test("edit_file applies several edits, each matched against the original file", async () => {
  const file = join(dir, "multi.txt");
  writeFileSync(file, "alpha\nbeta\ngamma\ndelta\n");
  const result = await editFile.run(
    {
      path: "multi.txt",
      edits: [
        { old_string: "gamma", new_string: "GAMMA\ngamma2" },
        { old_string: "alpha", new_string: "gamma" },
      ],
    },
    context(),
  );
  expect(result.isError).toBeFalsy();
  expect(readFileSync(file, "utf8")).toBe("gamma\nbeta\nGAMMA\ngamma2\ndelta\n");
  expect(result.added).toBe(3);
  expect(result.removed).toBe(2);
  expect(result.diff).toContain("+ 1 gamma");
  expect(result.diff).toContain("- 3 gamma");
  expect(result.diff).toContain("+ 3 GAMMA");
  expect(result.diff).toContain("  5 delta");
});

test("a bad edit stops the whole call and names the edit", async () => {
  const file = join(dir, "atomic.txt");
  writeFileSync(file, "one\ntwo\ntwo\n");
  const run = (edits: { old_string: string; new_string: string }[]) =>
    editFile.run({ path: "atomic.txt", edits }, context());
  const missing = await run([
    { old_string: "one", new_string: "1" },
    { old_string: "three", new_string: "3" },
  ]);
  expect(missing.isError).toBe(true);
  expect(missing.content).toStartWith("Edit 2: old_string was not found");
  const repeated = await run([
    { old_string: "one", new_string: "1" },
    { old_string: "two", new_string: "2" },
  ]);
  expect(repeated.content).toStartWith("Edit 2: old_string appears 2 times");
  expect(readFileSync(file, "utf8")).toBe("one\ntwo\ntwo\n");
});

test("edits that overlap are refused", async () => {
  const file = join(dir, "overlap.txt");
  writeFileSync(file, "one two three\n");
  const result = await editFile.run(
    {
      path: "overlap.txt",
      edits: [
        { old_string: "one two", new_string: "1 2" },
        { old_string: "two three", new_string: "2 3" },
      ],
    },
    context(),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("overlap");
  expect(readFileSync(file, "utf8")).toBe("one two three\n");
});

test("edit_file refuses an empty old_string", async () => {
  writeFileSync(join(dir, "empty.txt"), "text");
  const result = await editFile.run({ path: "empty.txt", edits: [{ old_string: "", new_string: "x" }] }, context());
  expect(result.isError).toBe(true);
  expect(result.content).toContain("old_string is empty");
});

test("edit_file needs a list of well-formed edits", () => {
  expect(editFile.validate({ path: "a", edits: [] })).toContain("at least one");
  expect(editFile.validate({ path: "a", old_string: "x", new_string: "y" })).not.toBeNull();
  expect(editFile.validate({ path: "a", edits: [{ old_string: "x" }] })).toContain("new_string");
  expect(editFile.validate({ path: "a", edits: [{ old_string: "x", new_string: "y" }] })).toBeNull();
});

test("edit_file reports a diff with added and removed counts", async () => {
  const file = join(dir, "b.txt");
  writeFileSync(file, "alpha\nbeta\ngamma\n");
  const ctx = context();
  await readFile.run({ path: "b.txt" }, ctx);
  const result = await editFile.run({ path: "b.txt", edits: [{ old_string: "beta", new_string: "BETA\nbeta2" }] }, ctx);
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
  expect(
    String(result.content)
      .split("\n")
      .filter((line) => line.includes("needle line")).length,
  ).toBe(400);
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
    "a.ts",
    "b.md",
    "c.json",
    "src/x.ts",
    "src/y.md",
    "src/deep/z.ts",
    "src/deep/er/w.ts",
    "docs/a.md",
    "docs/sub/b.md",
    "node_modules/pkg/i.ts",
    "src/node_modules/inner/j.ts",
    ".hidden/h.ts",
    "dist/o.ts",
    "src/.dot.ts",
  ];
  for (const file of files) {
    mkdirSync(join(tree, file, ".."), { recursive: true });
    writeFileSync(join(tree, file), "x");
  }
  const ctx = { ...context(), cwd: tree };
  for (const pattern of [
    "**/*.ts",
    "src/**/*.ts",
    "*.md",
    "*.ts",
    "docs/*.md",
    "docs/**/*.md",
    "**/*.{ts,md}",
    "src/*.ts",
    "src/deep/*.ts",
    "**/b.md",
    "nothing/**",
  ]) {
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
  expect(String(top.content).split("\n").slice(0, 3)).toEqual([
    `     1\t${row(1)}`,
    `     2\t${row(2)}`,
    `     3\t${row(3)}`,
  ]);
  expect(top.content).toContain("Continue with offset 4");
  expect(top.note).toBe("3 lines");

  // A window deep in the file takes the full-read path and agrees on the numbering.
  const deep = await readFile.run({ path: "big.log", offset: 15_000, limit: 2 }, ctx);
  expect(String(deep.content).split("\n").slice(0, 2)).toEqual(
    [15_000, 15_001].map((n) => `${String(n).padStart(6)}\t${row(n)}`),
  );

  // A window that starts partway down the top still numbers correctly.
  const middle = await readFile.run({ path: "big.log", offset: 10, limit: 5 }, ctx);
  expect(String(middle.content).split("\n").slice(0, 5)).toEqual(
    [10, 11, 12, 13, 14].map((n) => `${String(n).padStart(6)}\t${row(n)}`),
  );
});

test("read_file says plainly when a path is missing or is a folder", async () => {
  expect((await readFile.run({ path: "no-such-file.txt" }, context())).content).toContain(
    "No file at no-such-file.txt",
  );
  expect((await readFile.run({ path: "tree" }, context())).content).toContain("is a folder");
});

test("an image's type comes from its bytes, not its extension", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const file = join(mkdtempSync(join(tmpdir(), "clue-image-")), "named-wrong.jpg");
  writeFileSync(file, Buffer.from(png, "base64"));
  const { block } = await encodeImage(file, 70);
  expect(block.source.media_type).toBe("image/png");
});

function grepProject() {
  const dir = mkdtempSync(join(tmpdir(), "clue-grep-"));
  writeFileSync(join(dir, "a.ts"), "const alpha = 1;\nconst beta = 2;\nopen(file);\ncall(one)\nfoo|bar\n");
  const run = (input: Parameters<typeof grepFiles.run>[0]) => grepFiles.run(input, { ...context(), cwd: dir });
  return { run };
}

test("grep_files reads a pattern as a regular expression by default", async () => {
  const { content } = await grepProject().run({ pattern: "alpha|beta" });
  expect(content).toContain("const alpha");
  expect(content).toContain("const beta");
});

test("grep_files falls back to literal text when the pattern isn't a valid expression", async () => {
  const result = await grepProject().run({ pattern: "open(" });
  expect(result.isError).toBeFalsy();
  expect(result.content).toContain("open(file);");
});

test("grep_files falls back to literal text when the expression finds nothing", async () => {
  const { content } = await grepProject().run({ pattern: "call(one)" });
  expect(content).toContain("call(one)");
});

test("grep_files keeps an explicit choice", async () => {
  const { run } = grepProject();
  const literal = await run({ pattern: "foo|bar", regex: false });
  expect(literal.content).toContain("foo|bar");
  expect(literal.content).not.toContain("alpha");
  expect((await run({ pattern: "alpha|beta", regex: false })).content).toBe("No matches.");
  expect((await run({ pattern: "call(one)", regex: true })).content).toBe("No matches.");
  expect((await run({ pattern: "open(", regex: true })).isError).toBe(true);
});

test("grep_files without ripgrep skips ignored folders and binary files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clue-grep-fallback-"));
  for (const folder of ["src", "node_modules/pkg", ".git"]) mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "fallback-token\n");
  writeFileSync(join(dir, "node_modules", "pkg", "b.js"), "fallback-token\n");
  writeFileSync(join(dir, ".git", "c"), "fallback-token\n");
  writeFileSync(join(dir, "blob.bin"), Buffer.from("\0\0fallback-token\0"));
  // A PATH that has grep but not rg.
  const bin = mkdtempSync(join(tmpdir(), "clue-grep-bin-"));
  symlinkSync(Bun.which("grep")!, join(bin, "grep"));
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    expect(Bun.which("rg", { PATH: bin })).toBeNull();
    const { content } = await grepFiles.run({ pattern: "fallback-token" }, { ...context(), cwd: dir });
    expect(content).toContain("a.ts:1:fallback-token");
    expect(content).not.toContain("node_modules");
    expect(content).not.toContain(".git");
    expect(content).not.toContain("blob.bin");
  } finally {
    process.env.PATH = path;
  }
});

test("grep_files reports no matches for text that isn't there", async () => {
  expect((await grepProject().run({ pattern: "missing|absent" })).content).toBe("No matches.");
});

test("a subagent takes a single model by short name, and an effort clue knows", () => {
  const base = { task: "t", description: "d" };
  expect(subagent.validate(base)).toBeNull();
  expect(subagent.validate({ ...base, model: "haiku", effort: "low" })).toBeNull();
  expect(subagent.validate({ ...base, model: "claude-sonnet-5" })).toBeNull();
  expect(subagent.validate({ ...base, model: "gpt-5" })).toContain("Unknown model");
  // A pair needs the advisor, and a subagent works without it.
  expect(subagent.validate({ ...base, model: "sonnet+opus" })).toContain("Unknown model");
  expect(subagent.validate({ ...base, effort: "huge" })).toContain("Unknown effort");
});

test("a subagent's model reaches the loop as a full id", async () => {
  let picked: unknown;
  const ctx = {
    ...context(),
    subagent: async (_t: string, _d: string, _s: AbortSignal, choice?: unknown) => {
      picked = choice;
      return { content: "" };
    },
  };
  await subagent.run({ task: "t", description: "d", model: "haiku" }, ctx);
  expect(picked).toEqual({ model: "claude-haiku-5-5", effort: undefined });
});

// Limits the API sets on strict tools across one request. Going over them fails every request
// with a 400, so a new tool or optional field must fit.
const STRICT_OPTIONAL_LIMIT = 24;
const STRICT_UNION_LIMIT = 16;
const STRICT_UNSUPPORTED = ["minimum", "maximum", "multipleOf", "minLength", "maxLength", "maxItems", "pattern"];

test("strict tool schemas fit what the API can compile", async () => {
  const { toolDefinitions } = await import("../src/tools");
  const strict = toolDefinitions("claude-sonnet-5-5").filter(
    (tool): tool is Anthropic.Beta.Messages.BetaTool => "strict" in tool && tool.strict === true,
  );
  expect(strict.length).toBeGreaterThan(0);
  expect(strict.map((tool) => tool.name)).not.toContain("mcp_call");
  let optional = 0;
  let unions = 0;
  const problems: string[] = [];
  const walk = (schema: Record<string, unknown>, path: string) => {
    if (schema.anyOf || Array.isArray(schema.type)) unions += 1;
    for (const key of STRICT_UNSUPPORTED) if (key in schema) problems.push(`${path} uses ${key}`);
    if ("minItems" in schema && Number(schema.minItems) > 1) problems.push(`${path} uses minItems above 1`);
    if (schema.type === "object") {
      if (schema.additionalProperties !== false) problems.push(`${path} allows additional properties`);
      const required = new Set((schema.required as string[] | undefined) ?? []);
      for (const [key, value] of Object.entries((schema.properties as Record<string, Record<string, unknown>>) ?? {})) {
        if (!required.has(key)) optional += 1;
        walk(value, `${path}.${key}`);
      }
    }
    if (schema.items) walk(schema.items as Record<string, unknown>, `${path}[]`);
  };
  for (const tool of strict) walk(tool.input_schema as Record<string, unknown>, tool.name);
  expect(problems).toEqual([]);
  expect(optional).toBeLessThanOrEqual(STRICT_OPTIONAL_LIMIT);
  expect(unions).toBeLessThanOrEqual(STRICT_UNION_LIMIT);
});

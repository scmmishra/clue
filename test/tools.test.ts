import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandIsRoutine, Permissions, ruleFor } from "../src/permissions";
import { Session } from "../src/session";
import { editFile, readFile } from "../src/tools/files";
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
  const started = await shell.run({ command: "read line; echo got:$line; sleep 30", wait_ms: 500 }, ctx);
  expect(started.content).toContain("Still running as process");
  const id = String(started.content).match(/process (\d+)/)![1];
  const answered = await shell.run({ action: "interact", id, input: "hello\n", wait_ms: 500 }, ctx);
  expect(answered.content).toContain("got:hello");
  const stopped = await shell.run({ action: "stop", id }, ctx);
  expect(stopped.content).toMatch(/Exit code/);
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

import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UndoStack } from "../src/agent/undo";
import { Session } from "../src/session";
import { editFile, readFile, writeFile } from "../src/tools/files";
import type { ToolContext } from "../src/tools/types";
import { undoReport } from "../src/ui/undo";

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "clue-undo-")));
  const undo = new UndoStack();
  const context: ToolContext = {
    cwd: dir,
    session: Session.create(dir),
    signal: new AbortController().signal,
    mcp: {} as never,
    skills: () => [],
    readStamps: new Map(),
    undo,
    seenInstructions: new Set(),
    ask: async () => null,
    progress: () => {},
    subagent: async () => ({ content: "" }),
    interactive: false,
  };
  const file = (name: string) => join(dir, name);
  const read = (name: string) => readFileSync(file(name), "utf8");
  const edit = async (name: string, from: string, to: string) => {
    await readFile.run({ path: name } as never, context);
    return editFile.run({ path: name, old_string: from, new_string: to }, context);
  };
  const write = (name: string, content: string) => writeFile.run({ path: name, content }, context);
  return { dir, undo, context, file, read, edit, write };
}

test("with no changes there is nothing to undo", () => {
  expect(new UndoStack().undo()).toEqual({ kind: "empty" });
});

test("one undo reverses every file a turn changed", async () => {
  const { undo, file, read, edit, write } = setup();
  writeFileSync(file("a.ts"), "one");
  writeFileSync(file("b.ts"), "two");
  undo.beginTurn();
  await edit("a.ts", "one", "ONE");
  await edit("b.ts", "two", "TWO");
  await write("new.ts", "fresh");
  const result = undo.undo();
  expect(result).toEqual({
    kind: "done",
    restored: [file("a.ts"), file("b.ts")],
    deleted: [file("new.ts")],
    failed: [],
    ranShell: false,
  });
  expect(read("a.ts")).toBe("one");
  expect(read("b.ts")).toBe("two");
  expect(existsSync(file("new.ts"))).toBe(false);
});

test("several edits to one file go back to the start of the turn", async () => {
  const { undo, file, read, edit } = setup();
  writeFileSync(file("a.ts"), "one");
  undo.beginTurn();
  await edit("a.ts", "one", "two");
  await edit("a.ts", "two", "three");
  undo.undo();
  expect(read("a.ts")).toBe("one");
});

test("each undo reverses one turn, newest first, and a turn with no changes is skipped", async () => {
  const { undo, file, read, edit } = setup();
  writeFileSync(file("a.ts"), "one");
  undo.beginTurn();
  await edit("a.ts", "one", "two");
  undo.beginTurn();
  await edit("a.ts", "two", "three");
  undo.beginTurn();
  undo.undo();
  expect(read("a.ts")).toBe("two");
  undo.undo();
  expect(read("a.ts")).toBe("one");
  expect(undo.undo()).toEqual({ kind: "empty" });
});

test("a later change to a file stops the undo, and nothing is restored", async () => {
  const { undo, file, read, edit } = setup();
  writeFileSync(file("a.ts"), "one");
  writeFileSync(file("b.ts"), "two");
  undo.beginTurn();
  await edit("a.ts", "one", "ONE");
  await edit("b.ts", "two", "TWO");
  writeFileSync(file("b.ts"), "mine");
  expect(undo.undo()).toEqual({ kind: "changed", paths: [file("b.ts")] });
  expect(read("a.ts")).toBe("ONE");
  expect(read("b.ts")).toBe("mine");
});

test("force overwrites a later change", async () => {
  const { undo, file, read, edit } = setup();
  writeFileSync(file("a.ts"), "one");
  undo.beginTurn();
  await edit("a.ts", "one", "ONE");
  writeFileSync(file("a.ts"), "mine");
  undo.undo(true);
  expect(read("a.ts")).toBe("one");
});

test("binary content and the file mode come back unchanged", async () => {
  const { undo, file, context, write } = setup();
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
  writeFileSync(file("a.bin"), bytes);
  chmodSync(file("a.bin"), 0o755);
  undo.beginTurn();
  await readFile.run({ path: "a.bin" } as never, context);
  context.readStamps.set(file("a.bin"), statSync(file("a.bin")).mtimeMs);
  await write("a.bin", "text");
  undo.undo();
  expect(readFileSync(file("a.bin"))).toEqual(bytes);
  expect(statSync(file("a.bin")).mode & 0o777).toBe(0o755);
});

test("a symlink added after the turn is refused, and its target stays intact", async () => {
  const { undo, dir, file, read, edit } = setup();
  writeFileSync(file("a.ts"), "one");
  writeFileSync(file("outside.ts"), "safe");
  undo.beginTurn();
  await edit("a.ts", "one", "ONE");
  rmSync(file("a.ts"));
  symlinkSync(file("outside.ts"), file("a.ts"));
  const result = undo.undo(true);
  expect(result).toMatchObject({ kind: "done", failed: [join(dir, "a.ts")], restored: [] });
  expect(read("outside.ts")).toBe("safe");
});

test("a failed restore keeps the file and is reported", async () => {
  const { undo, file, read, edit, dir } = setup();
  mkdirSync(file("locked"));
  writeFileSync(file("locked/a.ts"), "one");
  undo.beginTurn();
  await edit("locked/a.ts", "one", "ONE");
  chmodSync(file("locked"), 0o555);
  const result = undo.undo();
  chmodSync(file("locked"), 0o755);
  expect(result).toMatchObject({ kind: "done", failed: [join(dir, "locked/a.ts")] });
  expect(read("locked/a.ts")).toBe("ONE");
});

test("a failed write isn't tracked", async () => {
  const { undo, file, edit } = setup();
  writeFileSync(file("a.ts"), "one");
  undo.beginTurn();
  await edit("a.ts", "not there", "x");
  expect(undo.undo()).toEqual({ kind: "empty" });
});

test("after an undo, the edit tools make the agent read the file again", async () => {
  const { undo, file, context, edit } = setup();
  writeFileSync(file("a.ts"), "one");
  undo.beginTurn();
  await edit("a.ts", "one", "two");
  undo.undo();
  const result = await editFile.run({ path: "a.ts", old_string: "two", new_string: "three" }, context);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("changed since you last read it");
});

test("a turn that ran a shell command says so", async () => {
  const { undo, file, edit } = setup();
  writeFileSync(file("a.ts"), "one");
  undo.beginTurn();
  undo.noteShell();
  await edit("a.ts", "one", "two");
  const lines = undoReport(undo.undo(), file("")).map((line) => Bun.stripANSI(line));
  expect(lines).toContain("  Shell commands from that turn weren't undone.");
  expect(lines).toContain("  Restored a.ts");
});

test("only the most recent turns are kept", async () => {
  const { undo, file, read, edit } = setup();
  writeFileSync(file("a.ts"), "0");
  for (let index = 0; index < 25; index++) {
    undo.beginTurn();
    await edit("a.ts", String(index), String(index + 1));
  }
  let undone = 0;
  while (undo.undo().kind === "done") undone++;
  expect(undone).toBe(20);
  expect(read("a.ts")).toBe("5");
});

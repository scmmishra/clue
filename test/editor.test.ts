import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { CLUE_HOME, paths } from "../src/config";
import { Session } from "../src/session";
import { Editor, splitRows } from "../src/ui/editor";
import { sessionEntries } from "../src/ui/replay";

const image = (data: string) => ({
  type: "image" as const,
  source: { type: "base64" as const, media_type: "image/png" as const, data },
});
const typed = (editor: Editor, text: string) => {
  for (const char of text) editor.handle({ name: "char", text: char });
};
const backspace = (editor: Editor) => editor.handle({ name: "backspace" });

test("attaching an image puts a placeholder at the cursor", () => {
  const editor = new Editor([]);
  typed(editor, "look ");
  editor.attach(image("a"));
  typed(editor, " now");
  expect(editor.text).toBe("look [Image #1] now");
  expect(editor.images()).toEqual([image("a")]);
});

test("images number up, and come back in the order of the text", () => {
  const editor = new Editor([]);
  editor.attach(image("a"));
  editor.attach(image("b"));
  expect(editor.text).toBe("[Image #1][Image #2]");
  editor.cursor = 0;
  editor.attach(image("c"));
  expect(editor.text).toBe("[Image #3][Image #1][Image #2]");
  expect(editor.images()).toEqual([image("c"), image("a"), image("b")]);
});

test("one backspace removes a whole placeholder and drops its image", () => {
  const editor = new Editor([]);
  typed(editor, "a ");
  editor.attach(image("x"));
  backspace(editor);
  expect(editor.text).toBe("a ");
  expect(editor.images()).toEqual([]);
  backspace(editor);
  expect(editor.text).toBe("a");
});

test("deleting a placeholder any other way also drops its image", () => {
  const editor = new Editor([]);
  editor.attach(image("x"));
  editor.handle({ name: "u", ctrl: true });
  expect(editor.text).toBe("");
  expect(editor.images()).toEqual([]);
});

test("a pasted path is replaced by its placeholder, and the text around it stays", () => {
  const editor = new Editor([]);
  typed(editor, "see ");
  editor.paste("/tmp/a.png and /tmp/b.png", [
    { start: 0, end: 10, image: image("a") },
    { start: 15, end: 25, image: image("b") },
  ]);
  expect(editor.text).toBe("see [Image #1] and [Image #2]");
  expect(editor.images()).toEqual([image("a"), image("b")]);
  expect(editor.cursor).toBe(editor.text.length);
});

test("clearing the editor forgets its images, and ids keep counting", () => {
  const editor = new Editor([]);
  editor.attach(image("a"));
  editor.clear();
  expect(editor.images()).toEqual([]);
  editor.attach(image("b"));
  expect(editor.text).toBe("[Image #2]");
});

test("restoring a draft brings back its text and images, with the cursor at the end", () => {
  const editor = new Editor([]);
  editor.attach(image("a"));
  const draft = { text: `${editor.text} hi`, images: editor.images() };
  editor.clear();
  editor.restore(draft.text, draft.images);
  expect(editor.text).toBe("[Image #1] hi");
  expect(editor.cursor).toBe(editor.text.length);
  expect(editor.images()).toEqual([image("a")]);
});

test("restoring in front of a draft keeps both, and new ids don't clash", () => {
  const editor = new Editor([]);
  editor.attach(image("a"));
  const queued = { text: editor.text, images: editor.images() };
  editor.clear();
  typed(editor, "newer");
  editor.restore(queued.text, queued.images);
  expect(editor.text).toBe("[Image #1]\nnewer");
  editor.cursor = 0;
  editor.attach(image("b"));
  expect(editor.images()).toEqual([image("b"), image("a")]);
});

test("a prompt with an image still shows when a session is replayed", () => {
  const session = new Session("replay", "/tmp/project");
  session.ephemeral = true;
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "<context>x</context>" }, { type: "text", text: "what is [Image #1]" }, image("a")],
  });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "A cat." }] });
  session.appendMessage({ role: "user", content: [{ type: "text", text: "and [Image #2]" }, image("b")] });
  const prompts = sessionEntries(session).flatMap((entry) => (entry.type === "prompt" ? [entry.text] : []));
  expect(prompts).toEqual(["what is [Image #1]", "and [Image #2]"]);
});

test("tool results are still not prompts", () => {
  const session = new Session("replay-tools", "/tmp/project");
  session.ephemeral = true;
  session.appendMessage({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [image("a")] }] });
  expect(sessionEntries(session).filter((entry) => entry.type === "prompt")).toEqual([]);
});

test.each([
  ["plain text", "hello world from clue", 8],
  ["an exact multiple", "abcdefgh", 4],
  ["wide characters", "日本語のテキストです", 6],
  ["wide characters at an odd width", "日本語のテキストです", 5],
  ["emoji", "ab😀cd😀ef", 4],
  ["an escape code", "ab\x1b[31mcdefgh", 4],
])("wrapping %s loses nothing and stays within the width", (_name, text, room) => {
  const rows = splitRows(text, room);
  expect(rows.join("")).toBe(text);
  expect(rows.every((row) => Bun.stringWidth(row) <= room)).toBe(true);
});

test("an empty line is one empty row", () => {
  expect(splitRows("", 10)).toEqual([""]);
});

test("an exact fit leaves no empty row behind", () => {
  expect(splitRows("abcd", 4)).toEqual(["abcd"]);
});

test("a character wider than the room still moves forward", () => {
  expect(splitRows("日本", 1).join("")).toBe("日本");
});

test("an emoji isn't split across rows", () => {
  expect(splitRows("abc😀", 4)).toEqual(["abc", "😀"]);
});

function withHistory(text: string, check: (editor: Editor) => void) {
  mkdirSync(CLUE_HOME, { recursive: true });
  writeFileSync(paths.history, text);
  try {
    check(new Editor([]));
  } finally {
    rmSync(paths.history, { force: true });
  }
}
const previous = (editor: Editor) => {
  editor.handle({ name: "up" });
  return editor.text;
};

test("saved prompts come back, newest first", () => {
  withHistory('"first"\n"second"\n', (editor) => {
    expect(previous(editor)).toBe("second");
    expect(previous(editor)).toBe("first");
  });
});

test("a multi-line prompt comes back whole", () => {
  withHistory(`${JSON.stringify("one\ntwo")}\n`, (editor) => expect(previous(editor)).toBe("one\ntwo"));
});

test("a half-written last line doesn't lose the history before it", () => {
  withHistory('"first"\n"second"\n"thi', (editor) => expect(previous(editor)).toBe("second"));
});

test("a broken line doesn't lose the prompts before it", () => {
  withHistory('"first"\n{nope\n"third"\n', (editor) => expect(previous(editor)).toBe("first"));
});

test("only the newest 500 prompts are kept", () => {
  const text = Array.from({ length: 510 }, (_, index) => JSON.stringify(`p${index}`)).join("\n");
  withHistory(`${text}\n`, (editor) => {
    for (let index = 0; index < 600; index++) previous(editor);
    expect(editor.text).toBe("p10");
  });
});

const PATHS = ["README.md", "src/", "src/app.ts", "src/ui/", "src/ui/editor.ts"];
const picking = (paths = PATHS) => new Editor([], async () => paths);
const settle = () => Bun.sleep(5);
const rowsOf = (editor: Editor) =>
  editor
    .frame("status")
    .lines.map((line) => Bun.stripANSI(line))
    .slice(2);

test("typing @ loads the files and shows them under the input, without the status line", async () => {
  const editor = picking();
  typed(editor, "@");
  await settle();
  expect(rowsOf(editor)).toEqual(["› README.md", "  src/", "  src/app.ts", "  src/ui/", "  src/ui/editor.ts"]);
});

test("the picker tells the app when the list arrives", async () => {
  let told = 0;
  const editor = new Editor(
    [],
    async () => PATHS,
    () => told++,
  );
  typed(editor, "@");
  await settle();
  expect(told).toBe(1);
});

test("typing filters the list", async () => {
  const editor = picking();
  typed(editor, "@edit");
  await settle();
  expect(rowsOf(editor)).toEqual(["› src/ui/editor.ts"]);
});

test("enter mentions the selected file and keeps the message open", async () => {
  const editor = picking();
  typed(editor, "see @app");
  await settle();
  expect(editor.handle({ name: "enter" })).toBe("handled");
  expect(editor.text).toBe("see @src/app.ts ");
  expect(editor.cursor).toBe(editor.text.length);
  expect(editor.pickerOpen).toBe(false);
});

test("arrows move the selection", async () => {
  const editor = picking();
  typed(editor, "@");
  await settle();
  editor.handle({ name: "down" });
  editor.handle({ name: "down" });
  editor.handle({ name: "up" });
  editor.handle({ name: "enter" });
  expect(editor.text).toBe("@src/ ");
});

test("the selection wraps and stays on the list", async () => {
  const editor = picking();
  typed(editor, "@");
  await settle();
  editor.handle({ name: "up" });
  editor.handle({ name: "enter" });
  expect(editor.text).toBe("@src/ui/editor.ts ");
});

test("a new query starts from the top", async () => {
  const editor = picking();
  typed(editor, "@");
  await settle();
  editor.handle({ name: "down" });
  typed(editor, "e");
  editor.handle({ name: "enter" });
  expect(editor.text).toBe("@src/ui/editor.ts ");
});

test("tab opens a folder and searches inside it", async () => {
  const editor = picking();
  typed(editor, "@");
  await settle();
  editor.handle({ name: "down" });
  editor.handle({ name: "tab" });
  expect(editor.text).toBe("@src/");
  expect(rowsOf(editor)).toEqual(["› src/app.ts", "  src/ui/", "  src/ui/editor.ts"]);
});

test("tab on a file mentions it", async () => {
  const editor = picking();
  typed(editor, "@read");
  await settle();
  editor.handle({ name: "tab" });
  expect(editor.text).toBe("@README.md ");
});

test("a path with spaces is quoted", async () => {
  const editor = picking(["my file.ts"]);
  typed(editor, "@my");
  await settle();
  editor.handle({ name: "enter" });
  expect(editor.text).toBe('@"my file.ts" ');
});

test("a mention replaces the whole word, not only what's before the cursor", async () => {
  const editor = picking();
  typed(editor, "@app.oldname rest");
  editor.cursor = 4;
  await settle();
  editor.handle({ name: "enter" });
  expect(editor.text).toBe("@src/app.ts  rest");
});

test("escape closes the picker, and enter then sends", async () => {
  const editor = picking();
  typed(editor, "@app");
  await settle();
  editor.handle({ name: "escape" });
  expect(editor.pickerOpen).toBe(false);
  expect(editor.handle({ name: "enter" })).toBe("submit");
});

test("a closed picker opens again at the next @", async () => {
  const editor = picking();
  typed(editor, "@app");
  await settle();
  editor.handle({ name: "escape" });
  typed(editor, " @");
  await settle();
  expect(editor.pickerOpen).toBe(true);
});

test("no matches means enter sends, and the status line stays", async () => {
  const editor = picking();
  typed(editor, "@zzqq");
  await settle();
  expect(editor.pickerOpen).toBe(false);
  expect(editor.handle({ name: "enter" })).toBe("submit");
  expect(editor.frame("status").lines.at(-1)).toBe("status");
});

test("an email address never opens the picker", async () => {
  const editor = picking();
  typed(editor, "a@b");
  await settle();
  expect(editor.pickerOpen).toBe(false);
});

test("the list is read fresh for each new mention", async () => {
  let reads = 0;
  const editor = new Editor([], async () => {
    reads++;
    return PATHS;
  });
  typed(editor, "@ab");
  await settle();
  expect(reads).toBe(1);
  typed(editor, " @");
  await settle();
  expect(reads).toBe(2);
});

test("a failed read leaves the input working", async () => {
  const editor = new Editor([], async () => {
    throw new Error("no git");
  });
  typed(editor, "@a");
  await settle();
  expect(editor.pickerOpen).toBe(false);
  expect(editor.handle({ name: "enter" })).toBe("submit");
});

test("only ten rows show, and the selection scrolls them", async () => {
  const many = Array.from({ length: 15 }, (_, index) => `f${String(index).padStart(2, "0")}`);
  const editor = picking(many);
  typed(editor, "@");
  await settle();
  expect(rowsOf(editor)).toHaveLength(10);
  expect(rowsOf(editor)[0]).toBe("› f00");
  for (let index = 0; index < 12; index++) editor.handle({ name: "down" });
  expect(rowsOf(editor)).toContain("› f12");
  expect(rowsOf(editor)).toHaveLength(10);
});

test("a long path keeps its end, on one row", async () => {
  const path = `${"deep/".repeat(40)}name.ts`;
  const editor = picking([path]);
  typed(editor, "@");
  await settle();
  const [row] = rowsOf(editor);
  expect(row.endsWith("name.ts")).toBe(true);
  expect(Bun.stringWidth(row)).toBeLessThanOrEqual(79);
});

test("a message from history doesn't open the picker, so enter sends it", async () => {
  const editor = picking();
  editor.remember("see @src/app.ts");
  editor.handle({ name: "up" });
  await settle();
  expect(editor.pickerOpen).toBe(false);
  expect(editor.handle({ name: "enter" })).toBe("submit");
});

test("a draft taken back from the queue doesn't open the picker", async () => {
  const editor = picking();
  editor.restore("see @src/app.ts", []);
  await settle();
  expect(editor.pickerOpen).toBe(false);
});

test("typing in a closed mention keeps it closed", async () => {
  const editor = picking();
  typed(editor, "@app");
  await settle();
  editor.handle({ name: "escape" });
  typed(editor, ".ts");
  expect(editor.pickerOpen).toBe(false);
});

test("the selection marker moves with the arrow keys", async () => {
  const editor = picking();
  typed(editor, "@");
  await settle();
  editor.handle({ name: "down" });
  expect(rowsOf(editor).slice(0, 2)).toEqual(["  README.md", "› src/"]);
});

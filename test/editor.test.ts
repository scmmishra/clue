import { expect, test } from "bun:test";
import { Session } from "../src/session";
import { Editor, splitRows } from "../src/ui/editor";
import { sessionEntries } from "../src/ui/replay";

const image = (data: string) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data } });
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
  editor.paste("/tmp/a.png and /tmp/b.png", [{ start: 0, end: 10, image: image("a") }, { start: 15, end: 25, image: image("b") }]);
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
  session.appendMessage({ role: "user", content: [{ type: "text", text: "<context>x</context>" }, { type: "text", text: "what is [Image #1]" }, image("a")] });
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

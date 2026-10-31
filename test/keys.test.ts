import { expect, test } from "bun:test";
import { term } from "../src/ui/ansi";
import { keyModes, parseKeys } from "../src/ui/screen";

const one = (data: string) => parseKeys(data)[0];
const SHIFT = 2, ALT = 3, CTRL = 5, SUPER = 9;
const kitty = (code: number, mods = 1) => `\x1b[${code};${mods}u`;
const other = (code: number, mods: number) => `\x1b[27;${mods};${code}~`;

test.each([
  ["kitty", kitty(13, SHIFT)],
  ["modifyOtherKeys", other(13, SHIFT)],
  ["kitty with alt", kitty(13, ALT)],
  ["kitty with ctrl", kitty(13, CTRL)],
])("shift+enter and friends add a new line: %s", (_name, data) => {
  expect(one(data)).toEqual({ name: "newline" });
});

test("plain enter still submits", () => {
  expect(one(kitty(13))).toEqual({ name: "enter" });
  expect(one("\r")).toEqual({ name: "enter" });
});

test.each([
  ["c", 99], ["d", 100], ["o", 111], ["v", 118], ["a", 97], ["u", 117],
])("ctrl+%s arrives as it always has", (name, code) => {
  expect(one(kitty(code, CTRL))).toEqual({ name, ctrl: true });
  expect(one(other(code, CTRL))).toEqual({ name, ctrl: true });
});

test("ctrl+j and ctrl+h keep their old meanings", () => {
  expect(one(kitty(106, CTRL))).toEqual({ name: "newline" });
  expect(one(kitty(104, CTRL))).toEqual({ name: "backspace" });
});

test("escape, tab and backspace arrive as they always have", () => {
  expect(one(kitty(27))).toEqual({ name: "escape" });
  expect(one(kitty(9))).toEqual({ name: "tab" });
  expect(one(kitty(9, SHIFT))).toEqual({ name: "tab", shift: true });
  expect(one(kitty(127))).toEqual({ name: "backspace" });
  expect(one(kitty(127, ALT))).toEqual({ name: "backspace", meta: true });
});

test("alt with a letter keeps its old meaning", () => {
  expect(one(kitty(98, ALT))).toEqual({ name: "left", meta: true });
  expect(one(kitty(102, ALT))).toEqual({ name: "right", meta: true });
});

test("typed characters still arrive as text", () => {
  expect(one(kitty(97))).toEqual({ name: "char", text: "a" });
  expect(one(kitty(97, SHIFT))).toEqual({ name: "char", text: "A" });
  expect(one(other(65, SHIFT))).toEqual({ name: "char", text: "A" });
  expect(one(kitty(0x1f600))).toEqual({ name: "char", text: "😀" });
});

test("a key with the Mac command key is left to the terminal", () => {
  expect(parseKeys(kitty(118, SUPER))).toEqual([]);
});

test("a key's sub-fields are read past", () => {
  expect(one("\x1b[13:13;2:1u")).toEqual({ name: "newline" });
});

test("a key release is ignored", () => {
  expect(parseKeys("\x1b[13;2:3u")).toEqual([]);
});

test("new keys parse beside plain text", () => {
  expect(parseKeys(`a${kitty(13, SHIFT)}b\r`)).toEqual([{ name: "char", text: "a" }, { name: "newline" }, { name: "char", text: "b" }, { name: "enter" }]);
});

test("the keys that were already understood are unchanged", () => {
  expect(one("\x1b[A")).toEqual({ name: "up" });
  expect(one("\x1b[13;2u")).toEqual({ name: "newline" });
  expect(one("\x1b\r")).toEqual({ name: "newline" });
  expect(one("\x1b[1;5C")).toEqual({ name: "right", meta: true });
});

test("clue asks for both key reports, and turns them back off", () => {
  expect(keyModes(false)).toEqual({ on: term.kittyKeysOn + term.modifyKeysOn, off: term.kittyKeysOff + term.modifyKeysOff });
  expect(term.kittyKeysOn).toBe("\x1b[>1u");
  expect(term.kittyKeysOff).toBe("\x1b[<u");
  expect(term.modifyKeysOn).toBe("\x1b[>4;2m");
  expect(term.modifyKeysOff).toBe("\x1b[>4;0m");
});

test("inside tmux, clue leaves the kitty protocol alone", () => {
  expect(keyModes(true)).toEqual({ on: term.modifyKeysOn, off: term.modifyKeysOff });
});

test.each([
  ["\x1b[1;1A", "up"],
  ["\x1b[1;1B", "down"],
  ["\x1b[1;1:1B", "down"],
  ["\x1b[1;1C", "right"],
  ["\x1b[1;1D", "left"],
  ["\x1b[1;1H", "home"],
  ["\x1b[1;1F", "end"],
])("%j is read as %s", (sequence, name) => {
  expect(parseKeys(sequence)).toEqual([{ name }]);
});

test("a key release report is not a key press", () => {
  expect(parseKeys("\x1b[1;1:3B")).toEqual([]);
});

test.each([
  ["\x1b[1;129A", { name: "up" }],
  ["\x1b[1;129B", { name: "down" }],
  ["\x1b[1;129C", { name: "right" }],
  ["\x1b[1;129D", { name: "left" }],
  ["\x1b[1;65B", { name: "down" }],
  ["\x1b[1;193B", { name: "down" }],
  ["\x1b[1;129H", { name: "home" }],
  ["\x1b[3;129~", { name: "delete" }],
  ["\x1b[1;131C", { name: "right", meta: true }],
  ["\x1b[13;129u", { name: "enter" }],
  ["\x1b[27;129;13~", { name: "enter" }],
  ["\x1b[13;130u", { name: "newline" }],
])("%j ignores caps lock and num lock", (sequence, key) => {
  expect(parseKeys(sequence)).toEqual([key]);
});

test("a modified key that has no action is dropped whole", () => {
  expect(parseKeys("\x1b[1;2A")).toEqual([]);
  expect(parseKeys("\x1b[1;2Ax")).toEqual([{ name: "char", text: "x" }]);
});

import { expect, test } from "bun:test";
import { VERSION } from "../src/config";
import { style, tokens } from "../src/ui/ansi";
import { Editor } from "../src/ui/editor";
import { BAR, footerLine, header, promptLines, statusLine, toolTree, wrappedPromptLines } from "../src/ui/turn";

const usage = { input: 100, output: 52, cacheRead: 3000, cacheWrite: 200, webSearches: 0 };
const footer = (turn: Parameters<typeof footerLine>[0]) => Bun.stripANSI(footerLine(turn));

test("the footer counts cached input as tokens in", () => {
  expect(footer({ ms: 2500, cost: 0.06, stop: "end_turn", usage })).toBe("  2.5s · $0.06 · 3.3k in · 52 out");
});

test("the footer of an interrupted turn keeps its tokens", () => {
  expect(footer({ ms: 2500, cost: 0.06, stop: "interrupted", usage })).toBe("  2.5s · $0.06 · 3.3k in · 52 out · interrupted");
});

test("token counts shorten as they grow", () => {
  expect([0, 999, 1000, 3300, 12_345, 1_500_000].map(tokens)).toEqual(["0", "999", "1.0k", "3.3k", "12k", "1.5M"]);
});

const row = (over: object = {}) => ({ id: "1", label: "Read a.ts", kind: "read", done: true, note: "180 lines", startedAt: 0, ...over });
const dot = " · ";

test("colors are on, so the theme tests below compare real colors", () => {
  expect(style.brand("x")).not.toBe("x");
  expect(style.brand("x")).not.toBe(style.muted("x"));
});

test("the prompt has a blue bar and regular text", () => {
  expect(promptLines("fix it")).toEqual([`${style.brand(BAR)}fix it`]);
});

test("a long prompt stays one line, so the terminal wraps it and copying gives the original text", () => {
  const long = "word ".repeat(200).trim();
  expect(promptLines(long)).toEqual([`${style.brand(BAR)}${long}`]);
});

test("only the first line of a prompt has the bar, so copied lines stay clean", () => {
  expect(promptLines("one\ntwo\n\nthree")).toEqual([`${style.brand(BAR)}one`, "two", "", "three"]);
});

test("the pager wraps a long prompt itself, so nothing is cut off", () => {
  const long = "word ".repeat(200).trim();
  const lines = wrappedPromptLines(long);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.map((line) => Bun.stripANSI(line).slice(BAR.length).trim()).join(" ").replace(/\s+/g, "")).toBe(long.replace(/\s+/g, ""));
});

test("the input has the same blue bar", () => {
  expect(new Editor([]).frame("status").lines[0]).toBe(style.brand("┃ "));
});

test("the header is one grey", () => {
  expect(header()).toBe(style.muted(`clue ${VERSION}${dot}/help for commands`));
});

test("a finished tool run has a blue dot, and grey branches, labels and notes", () => {
  const [summary, first, last] = toolTree([row(), row({ label: "Ran bun test", note: "exit 1" })] as never);
  expect(summary.startsWith(`${style.brand("●")} `)).toBe(true);
  expect(summary).toContain(style.muted(dot));
  expect(first).toBe(`${style.muted("├ ")}${style.muted("Read a.ts")}  ${style.muted("180 lines")}`);
  expect(last).toBe(`${style.muted("└ ")}${style.muted("Ran bun test")}  ${style.muted("exit 1")}`);
});

test("diff counts keep their green and red", () => {
  const [, line] = toolTree([row({ note: undefined, added: 3, removed: 1 })] as never);
  expect(line).toContain(`${style.green("+3")} ${style.red("−1")}`);
});

test("a running tool run has a blue spinner", () => {
  const [summary] = toolTree([row({ done: false })] as never);
  expect(summary.startsWith(style.brand("\0").split("\0")[0])).toBe(true);
});

test("the footer is one grey", () => {
  expect(footerLine({ ms: 2500, cost: 0.06, stop: "end_turn", usage })).toBe(`  ${style.muted(`2.5s${dot}$0.06${dot}3.3k in${dot}52 out`)}`);
});

test("the status line is one grey", () => {
  const line = statusLine("auto", "claude-opus-5-5", "medium", "/tmp/app", "main");
  expect(line.startsWith(`${style.muted("auto")}${style.muted(`${dot}opus 5.5${dot}medium`)}`)).toBe(true);
  expect(line.endsWith(style.muted("/tmp/app (main)"))).toBe(true);
});

test("full-access still stands out in the status line", () => {
  expect(statusLine("full-access", "claude-opus-5-5", "medium", "/tmp/app", null).startsWith(style.orange("full-access"))).toBe(true);
});

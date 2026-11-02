import { expect, test } from "bun:test";
import { MarkdownStream, renderMarkdown } from "../src/ui/markdown";

const plain = (text: string, columns = 60) => renderMarkdown(text, columns).map((line) => Bun.stripANSI(line));

test("a code block sits between two rules as long as its longest line", () => {
  expect(plain("```ruby\ndef greet\n  :hi\nend\n```")).toEqual([
    "  ─ ruby ──",
    "  def greet",
    "    :hi",
    "  end",
    "  ─────────",
  ]);
});

test("code lines have no gutter, so a selection copies only the code", () => {
  const lines = plain("```sh\necho hi\n```");
  expect(lines[1]).toBe("  echo hi");
});

test("a code block without a language has a plain top rule", () => {
  expect(plain("```\nabc\n```")).toEqual(["  ───", "  abc", "  ───"]);
});

test("the rules never run past the screen, and long code lines are not wrapped", () => {
  const long = "x".repeat(80);
  const lines = plain(`\`\`\`js\n${long}\n\`\`\``, 40);
  expect(lines[0]).toBe(`  ─ js ${"─".repeat(37 - 5)}`);
  expect(lines[1]).toBe(`  ${long}`);
});

test("a code block inside a list item keeps the item's indent", () => {
  expect(plain("- run this:\n\n  ```sh\n  ls\n  ```")).toEqual([
    "    • run this:",
    "",
    "      ─ sh ─",
    "      ls",
    "      ──────",
  ]);
});

test("paragraphs wrap to the width, and soft line breaks become spaces", () => {
  expect(plain("one two three four five\nsix", 24)).toEqual(["  one two three four", "  five six"]);
});

test("plain text skips the parser and still gets the parser's paragraphs", () => {
  const text = "First line\nsame paragraph.\n\nSecond paragraph.";
  expect(plain(text)).toEqual(["  First line same paragraph.", "", "  Second paragraph."]);
  expect(plain(`${text} **bold**`)).toEqual(["  First line same paragraph.", "", "  Second paragraph. bold"]);
});

test("lists use bullets, numbers and task boxes, and a list after text stays attached", () => {
  expect(plain("Steps:\n- a\n  - b\n- [x] c\n\n1. d\n2. e")).toEqual([
    "  Steps:",
    "    • a",
    "        • b",
    "    ☒ c",
    "",
    "    1. d",
    "    2. e",
  ]);
});

test("a quote gets a bar on each line", () => {
  expect(plain("> one\n>\n> two")).toEqual(["  │ one", "  │", "  │ two"]);
});

test("a table aligns its columns and draws a border", () => {
  expect(plain("| a | b |\n|:--|--:|\n| long | 1 |")).toEqual([
    "  ┌──────┬───┐",
    "  │ a    │ b │",
    "  ├──────┼───┤",
    "  │ long │ 1 │",
    "  └──────┴───┘",
  ]);
});

test("a table wider than the screen wraps its widest column", () => {
  const lines = plain(`| a | b |\n|---|---|\n| ${"word ".repeat(12)}| x |`, 30);
  expect(Math.max(...lines.map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(29);
  expect(lines.length).toBeGreaterThan(5);
});

test("escape codes in the model's text are dropped", () => {
  expect(plain("a \x1b[31mred\x1b[0m b")).toEqual(["  a [31mred[0m b"]);
});

test("a character reference cannot smuggle in an escape code", () => {
  expect(renderMarkdown("a &#x1b;[31mred", 60)).toEqual(["  a [31mred"]);
});

test("links stay readable without colors, and the text is styled with them", () => {
  const [line] = plain("see [docs](https://example.com)");
  expect(line).toContain("docs");
});

test("a streamed reply commits finished blocks and keeps the open block live", () => {
  const committed: string[][] = [];
  const stream = new MarkdownStream(
    (lines) => committed.push(lines.map((line) => Bun.stripANSI(line))),
    () => 60,
  );
  stream.write("First paragraph.\n\n```ts\nconst a = 1;\n");
  expect(committed).toEqual([["  First paragraph."]]);
  expect(stream.pending().map((line) => Bun.stripANSI(line))).toEqual([
    "  ─ ts ───────",
    "  const a = 1;",
    "  ────────────",
  ]);
  stream.write("```\n");
  stream.end();
  expect(committed[1]).toEqual(["", "  ─ ts ───────", "  const a = 1;", "  ────────────"]);
});

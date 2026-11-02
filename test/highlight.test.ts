import { expect, test } from "bun:test";
import type { Token } from "../src/ui/highlight/engine";
import { highlight } from "../src/ui/highlight";

// Prints tokens as [kind:text], so expectations read without escape codes.
const tags = (tokens: Token[]) => tokens.map(([kind, text]) => (kind ? `[${kind}:${text}]` : text)).join("");
const lex = (code: string, language: string) => highlight(code, language, tags);

test("an unknown or missing language comes back uncolored", () => {
  expect(lex(`x = "s" # 1`, "brainfuck")).toEqual([`x = "s" # 1`]);
  expect(highlight("a\nb", undefined)).toEqual(["a", "b"]);
});

test("ruby colors keywords, strings, comments, symbols and constants", () => {
  expect(lex(`def greet(name) # hi\n  "Hello" if name == :ok\nend`, "ruby")).toEqual([
    "[keyword:def] greet(name) [comment:# hi]",
    `  [string:"Hello"] [keyword:if] name == [literal::ok]`,
    "[keyword:end]",
  ]);
  expect(lex("Foo::Bar.new(key: 1)", "rb")).toEqual(["[type:Foo]::[type:Bar].new([literal:key:] [number:1])"]);
});

test("a # inside a string is not a comment", () => {
  expect(lex(`x = "a # b" # c`, "ruby")).toEqual([`x = [string:"a # b"] [comment:# c]`]);
});

test("an escaped quote does not end a string", () => {
  expect(lex(`s = "a \\" b" + 1`, "js")).toEqual([`s = [string:"a \\" b"] + [number:1]`]);
});

test("a block comment carries over to the next lines", () => {
  expect(lex("a /* one\ntwo\nthree */ b", "ts")).toEqual([
    "a [comment:/* one]",
    "[comment:two]",
    "[comment:three */] b",
  ]);
});

test("an unclosed single-line string ends with its line", () => {
  expect(lex(`x = "open\ny = 1`, "python")).toEqual([`x = [string:"open]`, "y = [number:1]"]);
});

test("ruby =begin comments only start at the start of a line", () => {
  expect(lex("=begin\nnote\n=end\nx", "ruby")).toEqual(["[comment:=begin]", "[comment:note]", "[comment:=end]", "x"]);
});

test("sql keywords match in any case", () => {
  expect(lex("select id FROM t -- c", "sql")).toEqual(["[keyword:select] id [keyword:FROM] t [comment:-- c]"]);
});

test("a diff colors whole lines and leaves context lines alone", () => {
  expect(lex("@@ -1 +1 @@\n-old 1\n+new 2\n same 3", "diff")).toEqual([
    "[meta:@@ -1 +1 @@]",
    "[deleted:-old 1]",
    "[inserted:+new 2]",
    " same 3",
  ]);
});

test("a yaml apostrophe inside a value does not open a string", () => {
  expect(lex("title: don't stop\nnext: 'quoted'", "yaml")).toEqual([
    "[attribute:title]: don't stop",
    "[attribute:next]: [string:'quoted']",
  ]);
});

test("vue lexes script blocks as typescript and tags with their attributes", () => {
  expect(lex(`<div :class="x">{{ n + 1 }}</div>\n<script setup>\nconst n = 0\n</script>`, "vue")).toEqual([
    `[tag:<div] [attribute::class]=[string:"x"][tag:>][meta:{{] n + [number:1] [meta:}}][tag:</div>]`,
    "[tag:<script setup>]",
    "[keyword:const] n = [number:0]",
    "[tag:</script>]",
  ]);
});

test("erb lexes the code inside <% %> as ruby", () => {
  expect(lex(`<p><%= user.name if ok %></p>`, "erb")).toEqual([
    "[tag:<p>][meta:<%=] user.name [keyword:if] ok [meta:%>][tag:</p>]",
  ]);
});

test("a fence that names a file picks the language from its extension", () => {
  expect(lex("def x; end", "app/models/user.rb")).toEqual(["[keyword:def] x; [keyword:end]"]);
});

test("the default theme only resets the foreground, so outer styles survive", () => {
  const [line] = highlight(`"s"`, "js");
  expect(Bun.stripANSI(line)).toBe(`"s"`);
  expect(line).not.toContain("\x1b[0m");
});

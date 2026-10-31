import { expect, test } from "bun:test";
import { previewInput, PREVIEW_CHARS } from "../src/agent/loop";

test("fields near the start are read, including one still arriving", () => {
  expect(previewInput(`{"path":"a.ts","content":"hel`)).toEqual({ path: "a.ts", content: "hel" });
});

test("nothing readable yet is null", () => {
  expect(previewInput("")).toBeNull();
  expect(previewInput(`{"pa`)).toBeNull();
});

test("a huge input keeps the fields a label needs", () => {
  const preview = previewInput(`{"path":"a.ts","content":"${"x".repeat(1_000_000)}`)!;
  expect(preview.path).toBe("a.ts");
  expect(preview.content.length).toBeLessThan(PREVIEW_CHARS);
});

test("only the start of the input is read, so its size doesn't matter", () => {
  const start = `{"command":"ls"`;
  expect(previewInput(`${start}${" ".repeat(PREVIEW_CHARS)},"late":"field"`)).toEqual({ command: "ls" });
});

test.each([
  ["a backslash", "\\"],
  ["a unicode escape", "\\u12"],
])("a cut through %s still reads the field", (_name, tail) => {
  const key = `{"command":"`;
  const text = `${key}${"a".repeat(PREVIEW_CHARS - key.length - tail.length)}${tail}`;
  expect(previewInput(`${text}more"}`)?.command).toBe("a".repeat(PREVIEW_CHARS - key.length - tail.length));
});

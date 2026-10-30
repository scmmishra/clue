import { expect, test } from "bun:test";
import { findImagePaths } from "../src/ui/paste";

const paths = (text: string) => findImagePaths(text).map((token) => token.path);
const spans = (text: string) => findImagePaths(text).map((token) => text.slice(token.start, token.end));

test("a plain image path is found", () => {
  expect(paths("/tmp/shot.png")).toEqual(["/tmp/shot.png"]);
  expect(paths("./a/b.jpg")).toEqual(["./a/b.jpg"]);
});

test("every supported extension is found, in any case", () => {
  expect(paths("a.png b.JPG c.jpeg d.gif e.WebP")).toEqual(["a.png", "b.JPG", "c.jpeg", "d.gif", "e.WebP"]);
});

test("files that aren't images stay out", () => {
  expect(paths("notes.txt src/app.ts /tmp/report.pdf shot.png.bak")).toEqual([]);
});

test("a dragged path with escaped spaces decodes, and its span covers the raw text", () => {
  const text = "/Users/me/Screen\\ Shot\\ 1.png";
  expect(paths(text)).toEqual(["/Users/me/Screen Shot 1.png"]);
  expect(spans(text)).toEqual([text]);
});

test("a quoted path decodes", () => {
  expect(paths(`'/tmp/a b.png'`)).toEqual(["/tmp/a b.png"]);
  expect(paths(`"/tmp/a b.png"`)).toEqual(["/tmp/a b.png"]);
});

test("a leading @ is not part of the path, and is replaced with it", () => {
  expect(paths("@/tmp/a.png")).toEqual(["/tmp/a.png"]);
  expect(spans("look at @/tmp/a.png")).toEqual(["@/tmp/a.png"]);
});

test("sentence punctuation after a path stays outside its span", () => {
  expect(spans("see /tmp/a.png, then /tmp/b.png.")).toEqual(["/tmp/a.png", "/tmp/b.png"]);
});

test("several paths in text keep their positions", () => {
  const text = "compare a.png with b.png please";
  expect(findImagePaths(text)).toEqual([
    { start: 8, end: 13, path: "a.png" },
    { start: 19, end: 24, path: "b.png" },
  ]);
});

test("text without paths finds nothing", () => {
  expect(paths("")).toEqual([]);
  expect(paths("just some words")).toEqual([]);
  expect(paths("@")).toEqual([]);
  expect(paths("@@/tmp/a.png")).toEqual([]);
});

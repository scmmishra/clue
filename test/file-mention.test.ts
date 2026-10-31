import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listPaths, MAX_MATCHES, mentionAt, mentionText, rankPaths } from "../src/ui/file-mention";

const at = (text: string, cursor = text.length) => mentionAt(text, cursor);

test("an @ at the start of a word opens a mention", () => {
  expect(at("@")).toEqual({ start: 0, end: 1, query: "" });
  expect(at("look at @src")).toEqual({ start: 8, end: 12, query: "src" });
  expect(at("one\n@two")).toEqual({ start: 4, end: 8, query: "two" });
});

test("an @ inside a word isn't a mention", () => {
  expect(at("mail me at a@b.co")).toBeNull();
});

test("the mention ends at the next space, and the query ends at the cursor", () => {
  expect(mentionAt("@src/app rest", 4)).toEqual({ start: 0, end: 8, query: "src" });
});

test("a finished word isn't a mention", () => {
  expect(at("@src/app ")).toBeNull();
  expect(at("plain words")).toBeNull();
  expect(at("")).toBeNull();
});

test("a quoted mention can hold spaces, until its closing quote", () => {
  expect(at('@"my fi')).toEqual({ start: 0, end: 7, query: "my fi" });
  expect(at('@"my file.ts" ')).toBeNull();
});

const FILES = [
  "README.md",
  "app/main.ts",
  "src/app.ts",
  "src/app.test.ts",
  "src/happy.ts",
  "src/ui/editor.ts",
  "src/ui/",
  "src/",
  "test/app_shell.ts",
  "docs/a-p-p.md",
];

test("with no query, everything is listed in order, up to the row limit", () => {
  const many = Array.from({ length: MAX_MATCHES + 20 }, (_, index) => `f${String(index).padStart(3, "0")}`);
  expect(rankPaths("", many)).toEqual(many.slice(0, MAX_MATCHES));
});

test("an exact name ranks first, then name prefixes, then whole words, then scattered letters", () => {
  const ranked = rankPaths("app", [
    "src/zap.ts",
    "a/x/p/p.ts",
    "test/my_app.ts",
    "src/happy.ts",
    "src/app.ts",
    "lib/app",
    "src/application.ts",
  ]);
  expect(ranked).toEqual([
    "lib/app",
    "src/app.ts",
    "src/application.ts",
    "test/my_app.ts",
    "src/happy.ts",
    "a/x/p/p.ts",
  ]);
});

test("matching ignores case", () => {
  expect(rankPaths("readme", FILES)).toEqual(["README.md"]);
});

test("a query can include the folder", () => {
  expect(rankPaths("src/ui/ed", FILES)).toEqual(["src/ui/editor.ts"]);
  expect(rankPaths("ui/ed", FILES)).toEqual(["src/ui/editor.ts"]);
});

test("an open folder lists what's inside it, not itself", () => {
  expect(rankPaths("src/ui/", FILES)).toEqual(["src/ui/editor.ts"]);
});

test("letters that aren't in order don't match", () => {
  expect(rankPaths("zzq", FILES)).toEqual([]);
});

test("the best matches survive a query that matches more than the limit", () => {
  const paths = [...Array.from({ length: MAX_MATCHES * 2 }, (_, index) => `deep/folder/widget${index}.ts`), "widget"];
  expect(rankPaths("widget", paths)[0]).toBe("widget");
  expect(rankPaths("widget", paths)).toHaveLength(MAX_MATCHES);
});

test("ranking 100,000 paths stays quick enough to run on a keypress", () => {
  const paths = Array.from(
    { length: 100_000 },
    (_, index) => `packages/app-${index % 50}/src/components/widget${index}.tsx`,
  );
  const start = Bun.nanoseconds();
  rankPaths("widget", paths);
  expect((Bun.nanoseconds() - start) / 1e6).toBeLessThan(40);
});

test.each([
  ["src/app.ts", "@src/app.ts"],
  ["my file.ts", '@"my file.ts"'],
  ["a(b).ts", '@"a(b).ts"'],
  ['say "hi".ts', '@"say \\"hi\\".ts"'],
  ["日本語.ts", "@日本語.ts"],
])("%s is written as %s", (path, text) => {
  expect(mentionText(path)).toBe(text);
});

function project(files: string[]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "clue-mention-")));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  return dir;
}

test("a git repository lists tracked and new files with their folders, and skips what it ignores", async () => {
  const dir = project([".gitignore", ".github/ci.yml", "src/ui/a.ts", "new.ts", "dist/out.js", "node_modules/x/i.js"]);
  writeFileSync(join(dir, ".gitignore"), "dist\nnode_modules\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "add", "src"], { cwd: dir });
  expect(await listPaths(dir)).toEqual([
    ".github/",
    ".github/ci.yml",
    ".gitignore",
    "new.ts",
    "src/",
    "src/ui/",
    "src/ui/a.ts",
  ]);
});

test("a folder outside git is walked, without heavy folders", async () => {
  const dir = project([".env.example", "a/b.ts", "node_modules/x/i.js", ".git/config"]);
  expect(await listPaths(dir)).toEqual([".env.example", "a/", "a/b.ts"]);
});

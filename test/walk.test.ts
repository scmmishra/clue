import { expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { walk, WALK_CONCURRENCY } from "../src/walk";

function tree(files: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clue-walk-")));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}

const seen = async (root: string, limit = Infinity) => {
  const paths: string[] = [];
  await walk(root, (path, entry) => {
    if (entry.isDirectory()) return "enter";
    paths.push(path);
    if (paths.length >= limit) return "stop";
  });
  return paths;
};

test("every file is visited, with paths relative to the root", async () => {
  const root = tree(["a.ts", "src/b.ts", "src/ui/c.ts"]);
  expect((await seen(root)).sort()).toEqual(["a.ts", "src/b.ts", "src/ui/c.ts"]);
});

test("a folder that isn't entered is skipped", async () => {
  const root = tree(["a.ts", "node_modules/x/i.js"]);
  const paths: string[] = [];
  await walk(root, (path, entry) => {
    if (entry.isDirectory()) return;
    paths.push(path);
  });
  expect(paths).toEqual(["a.ts"]);
});

test("a walk can start below the root, at a known depth", async () => {
  const root = tree(["a.ts", "src/ui/c.ts"]);
  const depths: Record<string, number> = {};
  await walk(
    root,
    (path, entry, depth) => {
      depths[path] = depth;
      if (entry.isDirectory()) return "enter";
    },
    { start: "src", depth: 1 },
  );
  expect(depths).toEqual({ "src/ui": 1, "src/ui/c.ts": 2 });
});

test("an unreadable folder is skipped", async () => {
  expect(await seen(join(tree([]), "missing"))).toEqual([]);
});

test("a walk that stops early returns the same files every time", async () => {
  const files = Array.from({ length: 40 }, (_, a) => Array.from({ length: 5 }, (_, b) => `d${a}/f${b}.ts`)).flat();
  const root = tree(files);
  const first = await seen(root, 33);
  expect(first).toHaveLength(33);
  for (let run = 0; run < 10; run++) expect(await seen(root, 33)).toEqual(first);
});

const fakeFolder = (name: string) => ({ name, isDirectory: () => true, isFile: () => false }) as unknown as Dirent;

test("no more than the limit of folders are read at once", async () => {
  let active = 0;
  let peak = 0;
  const read = async (folder: string) => {
    peak = Math.max(peak, ++active);
    await Bun.sleep(1);
    active--;
    return folder === "/root" ? Array.from({ length: 30 }, (_, index) => fakeFolder(`d${index}`)) : [];
  };
  await walk("/root", () => "enter", { read });
  expect(peak).toBe(WALK_CONCURRENCY);
});

test("an aborted walk stops reading", async () => {
  const controller = new AbortController();
  let reads = 0;
  const read = async () => {
    reads++;
    controller.abort();
    return [fakeFolder("a")];
  };
  await walk("/root", () => "enter", { read, signal: controller.signal });
  expect(reads).toBe(1);
});

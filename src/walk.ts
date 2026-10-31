import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// More parallel reads save about 4 ms on a large tree and nearly double the CPU.
export const WALK_CONCURRENCY = 4;

export type WalkAction = "enter" | "stop" | void;
type Folder = { path: string; depth: number };
type WalkOptions = {
  start?: string;
  depth?: number;
  signal?: AbortSignal;
  read?: (folder: string) => Promise<Dirent[]>;
};

const readFolder = (folder: string) => readdir(folder, { withFileTypes: true }).catch(() => []);

// Visits a tree breadth first. Up to WALK_CONCURRENCY folders are read ahead, but entries reach
// `visit` in queue order, so a walk that stops early returns the same files on every run.
// `visit` returns "enter" to walk into a folder, and "stop" to end the walk.
export async function walk(
  root: string,
  visit: (path: string, entry: Dirent, depth: number) => WalkAction,
  { start = "", depth = 0, signal, read = readFolder }: WalkOptions = {},
) {
  const queue: Folder[] = [{ path: start, depth }];
  const reads = new Map<number, Promise<Dirent[]>>();
  let started = 0;
  for (let index = 0; index < queue.length && !signal?.aborted; index++) {
    for (; started < queue.length && started < index + WALK_CONCURRENCY; started++) {
      const { path } = queue[started];
      reads.set(started, read(path ? join(root, path) : root));
    }
    const entries = await reads.get(index)!;
    reads.delete(index);
    const folder = queue[index];
    for (const entry of entries) {
      const path = folder.path ? `${folder.path}/${entry.name}` : entry.name;
      const action = visit(path, entry, folder.depth);
      if (action === "stop") return;
      if (action === "enter") queue.push({ path, depth: folder.depth + 1 });
    }
  }
}

import { readdir } from "node:fs/promises";

export type Mention = { start: number; end: number; query: string };

export const MAX_ROWS = 10;
export const MAX_MATCHES = 100;
const MAX_PATHS = 100_000;
const WALK_SKIPS = new Set([".git", "node_modules"]);

// The @ must start a word, so an email address doesn't open the picker.
const MENTION_BEFORE_CURSOR = /(?<!\S)@(?:"((?:[^"\\]|\\.)*)|([^\s"]*))$/;
const REST_OF_QUOTED = /^(?:[^"\\\n]|\\.)*"?/;
const REST_OF_PLAIN = /^\S*/;
const PLAIN_PATH = /^[\p{L}\p{N}_\-./~]+$/u;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

// The mention the cursor is in, if there is one. The query is the part before the cursor.
export function mentionAt(text: string, cursor: number): Mention | null {
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const before = text.slice(lineStart, cursor);
  if (!before.includes("@")) return null;
  const match = before.match(MENTION_BEFORE_CURSOR);
  if (!match) return null;
  const quoted = match[1] !== undefined;
  const rest = text.slice(cursor).match(quoted ? REST_OF_QUOTED : REST_OF_PLAIN)?.[0] ?? "";
  return {
    start: lineStart + match.index!,
    end: cursor + rest.length,
    query: quoted ? match[1].replace(/\\(.)/g, "$1") : match[2],
  };
}

export function mentionText(path: string) {
  if (PLAIN_PATH.test(path) && !path.endsWith(".")) return `@${path}`;
  return `@"${path.replace(/[\\"]/g, "\\$&")}"`;
}

function lettersInOrder(query: string, path: string) {
  let position = -1;
  for (let index = 0; index < query.length; index++) {
    position = path.indexOf(query[index], position + 1);
    if (position === -1) return false;
  }
  return true;
}

// Lower is better: exact name, name prefix, start of a word, anywhere, scattered letters.
function tier(query: string, path: string) {
  const name = path.slice(path.lastIndexOf("/", path.length - 2) + 1).replace(/\/$/, "");
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  let position = path.indexOf(query);
  if (position === -1) return 4;
  for (; position !== -1; position = path.indexOf(query, position + 1)) {
    if (position === 0 || !WORD_CHARACTER.test(path[position - 1])) return 2;
  }
  return 3;
}

type Ranked = { path: string; tier: number };

const compare = (a: Ranked, b: Ranked) => a.tier - b.tier || a.path.length - b.path.length || (a.path < b.path ? -1 : 1);

// The best matches for a query, best first. This runs on a keypress, so it doesn't sort everything.
export function rankPaths(query: string, paths: string[]) {
  const lowered = query.toLowerCase();
  if (!lowered) return paths.slice(0, MAX_MATCHES);
  if (lowered.endsWith("/")) {
    const inside = paths.filter((path) => path.length > lowered.length && path.toLowerCase().startsWith(lowered));
    if (inside.length) return inside.slice(0, MAX_MATCHES);
  }
  const best: Ranked[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    if (!lettersInOrder(lowered, lower)) continue;
    const candidate = { path, tier: tier(lowered, lower) };
    if (best.length === MAX_MATCHES && compare(candidate, best.at(-1)!) >= 0) continue;
    const index = best.findIndex((entry) => compare(candidate, entry) < 0);
    best.splice(index === -1 ? best.length : index, 0, candidate);
    if (best.length > MAX_MATCHES) best.pop();
  }
  return best.map((entry) => entry.path);
}

async function gitPaths(cwd: string) {
  try {
    const git = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd, stdout: "pipe", stderr: "ignore" });
    const output = await git.stdout.text();
    return (await git.exited) === 0 ? output.split("\0").filter(Boolean) : null;
  } catch {
    return null;
  }
}

// Reads one folder at a time, so a large folder such as a home directory stops at the limit.
async function walkPaths(cwd: string) {
  const found: string[] = [];
  const folders = [""];
  for (let index = 0; index < folders.length && found.length < MAX_PATHS; index++) {
    const folder = folders[index];
    const entries = await readdir(`${cwd}/${folder}`, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (WALK_SKIPS.has(entry.name)) continue;
      if (entry.isDirectory()) folders.push(`${folder}${entry.name}/`);
      else found.push(folder + entry.name);
    }
  }
  return found;
}

// Files and their folders, relative to `cwd`. Folders end in a slash.
export async function listPaths(cwd: string) {
  const files = (await gitPaths(cwd)) ?? (await walkPaths(cwd));
  const paths = new Set<string>();
  for (const file of files.slice(0, MAX_PATHS)) {
    paths.add(file);
    for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1)) paths.add(file.slice(0, slash + 1));
  }
  return [...paths].sort();
}

// What the picker shows for the input. The ranking only reruns when the input changes,
// because the screen asks for a frame far more often than a key arrives.
export class FilePicker {
  mention: Mention | null = null;
  matches: string[] = [];
  index = 0;
  private paths: string[] = [];
  private text: string | null = null;
  private cursor = 0;
  private readFor = -1;
  private closedAt = -1;
  private reads = 0;

  constructor(
    private read: () => Promise<string[]>,
    private onRead: () => void,
  ) {}

  update(text: string, cursor: number) {
    if (text === this.text && cursor === this.cursor) return;
    this.text = text;
    this.cursor = cursor;
    this.index = 0;
    this.mention = mentionAt(text, cursor);
    if (!this.mention) {
      this.readFor = this.closedAt = -1;
      this.matches = [];
      return;
    }
    if (this.mention.start !== this.readFor) this.load(this.mention.start);
    this.matches = this.mention.start === this.closedAt ? [] : rankPaths(this.mention.query, this.paths);
  }

  // The old list stays on screen until the new one arrives.
  private load(start: number) {
    this.readFor = start;
    const read = ++this.reads;
    this.read().then(
      (paths) => {
        if (read !== this.reads) return;
        this.paths = paths;
        this.text = null;
        this.onRead();
      },
      () => {},
    );
  }

  move(direction: -1 | 1) {
    this.index = (this.index + direction + this.matches.length) % this.matches.length;
  }

  close() {
    this.closedAt = this.mention?.start ?? -1;
    this.matches = [];
  }
}

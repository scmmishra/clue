import { walk } from "../walk";

export type Mention = { start: number; end: number; query: string };

export const MAX_ROWS = 10;
export const MAX_MATCHES = 100;
const MAX_PATHS = 100_000;
// How far back a file counts as recent. Chatwoot's last 200 commits touch about 3,000 files.
const RECENT_COMMITS = 50;
// A larger commit is a sweep, such as a translation sync, and says nothing about current work.
const MAX_FILES_IN_RECENT_COMMIT = 20;
const COMMIT_MARK = "\x01";
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

type Ranked = { path: string; tier: number; recency: number };

// Paths the user is working on, with lower numbers for more recent ones.
export type RecentPaths = Map<string, number>;

const compare = (a: Ranked, b: Ranked) =>
  a.tier - b.tier || a.recency - b.recency || a.path.length - b.path.length || (a.path < b.path ? -1 : 1);

// Recent paths first, and the rest in their given order.
function recentFirst(paths: string[], recent: RecentPaths) {
  const known = paths.filter((path) => recent.has(path));
  known.sort((a, b) => recent.get(a)! - recent.get(b)!);
  return [...known, ...paths.filter((path) => !recent.has(path))].slice(0, MAX_MATCHES);
}

// The best matches for a query, best first. This runs on a keypress, so it doesn't sort everything.
// How well a path matches comes first, so an exact name always beats a recent file.
export function rankPaths(query: string, paths: string[], recent: RecentPaths = new Map()) {
  const lowered = query.toLowerCase();
  if (!lowered) return recentFirst(paths, recent);
  if (lowered.endsWith("/")) {
    const inside = paths.filter((path) => path.length > lowered.length && path.toLowerCase().startsWith(lowered));
    if (inside.length) return recentFirst(inside, recent);
  }
  const best: Ranked[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    if (!lettersInOrder(lowered, lower)) continue;
    const candidate = { path, tier: tier(lowered, lower), recency: recent.get(path) ?? Infinity };
    if (best.length === MAX_MATCHES && compare(candidate, best.at(-1)!) >= 0) continue;
    const index = best.findIndex((entry) => compare(candidate, entry) < 0);
    best.splice(index === -1 ? best.length : index, 0, candidate);
    if (best.length > MAX_MATCHES) best.pop();
  }
  return best.map((entry) => entry.path);
}

async function gitPaths(cwd: string) {
  try {
    const git = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await git.stdout.text();
    return (await git.exited) === 0 ? output.split("\0").filter(Boolean) : null;
  } catch {
    return null;
  }
}

async function walkPaths(cwd: string) {
  const found: string[] = [];
  await walk(cwd, (path, entry) => {
    if (WALK_SKIPS.has(entry.name)) return;
    if (entry.isDirectory()) return "enter";
    found.push(path);
    if (found.length >= MAX_PATHS) return "stop";
  });
  return found;
}

const nulSeparated = (text: string) => text.split("\0").flatMap((path) => path.trim() || []);

// One git command's output, or nothing when it fails, such as outside a repository.
async function gitOutput(cwd: string, args: string[]) {
  try {
    const git = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const output = await git.stdout.text();
    return (await git.exited) === 0 ? output : "";
  } catch {
    return "";
  }
}

// Files the user is working on, relative to `cwd`: changes, new files, then recent commits.
export async function recentPaths(cwd: string): Promise<RecentPaths> {
  const [changed, created, log] = await Promise.all([
    gitOutput(cwd, ["diff", "HEAD", "--name-only", "--relative", "-z"]),
    gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
    gitOutput(cwd, ["log", `-n${RECENT_COMMITS}`, "--format=%x01", "--name-only", "--relative", "-z"]),
  ]);
  const commits = log.split(COMMIT_MARK).map(nulSeparated);
  const committed = commits.filter((files) => files.length <= MAX_FILES_IN_RECENT_COMMIT).flat();
  const recent: RecentPaths = new Map();
  for (const path of [...nulSeparated(changed), ...nulSeparated(created), ...committed])
    if (!recent.has(path)) recent.set(path, recent.size);
  return recent;
}

// Files and their folders, relative to `cwd`. Folders end in a slash.
export async function listPaths(cwd: string) {
  const files = (await gitPaths(cwd)) ?? (await walkPaths(cwd));
  const paths = new Set<string>();
  for (const file of files.slice(0, MAX_PATHS)) {
    paths.add(file);
    for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1))
      paths.add(file.slice(0, slash + 1));
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
  private recent: RecentPaths = new Map();
  private text: string | null = null;
  private cursor = 0;
  private readFor = -1;
  private closedAt = -1;
  private reads = 0;

  constructor(
    private read: () => Promise<string[]>,
    private onRead: () => void,
    private readRecent: () => Promise<RecentPaths> = async () => new Map(),
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
    this.matches = this.mention.start === this.closedAt ? [] : rankPaths(this.mention.query, this.paths, this.recent);
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
    // Slower than the list, so the list shows first and reorders when this arrives.
    this.readRecent().then(
      (recent) => {
        if (read !== this.reads || recent.size === 0) return;
        this.recent = recent;
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

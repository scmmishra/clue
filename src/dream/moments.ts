import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { sessionFiles } from "../commands/usage";
import { isObject } from "../config";
import { promptText, readRecords, realFolder, steerText } from "../session";

// A moment is a message the user typed after the first prompt of a session, with the end of
// what the agent said just before it. Guidance, such as a correction, shows up in these.

export type Source = "clue" | "claude-code";

export type Moment = {
  // Stable across runs: the session file and the moment's place among its typed messages.
  id: string;
  source: Source;
  file: string;
  // 1 for the first message the user typed in the session, 2 for the next, and so on.
  index: number;
  at: number | null;
  before: string;
  text: string;
};

const BEFORE_CHARS = 600;
const TEXT_CHARS = 1500;
// The first 64 KB of a Claude Code transcript always hold a record with its folder.
const HEAD_BYTES = 65_536;

// Replies that carry no guidance, such as "yes" or "commit it". Code drops them before any model runs.
const TRIVIAL =
  /^(y|yes|yeah|yep|ok|okay|sure|go|go ahead|do it|commit( it)?|push( it)?|continue|proceed|thanks|ty|lgtm|nice|great|perfect|cool|done|next|stop)[.!\s]*$/i;
const MIN_CHARS = 12;
// Claude Code's own messages in the user role, such as slash command output.
const CC_NOISE =
  /^(<command-|<local-command|<bash-|<task-notification|<user-prompt-submit-hook|Caveat:|\[Request interrupted)/;

export const isTrivial = (text: string) => text.trim().length < MIN_CHARS || TRIVIAL.test(text.trim());

// The repository a folder belongs to: the main worktree, so every worktree of a repo shares it.
export function repoRoot(cwd: string): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  const common = realFolder(result.stdout.toString().trim());
  return basename(common) === ".git" ? dirname(common) : common;
}

// Whether a session's folder is in the repo. A folder that no longer exists, such as a removed
// worktree, counts when it was inside the main worktree.
function inRepo(root: string, cache: Map<string, boolean>) {
  return (cwd: string) => {
    let known = cache.get(cwd);
    if (known === undefined) {
      known = existsSync(cwd) ? repoRoot(cwd) === root : cwd === root || cwd.startsWith(`${root}/`);
      cache.set(cwd, known);
    }
    return known;
  };
}

type Block = { type?: unknown; text?: unknown };
// A Claude Code transcript record. Every field is checked before use.
type ClaudeCodeRecord = {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  timestamp?: string;
  message?: { content?: unknown };
};

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? content.filter(isObject) : []);

const textBlocks = (content: unknown) =>
  typeof content === "string"
    ? content
    : blocks(content)
        .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
        .join("\n");

const withoutReminders = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

function moment(source: Source, file: string, index: number, at: number | null, before: string, text: string): Moment {
  return {
    id: `${source}:${file}#${index}`,
    source,
    file,
    index,
    at,
    before: before.slice(-BEFORE_CHARS),
    text: text.slice(0, TEXT_CHARS),
  };
}

function clueMoments(file: string): Moment[] {
  const records = readRecords(file);
  const start = records[0]?.t === "session" ? records[0] : null;
  const at = start?.t === "session" ? start.created : null;
  const moments: Moment[] = [];
  let before = "";
  let index = 0;
  for (const record of records) {
    if (record.t !== "message") continue;
    const { message } = record;
    if (message.role === "assistant") {
      const text = textBlocks(message.content);
      if (text.trim()) before = text;
      continue;
    }
    const text = promptText(message) ?? steerText(message);
    if (!text?.trim()) continue;
    index += 1;
    if (index > 1) moments.push(moment("clue", file, index, at, before, text));
  }
  return moments;
}

function claudeCodeMoments(file: string): Moment[] {
  const moments: Moment[] = [];
  let before = "";
  let index = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let record: ClaudeCodeRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;
    if (record.isSidechain) continue;
    const content = record.message?.content;
    if (record.type === "assistant") {
      const text = textBlocks(content);
      if (text.trim()) before = text;
      continue;
    }
    if (record.type !== "user" || record.isMeta || record.isCompactSummary) continue;
    if (blocks(content).some((block) => block.type === "tool_result")) continue;
    const text = withoutReminders(textBlocks(content));
    if (!text || CC_NOISE.test(text)) continue;
    index += 1;
    const at = Date.parse(record.timestamp ?? "");
    if (index > 1) moments.push(moment("claude-code", file, index, Number.isNaN(at) ? null : at, before, text));
  }
  return moments;
}

// The folder a Claude Code transcript ran in, read from the start of the file.
function claudeCodeFolder(file: string): string | null {
  const buffer = Buffer.alloc(HEAD_BYTES);
  const fd = openSync(file, "r");
  try {
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buffer.toString("utf8", 0, read))?.[1] ?? null;
  } finally {
    closeSync(fd);
  }
}

// Claude Code keeps its transcripts here, or under CLAUDE_CONFIG_DIR.
const claudeCodeProjects = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

function claudeCodeFiles(): string[] {
  const root = claudeCodeProjects();
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((folder) => {
    const dir = join(root, folder);
    try {
      if (!statSync(dir).isDirectory()) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(dir, name));
    } catch {
      return [];
    }
  });
}

// `latest` holds, per session file, the index of its last typed message, for the next dream to start after.
export type Collected = { sessions: number; typed: number; moments: Moment[]; latest: Record<string, number> };

// The repo's follow-up messages that a dream hasn't read yet. `read` holds, per session file,
// the index of the last message an earlier dream read.
export function collectMoments(root: string, read: Record<string, number>, includeClaudeCode: boolean): Collected {
  const belongs = inRepo(root, new Map());
  const files: { file: string; source: Source }[] = [];
  for (const file of sessionFiles()) {
    const start = readRecords(file)[0];
    if (start?.t === "session" && belongs(start.cwd)) files.push({ file, source: "clue" });
  }
  if (includeClaudeCode)
    for (const file of claudeCodeFiles()) {
      const cwd = claudeCodeFolder(file);
      if (cwd && belongs(cwd)) files.push({ file, source: "claude-code" });
    }
  let typed = 0;
  const moments: Moment[] = [];
  const latest: Record<string, number> = {};
  for (const { file, source } of files) {
    const found = source === "clue" ? clueMoments(file) : claudeCodeMoments(file);
    const unread = found.filter((moment) => moment.index > (read[file] ?? 0));
    typed += unread.length;
    if (unread.length) latest[file] = unread.at(-1)!.index;
    moments.push(...unread.filter((moment) => !isTrivial(moment.text)));
  }
  return { sessions: files.length, typed, moments, latest };
}

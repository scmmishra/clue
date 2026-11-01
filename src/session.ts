import type Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, paths, VERSION } from "./config";

// A session is an append-only JSONL file. Message records hold the exact API
// messages, so a resume replays them byte for byte.

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type PromptImage = Anthropic.Beta.Messages.BetaImageBlockParam;

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearches: number;
};

export type ToolRecord = {
  id: string;
  name: string;
  input: unknown;
  // Short line shown in the transcript, such as "Ran bun test".
  label: string;
  kind: string;
  output: string;
  isError: boolean;
  diff?: string;
  added?: number;
  removed?: number;
  startedAt: number;
  ms: number;
  review?: string;
  note?: string;
};

export type TurnRecord = {
  prompt: string;
  startedAt: number;
  ms: number;
  firstTokenMs: number | null;
  tools: number;
  usage: Usage;
  cost: number | null;
  model: string;
  stop: string;
  // Tokens in the last request. Sessions from before 0.7 don't have it.
  context?: number;
  // Claude answered in fast mode, at the fast price.
  fast?: boolean;
  // Where the turn's prompt sits in the transcript. Older sessions don't have it.
  transcript?: number;
};

// One /compact: the summary that replaces the messages, and what the summary cost.
export type CompactionRecord = {
  message: MessageParam;
  usage: Usage;
  cost: number | null;
  model: string;
  at: number;
};

// A request outside any turn, such as warming the cache on resume.
export type SpendRecord = { usage: Usage; cost: number | null; model: string; at: number };

// Everything a session paid for: its turns, turns dropped by a rewind, compactions, and other requests.
export const totalCost = (
  turns: TurnRecord[],
  rewound: TurnRecord[],
  compactions: CompactionRecord[],
  spends: SpendRecord[] = [],
) => [...turns, ...rewound, ...compactions, ...spends].reduce((sum, { cost }) => sum + (cost ?? 0), 0);

export type SessionRecord =
  | { t: "session"; id: string; cwd: string; created: number; version: string }
  | { t: "message"; message: MessageParam }
  | { t: "tool"; tool: ToolRecord }
  | { t: "turn"; turn: TurnRecord }
  | ({ t: "compacted" } & CompactionRecord)
  | ({ t: "spend" } & SpendRecord)
  | { t: "rewind"; transcript: number; turns: number }
  | { t: "name"; name: string };

// A /compact summary sits first in the messages. An automatic compaction block never does.
export function startsWithSummary(messages: MessageParam[]) {
  const content = messages[0]?.content;
  return Array.isArray(content) && content[0]?.type === "compaction";
}

// What clue adds after a compaction during a turn. The tag keeps it apart from anything typed.
export const CONTINUE_PROMPT = "<clue>Continue with the task.</clue>";

// How the opening context starts. It sits before the prompt, in the same message.
export const CONTEXT_OPEN = "<context>";

// The text a person typed, or null for tool results and clue's own messages.
export function promptText(message: MessageParam) {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") return message.content === CONTINUE_PROMPT ? null : message.content;
  if (message.content.some((block) => block.type === "tool_result")) return null;
  const texts = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  const typed = (texts.length > 1 && texts[0].startsWith(CONTEXT_OPEN) ? texts.slice(1) : texts).join("\n");
  return typed === CONTINUE_PROMPT ? null : typed;
}

// A message the user sent mid-turn, after tool results, to steer the turn. It is part of the
// turn, not a prompt, so rewind doesn't list it.
export function steerText(message: MessageParam) {
  if (message.role !== "user" || typeof message.content === "string") return null;
  if (!message.content.some((block) => block.type === "tool_result")) return null;
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  return text || null;
}

// Tokens in the last request, or undefined when a compaction has replaced that context.
export function lastContextSize(turns: TurnRecord[], compactions: CompactionRecord[]) {
  const last = turns.at(-1);
  const compactedSince = last && (compactions.at(-1)?.at ?? 0) > last.startedAt + last.ms;
  return compactedSince ? undefined : turns.findLast((turn) => turn.context !== undefined)?.context;
}

// A prompt the session can go back to. Rewinding drops it and everything after it.
export type RewindPoint = { text: string; transcript: number; turns: number; at?: number };

export type SessionMeta = {
  id: string;
  cwd: string;
  name: string | null;
  title: string;
  updated: number;
  prompts: number;
};

// The real path of a folder, so a symlink or /var vs /private/var maps to one project.
export function realFolder(cwd: string) {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

// Folder name for a project: its real path with separators replaced.
export const projectKey = (cwd: string) =>
  realFolder(cwd)
    .replace(/[/\\:]/g, "-")
    .replace(/^-+/, "") || "root";

export function newSessionId() {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `${time}-${random}`;
}

// Bun parses the file natively, but it stops at a bad line. A crash can leave one half
// written, and records appended later must survive it, so parsing continues on the next line.
function parseRecords(text: string) {
  const records: SessionRecord[] = [];
  let start = 0;
  while (start < text.length) {
    const { values, read, done } = Bun.JSONL.parseChunk(text, start);
    for (const value of values) records.push(value as SessionRecord);
    if (done) break;
    // read stops just before the bad line.
    let line = read;
    while (text[line] === "\n") line += 1;
    const end = text.indexOf("\n", line);
    if (end === -1) break;
    start = end + 1;
  }
  return records;
}

const heldLocks = new Set<string>();

// The process that holds a session's lock, or null when none does or it has died.
function lockHolder(lock: string) {
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? Number(readFileSync(lock, "utf8")) : null;
  }
}

export class Session {
  readonly file: string;
  // What the next request sends. A compaction replaces these with its summary.
  messages: MessageParam[] = [];
  // Every message of the session, for showing it again on resume.
  transcript: MessageParam[] = [];
  compactions: CompactionRecord[] = [];
  spends: SpendRecord[] = [];
  // Turns a rewind dropped. Their cost still counts.
  rewound: TurnRecord[] = [];
  tools = new Map<string, ToolRecord>();
  turns: TurnRecord[] = [];
  records: SessionRecord[] = [];
  private prompts = 0;
  private title = "";
  // Subagent sessions live in memory only.
  ephemeral = false;

  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly created = Date.now(),
  ) {
    this.file = join(paths.sessions, projectKey(cwd), `${id}.jsonl`);
  }

  static create(cwd: string) {
    return new Session(newSessionId(), realFolder(cwd));
  }

  // Loads a session file. Returns null when the file is missing or unreadable.
  static load(file: string): Session | null {
    if (!existsSync(file)) return null;
    let session: Session | null = null;
    const text = readFileSync(file, "utf8");
    for (const record of parseRecords(text)) {
      if (record.t === "session") {
        session = new Session(record.id, record.cwd, record.created);
        session.records.push(record);
        continue;
      }
      session?.apply(record);
    }
    if (session && text && !text.endsWith("\n")) session.tornLastLine = true;
    return session;
  }

  private apply(record: SessionRecord) {
    this.records.push(record);
    if (record.t === "rewind") {
      this.messages.length -= this.transcript.length - record.transcript;
      this.transcript.length = record.transcript;
      this.rewound.push(...this.turns.splice(record.turns));
    }
    if (record.t === "spend") this.spends.push(record);
    if (record.t === "compacted") {
      this.compactions.push(record);
      this.messages = [record.message];
    }
    if (record.t === "message") {
      this.messages.push(record.message);
      this.transcript.push(record.message);
      if (record.message.role === "user" && typeof record.message.content === "string") this.prompts += 1;
      this.title ||= promptText(record.message) ?? "";
    } else if (record.t === "tool") this.tools.set(record.tool.id, record.tool);
    else if (record.t === "turn") {
      this.turns.push(record.turn);
      this.title ||= record.turn.prompt;
    } else if (record.t === "name") this.name = record.name;
  }

  // One process writes a session at a time. Records from two would interleave, and the API
  // rejects a tool call whose result isn't next, so the session could never resume.
  acquire() {
    const lock = `${this.file}.lock`;
    if (this.ephemeral || heldLocks.has(lock)) return;
    const holder = lockHolder(lock);
    if (holder !== null && holder !== process.pid)
      throw new Error(`This session is open in another clue (process ${holder}).`);
    ensureDir(dirname(lock));
    writeFileSync(lock, String(process.pid));
    if (heldLocks.size === 0) process.once("exit", () => heldLocks.forEach((held) => rmSync(held, { force: true })));
    heldLocks.add(lock);
  }

  release() {
    const lock = `${this.file}.lock`;
    if (heldLocks.delete(lock)) rmSync(lock, { force: true });
  }

  private sink: Bun.FileSink | null = null;
  // The file ends mid-line, so the next record must start on a new one.
  private tornLastLine = false;

  // Appends through Bun's FileSink on a descriptor opened in append mode.
  // (A FileSink on a path writes from the start of the file.)
  private write(record: SessionRecord) {
    if (this.ephemeral) return;
    if (!this.sink) {
      this.acquire();
      ensureDir(join(paths.sessions, projectKey(this.cwd)));
      const isNew = !existsSync(this.file);
      this.sink = Bun.file(openSync(this.file, "a", 0o600)).writer();
      if (isNew) {
        const header: SessionRecord = {
          t: "session",
          id: this.id,
          cwd: this.cwd,
          created: this.created,
          version: VERSION,
        };
        this.sink.write(`${JSON.stringify(header)}\n`);
        this.records.unshift(header);
      }
    }
    if (this.tornLastLine) {
      this.sink.write("\n");
      this.tornLastLine = false;
    }
    this.sink.write(`${JSON.stringify(record)}\n`);
    // Flush every record: a crash loses at most the line being written.
    this.sink.flush();
  }

  append(record: SessionRecord) {
    this.write(record);
    this.apply(record);
    if (record.t === "turn" && !this.ephemeral) this.touchIndex(record.turn.prompt);
    if (record.t === "name" && !this.ephemeral) this.touchIndex();
    if (this.heldName && record.t === "message") {
      this.heldName = false;
      this.append({ t: "name", name: this.name! });
    }
  }

  appendMessage(message: MessageParam) {
    this.append({ t: "message", message });
  }

  // A unique alias for the id, within this session's folder.
  name: string | null = null;
  private heldName = false;

  // A session with no messages has no file yet, so its name waits for the first one.
  rename(name: string) {
    if (this.ephemeral || existsSync(this.file)) return this.append({ t: "name", name });
    this.name = name;
    this.heldName = true;
  }

  // What the session has cost so far. /usage reports the same total.
  get spent() {
    return totalCost(this.turns, this.rewound, this.compactions, this.spends);
  }

  get lastContextSize() {
    return lastContextSize(this.turns, this.compactions);
  }

  // The turn a prompt started. In an older session turns have no position, so the Nth prompt
  // pairs with the Nth turn.
  turnOfPrompt(transcript: number, prompt: number) {
    const turn = this.turns[prompt];
    return (
      this.turns.find((candidate) => candidate.transcript === transcript) ??
      (turn?.transcript === undefined ? turn : undefined)
    );
  }

  private turnsBefore(transcript: number, prompt: number) {
    return this.turns.filter((turn, position) =>
      turn.transcript === undefined ? position < prompt : turn.transcript < transcript,
    ).length;
  }

  get isEmpty() {
    return this.messages.length === 0;
  }

  // Prompts since the last compaction, oldest first. Earlier ones are no longer in what is sent.
  get rewindPoints() {
    const sent = this.messages.length - (this.carriesSummary ? 1 : 0);
    const points: RewindPoint[] = [];
    let prompt = 0;
    this.transcript.forEach((message, index) => {
      const text = promptText(message);
      if (text === null) return;
      if (index >= this.transcript.length - sent) {
        points.push({
          text,
          transcript: index,
          turns: this.turnsBefore(index, prompt),
          at: this.turnOfPrompt(index, prompt)?.startedAt,
        });
      }
      prompt += 1;
    });
    return points;
  }

  get carriesSummary() {
    return startsWithSummary(this.messages);
  }

  // Compaction summarizes the opening context, so the next prompt brings it again.
  get needsContext() {
    return this.isEmpty || (this.messages.length === 1 && this.carriesSummary);
  }

  // A crash mid-tool leaves tool calls without results, and the API refuses a new
  // message until each call has one. Appending them keeps the history unchanged.
  closeUnfinishedTools() {
    const last = this.messages.at(-1);
    if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
    const results = last.content.flatMap((block) =>
      block.type === "tool_use"
        ? [
            {
              type: "tool_result" as const,
              tool_use_id: block.id,
              is_error: true,
              content:
                "clue stopped before this tool call finished. It may have partly run, so check before repeating it.",
            },
          ]
        : [],
    );
    if (results.length) this.appendMessage({ role: "user", content: results });
  }

  meta(): SessionMeta {
    return {
      id: this.id,
      cwd: this.cwd,
      name: this.name,
      title: this.title.replace(/\s+/g, " ").slice(0, 160),
      updated: statSync(this.file).mtimeMs,
      prompts: this.turns.length,
    };
  }

  private touchIndex(prompt = "") {
    indexSession({
      id: this.id,
      cwd: this.cwd,
      name: this.name,
      title: this.title.replace(/\s+/g, " ").slice(0, 160),
      updated: Date.now(),
      prompts: this.turns.length,
      prompt,
    });
  }
}

// ---------------------------------------------------------------------------
// The session index: one SQLite database, with full-text search over prompts.
// Transcripts stay in JSONL; the index only points at them.

let database: Database | null = null;

function db() {
  if (database) return database;
  ensureDir(paths.sessions);
  database = new Database(paths.sessionIndex, { create: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA busy_timeout = 2000");
  database.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL, prompts INTEGER NOT NULL, name TEXT)`);
  // An index from before names has no such column. Adding it to a newer one fails, harmlessly.
  try {
    database.run("ALTER TABLE sessions ADD COLUMN name TEXT");
  } catch {}
  database.run("CREATE VIRTUAL TABLE IF NOT EXISTS prompts USING fts5(session_id UNINDEXED, text)");
  return database;
}

export function indexReadable() {
  try {
    db().query("SELECT count(*) FROM sessions").get();
    return true;
  } catch {
    return false;
  }
}

// Sessions read from their files, newest first. It reads every file, so it runs only when the
// index can't answer. With an id, it reads that session alone.
function scanSessions(id?: string) {
  const found: SessionMeta[] = [];
  try {
    for (const folder of readdirSync(paths.sessions, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      const dir = join(paths.sessions, folder.name);
      for (const name of readdirSync(dir)) {
        if (id ? name !== `${id}.jsonl` : !name.endsWith(".jsonl")) continue;
        const session = Session.load(join(dir, name));
        if (session) found.push(session.meta());
      }
    }
  } catch {}
  return found.sort((a, b) => b.updated - a.updated);
}

function indexSession(meta: SessionMeta & { prompt: string }) {
  try {
    const index = db();
    index
      .query(
        "INSERT INTO sessions (id, cwd, title, updated, prompts, name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated = excluded.updated, prompts = excluded.prompts, name = excluded.name",
      )
      .run(meta.id, meta.cwd, meta.title, meta.updated, meta.prompts, meta.name);
    if (meta.prompt) index.query("INSERT INTO prompts (session_id, text) VALUES (?, ?)").run(meta.id, meta.prompt);
  } catch {
    // The index is a convenience. A locked or broken index never blocks a session.
  }
}

// Every session ever saved, newest first. With a query, only sessions whose
// folder, title or prompts match it.
const META = "id, cwd, name, title, updated, prompts";

export function listSessions(query = ""): SessionMeta[] {
  let rows: SessionMeta[] = [];
  try {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      rows = db().query(`SELECT ${META} FROM sessions ORDER BY updated DESC`).all() as SessionMeta[];
    } else {
      const match = words.map((word) => `"${word.replace(/"/g, "")}"*`).join(" ");
      const like = `%${query.trim()}%`;
      rows = db()
        .query(
          `SELECT ${META} FROM sessions
           WHERE cwd LIKE ?1 OR title LIKE ?1 OR name LIKE ?1 OR id IN (SELECT session_id FROM prompts WHERE prompts MATCH ?2)
           ORDER BY updated DESC`,
        )
        .all(like, match) as SessionMeta[];
    }
  } catch {
    const wanted = query.trim().toLowerCase();
    return scanSessions().filter((meta) =>
      `${meta.cwd} ${meta.title} ${meta.name ?? ""}`.toLowerCase().includes(wanted),
    );
  }
  return rows.filter((meta) => existsSync(sessionFile(meta)));
}

const VALID_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;

// Sessions with this name, in any folder. Case doesn't matter.
function sessionsNamed(name: string) {
  try {
    const rows = db().query(`SELECT ${META} FROM sessions WHERE name = ?1 COLLATE NOCASE`).all(name) as SessionMeta[];
    return rows.filter((meta) => existsSync(sessionFile(meta)));
  } catch {
    return scanSessions().filter((meta) => meta.name?.toLowerCase() === name.toLowerCase());
  }
}

export const nameFormatProblem = (name: string) =>
  VALID_NAME.test(name) ? null : "A session name uses letters, digits, ., _ and -, up to 64 characters.";

// The session with this name in this folder. Other folders never match.
export const sessionNamedIn = (cwd: string, name: string) =>
  sessionsNamed(name).find((meta) => meta.cwd === cwd) ?? null;

// Why a session in this folder can't take this name, or null when it can.
export function nameProblem(cwd: string, name: string, self?: string) {
  const format = nameFormatProblem(name);
  if (format) return format;
  if (!sessionsNamed(name).some((meta) => meta.cwd === cwd && meta.id !== self)) return null;
  return `A session named ${name} already exists here. Resume it with clue -r ${name}.`;
}

// The sessions an id or name points at: an exact id, then a name, here before elsewhere,
// then an id prefix. More than one result means the name is used in several other folders.
export function resolveSession(reference: string, cwd: string) {
  if (!reference) return [];
  const all = listSessions();
  const exact = all.find((meta) => meta.id === reference) ?? scanSessions(reference)[0];
  if (exact) return [exact];
  const named = sessionsNamed(reference);
  const here = named.filter((meta) => meta.cwd === cwd);
  if (here.length) return here;
  if (named.length) return named;
  return all.filter((meta) => meta.id.startsWith(reference));
}

export const sessionFile = (meta: { id: string; cwd: string }) =>
  join(paths.sessions, projectKey(meta.cwd), `${meta.id}.jsonl`);

// Scripts pass an id they saved, so a near match would continue the wrong session.
export function findSession(id: string): SessionMeta | null {
  if (!id) return null;
  return listSessions().find((meta) => meta.id === id) ?? scanSessions(id)[0] ?? null;
}

// The folder a session file belongs to, from its first line.
function headerCwd(file: string) {
  try {
    const descriptor = openSync(file, "r");
    const buffer = Buffer.alloc(4096);
    const size = readSync(descriptor, buffer);
    closeSync(descriptor);
    return (JSON.parse(buffer.toString("utf8", 0, size).split("\n")[0]) as { cwd?: string }).cwd;
  } catch {
    return undefined;
  }
}

// The newest session for a folder, read from the folder's directory so it works without the index.
// Two folders can share a directory, because the key is lossy, so each file's own folder must match.
export function latestSessionFile(cwd: string): string | null {
  const dir = join(paths.sessions, projectKey(cwd));
  if (!existsSync(dir)) return null;
  const folder = realFolder(cwd);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ file: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return files.find(({ file }) => headerCwd(file) === folder)?.file ?? null;
}

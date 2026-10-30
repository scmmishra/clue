import type Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";
import { existsSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
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
};

export type SessionRecord =
  | { t: "session"; id: string; cwd: string; created: number; version: string }
  | { t: "message"; message: MessageParam }
  | { t: "tool"; tool: ToolRecord }
  | { t: "turn"; turn: TurnRecord }
  | { t: "name"; name: string };

export type SessionMeta = { id: string; cwd: string; name: string | null; title: string; updated: number; prompts: number };

// The real path of a folder, so a symlink or /var vs /private/var maps to one project.
export function realFolder(cwd: string) {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

// Folder name for a project: its real path with separators replaced.
export const projectKey = (cwd: string) => realFolder(cwd).replace(/[/\\:]/g, "-").replace(/^-+/, "") || "root";

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

export class Session {
  readonly file: string;
  messages: MessageParam[] = [];
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
    if (record.t === "message") {
      this.messages.push(record.message);
      if (record.message.role === "user" && typeof record.message.content === "string") {
        this.prompts += 1;
        this.title ||= record.message.content;
      } else if (record.message.role === "user" && !this.title) {
        // The first prompt of a session sits in blocks, after the context.
        const blocks = record.message.content as Anthropic.Beta.Messages.BetaContentBlockParam[];
        this.title = blocks.flatMap((block) => (block.type === "text" && !block.text.startsWith("<context>") ? [block.text] : [])).join(" ");
      }
    } else if (record.t === "tool") this.tools.set(record.tool.id, record.tool);
    else if (record.t === "turn") {
      this.turns.push(record.turn);
      this.title ||= record.turn.prompt;
    } else if (record.t === "name") this.name = record.name;
  }

  private sink: Bun.FileSink | null = null;
  // The file ends mid-line, so the next record must start on a new one.
  private tornLastLine = false;

  // Appends through Bun's FileSink on a descriptor opened in append mode.
  // (A FileSink on a path writes from the start of the file.)
  private write(record: SessionRecord) {
    if (this.ephemeral) return;
    if (!this.sink) {
      ensureDir(join(paths.sessions, projectKey(this.cwd)));
      const isNew = !existsSync(this.file);
      this.sink = Bun.file(openSync(this.file, "a", 0o600)).writer();
      if (isNew) {
        const header: SessionRecord = { t: "session", id: this.id, cwd: this.cwd, created: this.created, version: VERSION };
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

  get isEmpty() {
    return this.messages.length === 0;
  }

  // A crash mid-tool leaves tool calls without results, and the API refuses a new
  // message until each call has one. Appending them keeps the history unchanged.
  closeUnfinishedTools() {
    const last = this.messages.at(-1);
    if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
    const results = last.content.flatMap((block) =>
      block.type === "tool_use"
        ? [{ type: "tool_result" as const, tool_use_id: block.id, is_error: true, content: "clue stopped before this tool call finished. It may have partly run, so check before repeating it." }]
        : [],
    );
    if (results.length) this.appendMessage({ role: "user", content: results });
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

function indexSession(meta: SessionMeta & { prompt: string }) {
  try {
    const index = db();
    index
      .query("INSERT INTO sessions (id, cwd, title, updated, prompts, name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated = excluded.updated, prompts = excluded.prompts, name = excluded.name")
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
    return [];
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
    return [];
  }
}

// Why a session in this folder can't take this name, or null when it can.
export function nameProblem(cwd: string, name: string, self?: string) {
  if (!VALID_NAME.test(name)) return "A session name uses letters, digits, ., _ and -, up to 64 characters.";
  if (!sessionsNamed(name).some((meta) => meta.cwd === cwd && meta.id !== self)) return null;
  return `A session named ${name} already exists here. Resume it with clue -r ${name}.`;
}

// The sessions an id or name points at: an exact id, then a name, here before elsewhere,
// then an id prefix. More than one result means the name is used in several other folders.
export function resolveSession(reference: string, cwd: string) {
  const all = listSessions();
  const exact = all.find((meta) => meta.id === reference);
  if (exact) return [exact];
  const named = sessionsNamed(reference);
  const here = named.filter((meta) => meta.cwd === cwd);
  if (here.length) return here;
  if (named.length) return named;
  return all.filter((meta) => meta.id.startsWith(reference)).slice(0, 1);
}

export const sessionFile = (meta: { id: string; cwd: string }) =>
  join(paths.sessions, projectKey(meta.cwd), `${meta.id}.jsonl`);

export function findSession(id: string): SessionMeta | null {
  const all = listSessions();
  return all.find((meta) => meta.id === id) ?? all.find((meta) => meta.id.startsWith(id)) ?? null;
}

// The newest session for a folder, read from the folder's directory so it works without the index.
export function latestSessionFile(cwd: string): string | null {
  const dir = join(paths.sessions, projectKey(cwd));
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

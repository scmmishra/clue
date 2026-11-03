import type Anthropic from "@anthropic-ai/sdk";
import { Database } from "bun:sqlite";
import { existsSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, paths, VERSION } from "./config";

// A session is an append-only JSONL file. Message records hold the exact API
// messages, so a resume replays them byte for byte.

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Blocks = Anthropic.Beta.Messages.BetaContentBlockParam[];
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
  subagent?: SubagentInfo;
};

// What a subagent's row shows next to its description.
export type SubagentInfo = {
  // The model the subagent runs on.
  model: string;
  // The call picked the model. Otherwise the subagent uses the parent's model.
  chosen: boolean;
  // Set only when it differs from the parent's effort.
  effort?: string;
  calls: number;
  // When the subagent started work. A call can wait for the calls before it.
  startedAt: number;
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
  // A request ended early, so the API billed more than it reported. The cost is at least this.
  costIsMinimum?: boolean;
};

// One compaction: what replaces the older messages, and what the summary cost.
export type CompactionRecord = {
  // The text of the message that replaces them, as sent: the summary and a note on reading it.
  // It is stored whole, so a resumed session sends the same bytes and its later thinking stays valid.
  summary?: string;
  // How many of the latest messages stay after the summary, without their thinking.
  kept?: number;
  // Sessions from before clue wrote its own summaries: the API's summary, in a compaction block.
  message?: MessageParam;
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

// The text that stands in for the messages a compaction summarized. The note tells Claude how
// the summary and the messages kept after it fit together.
export const summaryText = (summary: string) =>
  `<summary>\n${summary}\n</summary>\n\nclue compacted this conversation to save space, and this summary replaces its earlier part. The messages after it, if any, are the latest part, word for word. Where they differ from the summary, they are more current. Continue from where the work stopped. Files may have changed since you read them, so read a file again before you edit it.`;

const summaryMessage = (text: string): MessageParam => ({ role: "user", content: [{ type: "text", text }] });

// Stands in for a reply that held only thinking, since a message can't be empty.
const NO_TEXT = "(thinking omitted)";

// Thinking is tied to the exact messages before it, and the API rejects it once those change.
// A compaction changes them, so the messages it keeps go without their thinking.
export function withoutThinking(message: MessageParam): MessageParam {
  if (message.role !== "assistant" || typeof message.content === "string") return message;
  const content = message.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking");
  if (content.length && content.length === message.content.length) return message;
  return { ...message, content: content.length ? content : [{ type: "text", text: NO_TEXT }] };
}

// Where the API's compaction block sits in a reply, or -1. Sessions from before clue wrote its
// own summaries have them.
function compactionBlock(message: MessageParam) {
  if (message.role !== "assistant" || typeof message.content === "string") return -1;
  return message.content.findIndex((block) => block.type === "compaction");
}

const compactionSummary = (message: MessageParam, index: number) =>
  summaryText(String(((message.content as Blocks)[index] as { content?: unknown }).content ?? ""));

// The <context> block clue sends with the first prompt.
const holdsContext = (message: MessageParam) =>
  message.role === "user" &&
  Array.isArray(message.content) &&
  message.content.some((block) => block.type === "text" && block.text.startsWith("<context>"));

// What clue added after a compaction during a turn, before it kept the latest messages. Older
// sessions have it. The user didn't type it.
export const CONTINUE_PROMPT = "Continue with the task.";

// The text a person typed, or null for tool results and clue's own messages.
export function promptText(message: MessageParam) {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") return message.content === CONTINUE_PROMPT ? null : message.content;
  if (message.content.some((block) => block.type === "tool_result")) return null;
  return message.content
    .flatMap((block) => (block.type === "text" && !block.text.startsWith("<context>") ? [block.text] : []))
    .join("\n");
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
// Known gap: a turn that compacts mid-run and then ends early saves the size from before the
// compaction. A resume can then compact again, at the cost of one extra summary. It's rare, so
// it stays for now.
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

export class Session {
  readonly file: string;
  // What the next request sends. A compaction replaces the older ones with its summary.
  messages: MessageParam[] = [];
  // The first message is a compaction's summary, which isn't in the transcript.
  summarized = false;
  // The session holds a summary the API wrote, so its thinking was tied to messages clue no longer sends.
  private legacy = false;
  // Every message of the session, for showing it again on resume.
  transcript: MessageParam[] = [];
  compactions: CompactionRecord[] = [];
  spends: SpendRecord[] = [];
  // Turns a rewind dropped. Their cost still counts.
  rewound: TurnRecord[] = [];
  tools = new Map<string, ToolRecord>();
  turns: TurnRecord[] = [];
  records: SessionRecord[] = [];
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
    // Dropping all thinking is always valid, so this costs a resume only its cache.
    if (session?.legacy) session.messages = session.messages.map(withoutThinking);
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
      this.summarized = true;
      if (record.summary !== undefined) {
        const kept = this.messages.slice(Math.max(0, this.messages.length - (record.kept ?? 0)));
        this.messages = [summaryMessage(record.summary), ...kept.map(withoutThinking)];
        this.legacy = false;
      } else {
        const index = record.message ? compactionBlock(record.message) : -1;
        this.messages = [summaryMessage(index === -1 ? summaryText("") : compactionSummary(record.message!, index))];
        this.legacy = true;
      }
    }
    if (record.t === "message") {
      const index = compactionBlock(record.message);
      if (index === -1) this.messages.push(record.message);
      else {
        // The API compacted the conversation during this reply. The reply goes on after its summary.
        const reply = { role: "assistant" as const, content: (record.message.content as Blocks).slice(index + 1) };
        this.messages = [summaryMessage(compactionSummary(record.message, index)), withoutThinking(reply)];
        this.summarized = this.legacy = true;
      }
      this.transcript.push(record.message);
      this.title ||= promptText(record.message) ?? "";
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

  // Prompts in what is sent, oldest first. A compaction summarized the earlier ones.
  get rewindPoints() {
    const sent = this.messages.length - (this.summarized ? 1 : 0);
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

  // The first prompt brings the opening context. A compaction can summarize it away, and then
  // the next prompt brings it again.
  get needsContext() {
    return this.isEmpty || (this.summarized && !this.messages.some(holdsContext));
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

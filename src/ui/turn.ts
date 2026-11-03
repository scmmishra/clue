import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ConfirmAnswer, AgentEvents } from "../agent/loop";
import { modelLabel } from "../agent/models";
import type { SubagentInfo, ToolRecord, TurnRecord } from "../session";
import type { Question } from "../tools/types";
import { VERSION } from "../config";
import {
  columns,
  duration,
  homePath,
  money,
  pad,
  spinnerFrame,
  spread,
  style,
  term,
  tokens,
  truncate,
  width,
  wrapLine,
} from "./ansi";
import { MarkdownStream } from "./markdown";
import { msSince, now } from "../clock";
import type { Key, LiveFrame, Screen } from "./screen";

// ---------------------------------------------------------------------------
// Pieces shared by the live view and by replaying a saved session.

export function header() {
  return style.muted(`clue ${VERSION} · /help for commands`);
}

const FAST_LABEL = `${style.muted(" · ")}${style.orange("fast")}`;

// The line under the input: permission mode, model, effort, fast mode and what the session
// has cost, then the folder. A folder too long for the line loses its start: "…/mentioninator/clue (main)".
export function statusLine({
  mode,
  model,
  effort,
  cwd,
  branch,
  fast = false,
  spent = 0,
}: {
  mode: string;
  model: string;
  effort: string;
  cwd: string;
  branch: string | null;
  fast?: boolean;
  spent?: number;
}) {
  const left = `${mode === "full-access" ? style.orange(mode) : style.muted(mode)}${style.muted(` · ${modelLabel(model)} · ${effort}`)}${fast ? FAST_LABEL : ""}${spent ? style.muted(` · ${money(spent)}`) : ""}`;
  const room = columns() - 1 - width(left) - 4;
  let place = `${homePath(cwd)}${branch ? ` (${branch})` : ""}`;
  if (width(place) > room) place = room > 12 ? `…${Bun.sliceAnsi(place, -(room - 1))}` : "";
  return spread(left, style.muted(place));
}

export const BAR = "┃ ";

// A prompt as it goes to the scrollback, with the bar on every row, wrapped rows included.
// clue wraps it at the current width, so it does not reflow when the window resizes, and
// copying it includes the bars.
export function promptLines(prompt: string) {
  return markPrompt(wrappedPromptLines(prompt));
}

// Marks a prompt for the terminal's jump-to-prompt keys (OSC 133): A where it starts, C where
// the reply starts. Only prompts printed once into the scrollback get marks. The live input
// is redrawn, so a mark there would point at erased rows.
export function markPrompt(lines: string[]) {
  if (lines.length === 0) return lines;
  const marked = [...lines];
  marked[0] = term.promptStart + marked[0];
  marked[marked.length - 1] += term.outputStart;
  return marked;
}

// A prompt for the pager, which draws its own rows and can't leave wrapping to the terminal.
export function wrappedPromptLines(prompt: string) {
  const max = columns() - 3;
  return prompt.split("\n").flatMap((line) => wrapLine(line, max).map((piece) => `${style.brand(BAR)}${piece}`));
}

const KIND_NAMES: Record<string, [string, string]> = {
  read: ["read", "reads"],
  search: ["search", "searches"],
  edit: ["edit", "edits"],
  write: ["write", "writes"],
  command: ["command", "commands"],
  web: ["web search", "web searches"],
  advisor: ["advisor call", "advisor calls"],
  subagent: ["subagent", "subagents"],
  skill: ["skill", "skills"],
  mcp: ["MCP call", "MCP calls"],
  question: ["question", "questions"],
  result: ["stored result", "stored results"],
};

// A tool run shows at most this many calls. ctrl+o shows the rest.
const MAX_TREE_ROWS = 8;

type Row = {
  id: string;
  label: string;
  kind: string;
  done: boolean;
  isError?: boolean;
  note?: string;
  review?: string;
  reviewing?: boolean;
  added?: number;
  removed?: number;
  startedAt: number;
  ms?: number;
  // The file a read, write or edit worked on. Its row links to it.
  path?: string;
  subagent?: SubagentInfo;
};

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

// The file a tool record worked on, as the tool was given it.
export function toolFile(record: Pick<ToolRecord, "name" | "input">) {
  const path = (record.input as { path?: unknown } | null)?.path;
  return FILE_TOOLS.has(record.name) && typeof path === "string" && path ? path : undefined;
}

// A file:// URL with the host, as ls --hyperlink writes them, so a terminal can tell a file
// on this machine from one on a server. clue runs in the session's folder, so a relative
// path joins it, in a resumed session too.
let host: string | undefined;
// Most paths need neither normalizing nor escaping, and resume links every row.
const PLAIN_PATH = /^[\w./-]+$/;
function fileUrl(path: string, cwd: string) {
  const file = isAbsolute(path) ? path : path.includes("./") || cwd === "/" ? join(cwd, path) : `${cwd}/${path}`;
  const encoded = PLAIN_PATH.test(file) ? file : encodeURI(file).replace(/[?#]/g, encodeURIComponent);
  return `file://${(host ??= hostname())}${encoded}`;
}

// Links the path at the end of a label, such as "Read src/app.ts", and leaves its look alone.
function linkPath(label: string, path: string | undefined, cwd: () => string) {
  if (!path || !label.endsWith(path)) return label;
  return label.slice(0, -path.length) + term.link(path, fileUrl(path, cwd()));
}

const isHeld = (row: Pick<Row, "review">) =>
  row.review?.startsWith("held") || row.review === "declined" || row.review === "denied";

// "5 tool calls · 2 reads · 1 edit · 2 commands · 1 failed". Line counts show on each edit's row.
// A run of only subagents reads "3 subagents · 2 running".
function summary(rows: Pick<Row, "kind" | "isError" | "review" | "done" | "subagent">[]) {
  const counts = new Map<string, number>();
  let failed = 0;
  let held = 0;
  for (const row of rows) {
    counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    if (row.isError) failed += 1;
    if (isHeld(row)) held += 1;
  }
  const dot = style.muted(" · ");
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => {
      const [one, many] = KIND_NAMES[kind] ?? [kind, `${kind}s`];
      return style.muted(`${count} ${count === 1 ? one : many}`);
    });
  const total = rows.length;
  if (counts.size === 1 && counts.has("subagent")) {
    parts.length = 0;
    const running = rows.filter((row) => row.done === false && row.subagent).length;
    if (running) parts.push(style.muted(`${running} running`));
  }
  if (held) parts.push(style.orange(`${held} held`));
  else if (failed) parts.push(style.red(`${failed} failed`));
  const head = counts.size === 1 && counts.has("subagent") ? KIND_NAMES.subagent : ["tool call", "tool calls"];
  return [style.muted(`${total} ${total === 1 ? head[0] : head[1]}`), ...parts].join(dot);
}

// Rows from before the structured subagent rows have the description in a label like this.
const SUBAGENT_LABEL = /^Subagent(?: finished)?: /;

// The parts of a subagent's row, styled. `model` is the model and the effort, if it differs.
function subagentCells(row: Row) {
  const info = row.subagent;
  const running = row.done === false && info !== undefined;
  const waiting = row.done === false && info === undefined;
  const mark = running
    ? style.brand(spinnerFrame())
    : waiting
      ? style.faint("·")
      : isHeld(row)
        ? style.orange("✗")
        : row.isError
          ? style.red("✗")
          : style.green("✓");
  const text = firstLine(row.label.replace(SUBAGENT_LABEL, "")) || "…";
  const paint =
    row.done === false ? (value: string) => value : isHeld(row) ? style.orange : row.isError ? style.red : style.muted;
  const model = info ? (info.chosen ? modelLabel(info.model) : style.muted(modelLabel(info.model))) : "";
  const effort = info?.effort ? style.muted(info.effort) : "";
  const calls = waiting
    ? "waiting"
    : info
      ? info.calls
        ? `${info.calls} ${info.calls === 1 ? "call" : "calls"}`
        : running
          ? "starting"
          : "no calls"
      : // An older row keeps its count in the note.
        (row.note ?? "");
  const ms = running ? Date.now() - info.startedAt : row.done !== false ? row.ms : undefined;
  const extra = [
    row.reviewing ? style.orange("reviewing") : "",
    info && row.note ? style.muted(row.note) : "",
    row.review ? style.muted(row.review) : "",
  ].filter(Boolean);
  return {
    mark,
    text,
    paint,
    model,
    effort,
    calls: calls ? style.muted(calls) : "",
    time: ms ? style.muted(duration(ms)) : "",
    extra: extra.join("  "),
  };
}

// Subagent rows as aligned columns: mark, description, model and effort, then calls and time.
// When the widest row doesn't fit, the time goes first, then the calls, then the effort.
// Then the description is cut. The model stays.
function subagentLines(rows: Row[]) {
  const cells = rows.map(subagentCells);
  const room = columns() - 3;
  const show = { time: true, calls: true, effort: true };
  const modelCell = (cell: (typeof cells)[number]) =>
    show.effort && cell.effort ? `${cell.model} ${cell.effort}` : cell.model;
  const tail = (cell: (typeof cells)[number]) =>
    [show.calls ? cell.calls : "", show.time ? cell.time : ""].filter(Boolean).join(style.muted(" · "));
  const widest = (measure: (cell: (typeof cells)[number]) => number) => Math.max(0, ...cells.map(measure));
  let textWidth = widest((cell) => width(cell.text));
  const lineWidth = () => {
    const modelWidth = widest((cell) => width(modelCell(cell)));
    return widest(
      (cell) =>
        2 +
        textWidth +
        (modelWidth ? 2 + modelWidth : 0) +
        (tail(cell) ? 2 + width(tail(cell)) : 0) +
        (cell.extra ? 2 + width(cell.extra) : 0),
    );
  };
  for (const part of ["time", "calls", "effort"] as const) {
    if (lineWidth() <= room) break;
    show[part] = false;
  }
  const over = lineWidth() - room;
  if (over > 0) textWidth = Math.max(8, textWidth - over);
  const modelWidth = widest((cell) => width(modelCell(cell)));
  return cells.map((cell) => {
    const parts = [
      `${cell.mark} ${cell.paint(pad(truncate(cell.text, textWidth), textWidth))}`,
      ...(modelWidth ? [pad(modelCell(cell), modelWidth)] : []),
      tail(cell),
      cell.extra,
    ];
    return parts.filter(Boolean).join("  ").trimEnd();
  });
}

// A label can be a whole script. A row shows its first line.
function firstLine(label: string) {
  const [first, ...rest] = label.trimEnd().split("\n");
  return rest.length ? `${first} …` : first;
}

function rowText(row: Row, clock: string, cwd: () => string) {
  const extra = [
    row.added || row.removed ? `${style.green(`+${row.added ?? 0}`)} ${style.red(`−${row.removed ?? 0}`)}` : "",
    row.reviewing ? style.orange("reviewing") : "",
    row.note ? style.muted(row.note) : "",
    row.review ? style.muted(row.review) : "",
    clock,
  ].filter(Boolean);
  const path = row.path ?? ("name" in row ? toolFile(row as unknown as ToolRecord) : undefined);
  const label = linkPath(firstLine(row.label), path, cwd) || "…";
  const text =
    row.done === false
      ? label
      : isHeld(row)
        ? style.orange(label)
        : row.isError
          ? style.red(label)
          : style.muted(label);
  return `${text}${extra.length ? `  ${extra.join("  ")}` : ""}`;
}

// A run of tool calls as a tree under one summary line:
//   ● 2 tool calls · 1 read · 1 command
//   ├ Read src/clock.ts
//   └ Ran git log -3 --oneline
export function toolTree(rows: Row[] | ToolRecord[], clock?: string) {
  const items = rows as Row[];
  const running = items.some((row) => row.done === false);
  const lines = [`${running ? style.brand(spinnerFrame()) : style.brand("●")} ${summary(items)}`];
  const hidden = Math.max(0, items.length - MAX_TREE_ROWS);
  const shown = hidden ? items.slice(-(MAX_TREE_ROWS - 1)) : items;
  if (hidden) lines.push(style.muted(`├ … ${hidden + 1} earlier, ctrl+o shows all`));
  // A subagent row has its own clock.
  const lastRunning = items.findLast((row) => row.done === false && row.kind !== "subagent");
  const agents = shown.filter((row) => row.kind === "subagent");
  const agentLines = new Map(subagentLines(agents).map((line, index) => [agents[index], line]));
  // Read once per tree, and only when a row links a file.
  let folder: string | undefined;
  const cwd = () => (folder ??= process.cwd());
  shown.forEach((row, index) => {
    const branch = style.muted(index === shown.length - 1 ? "└ " : "├ ");
    lines.push(`${branch}${agentLines.get(row) ?? rowText(row, row === lastRunning && clock ? clock : "", cwd)}`);
  });
  return lines;
}

export function footerLine(turn: Pick<TurnRecord, "ms" | "cost" | "stop" | "usage" | "fast" | "costIsMinimum">) {
  // Most input is read from or written to the cache, so "in" counts all three.
  const input = turn.usage.input + turn.usage.cacheRead + turn.usage.cacheWrite;
  const left = `  ${style.muted(`${duration(turn.ms)} · ${money(turn.cost, turn.costIsMinimum)} · ${tokens(input)} in · ${tokens(turn.usage.output)} out`)}${turn.fast ? FAST_LABEL : ""}`;
  return turn.stop === "interrupted" ? `${left}${style.muted(" · ")}${style.orange("interrupted")}` : left;
}

// ---------------------------------------------------------------------------

type Prompt =
  | {
      type: "confirm";
      label: string;
      subject: string;
      pattern: string;
      note?: string;
      resolve: (answer: ConfirmAnswer) => void;
    }
  | {
      type: "question";
      question: Question;
      selected: number;
      chosen: Set<number>;
      custom: string | null;
      resolve: (answer: string | null) => void;
    };

// Renders one turn as it streams, and implements the agent's event interface.
export class TurnView implements AgentEvents {
  private markdown: MarkdownStream;
  private rows: Row[] = [];
  private note: string | null = null;
  private status: "working" | "done" = "working";
  private startedAt = now();
  private prompt: Prompt | null = null;
  private wroteText = false;
  private lastAnswerAt = now();

  // `composer` draws the input under the turn, so the user can type while clue works.
  constructor(
    private screen: Screen,
    private composer?: () => LiveFrame,
  ) {
    this.markdown = new MarkdownStream((lines) => this.commitText(lines), columns);
  }

  // Time since the user last touched this turn. Time spent on a prompt doesn't count.
  get unattendedMs() {
    return msSince(this.lastAnswerAt);
  }

  private answered() {
    this.lastAnswerAt = now();
    this.screen.status("working");
  }

  start() {
    this.startedAt = now();
    this.screen.setRenderer(() => this.frame());
    this.screen.animate(true);
  }

  finish(turn: TurnRecord) {
    this.status = "done";
    this.markdown.end();
    // A row still open can't fold, and the tree would be lost with the live area.
    this.stopTools();
    this.foldTools();
    this.screen.animate(false);
    this.screen.setRenderer(() => ({ lines: [] }));
    this.screen.commit([...(this.wroteText ? [""] : []), footerLine(turn), ""]);
  }

  // Keys while a turn runs. Returns true when the view handled the key.
  handleKey(key: Key): boolean {
    const prompt = this.prompt;
    if (!prompt) return false;
    if (prompt.type === "confirm") {
      const answer: ConfirmAnswer | null =
        key.text === "y" || key.name === "enter"
          ? "once"
          : key.text === "a"
            ? "always"
            : key.text === "n" || key.name === "escape"
              ? "no"
              : null;
      if (!answer) return true;
      this.prompt = null;
      this.answered();
      prompt.resolve(answer);
      this.screen.refresh();
      return true;
    }
    const options = prompt.question.options;
    if (prompt.custom !== null) {
      if (key.name === "enter") {
        const text = prompt.custom.trim();
        const answers = [...this.picked(prompt), ...(text ? [text] : [])];
        if (!answers.length) return true;
        this.answer(prompt, answers.join(", "));
      } else if (key.name === "escape") prompt.custom = null;
      else if (key.name === "backspace") prompt.custom = prompt.custom.slice(0, -1);
      else if (key.text) prompt.custom += key.text;
      this.screen.refresh();
      return true;
    }
    const count = options.length + 1;
    if (key.name === "up") prompt.selected = (prompt.selected - 1 + count) % count;
    else if (key.name === "down" || key.name === "tab") prompt.selected = (prompt.selected + 1) % count;
    else if (key.name === "escape") this.answer(prompt, null);
    else if (key.text && /^[1-9]$/.test(key.text) && Number(key.text) <= options.length) {
      prompt.selected = Number(key.text) - 1;
      if (!prompt.question.multiple) this.answer(prompt, options[prompt.selected].label);
    } else if (key.text === " " && prompt.question.multiple && prompt.selected < options.length) {
      if (prompt.chosen.has(prompt.selected)) prompt.chosen.delete(prompt.selected);
      else prompt.chosen.add(prompt.selected);
    } else if (key.name === "enter") {
      if (prompt.selected === options.length) prompt.custom = "";
      else if (prompt.question.multiple) {
        const picked = prompt.chosen.size ? this.picked(prompt) : [options[prompt.selected].label];
        this.answer(prompt, picked.join(", "));
      } else this.answer(prompt, options[prompt.selected].label);
    } else if (key.text && key.name === "char") prompt.custom = key.text;
    this.screen.refresh();
    return true;
  }

  // The options checked so far, in the order of the list.
  private picked(prompt: Extract<Prompt, { type: "question" }>) {
    return [...prompt.chosen].sort((a, b) => a - b).map((index) => prompt.question.options[index].label);
  }

  private answer(prompt: Extract<Prompt, { type: "question" }>, answer: string | null) {
    this.prompt = null;
    this.screen.commit([
      "",
      `${style.accent("?")} ${style.bold(prompt.question.question)}`,
      `  ${answer === null ? style.faint("dismissed") : style.green(answer)}`,
    ]);
    this.answered();
    prompt.resolve(answer);
  }

  private commitText(lines: string[]) {
    this.foldTools();
    if (!this.wroteText && lines.every((line) => !line.trim())) return;
    this.wroteText = true;
    this.screen.commit(lines);
  }

  // Once every call in a run has finished, the run's tree moves to the scrollback.
  // A blank line separates it from text above. The prompt and earlier trees end with one already.
  private foldTools() {
    if (this.rows.length === 0 || this.rows.some((row) => !row.done)) return;
    const rows = this.rows;
    this.rows = [];
    this.screen.commit([...(this.wroteText ? [""] : []), ...toolTree(rows), ""]);
    this.wroteText = false;
  }

  // The turn, then the input. A prompt takes the keys, so it replaces the input while it waits.
  private frame(): LiveFrame {
    // The screen counts rows to erase them, so each entry must be one row.
    const lines = this.liveLines().flatMap((line) => line.split("\n"));
    if (this.prompt || !this.composer) return { lines };
    if (lines.length) lines.push("");
    const composer = this.composer();
    const cursor = composer.cursor && { row: composer.cursor.row + lines.length, col: composer.cursor.col };
    return { lines: [...lines, ...composer.lines], cursor };
  }

  private liveLines(): string[] {
    const lines = [...this.markdown.pending()];
    if (this.rows.length && (this.wroteText || lines.length)) lines.push("");
    const running = this.rows.filter((row) => !row.done);
    // While a prompt waits for an answer, it stands in for the row it asks about.
    const shown = this.prompt ? this.rows.filter((row) => row.done) : this.rows;
    if (shown.length) lines.push(...toolTree(shown, style.muted(duration(msSince(this.startedAt)))));
    if (this.prompt?.type === "confirm") {
      const dot = style.faint(" · ");
      // The command wraps rather than being cut, since it's what the user approves.
      const wrapped = (text: string) => text.split("\n").flatMap((line) => wrapLine(line, columns() - 3));
      lines.push("");
      wrapped(this.prompt.label).forEach((line, index) =>
        lines.push(`${index ? " " : style.accent("?")} ${style.bold(line)}`),
      );
      if (this.prompt.note) for (const line of wrapped(this.prompt.note)) lines.push(`  ${style.orange(line)}`);
      lines.push(
        `  ${style.accent("y")} ${style.muted("yes, once")}${dot}${style.accent("a")} ${style.muted(`always allow ${this.prompt.pattern} this session`)}${dot}${style.accent("n")} ${style.muted("no")}`,
      );
      return lines;
    }
    if (this.prompt?.type === "question") {
      const prompt = this.prompt;
      lines.push("", `${style.accent("?")} ${style.bold(prompt.question.question)}`);
      prompt.question.options.forEach((option, index) => {
        const active = index === prompt.selected;
        const mark = prompt.question.multiple ? (prompt.chosen.has(index) ? style.green("■ ") : style.faint("□ ")) : "";
        const label = active
          ? style.accent(`› ${index + 1} ${option.label}`)
          : `  ${style.muted(`${index + 1}`)} ${option.label}`;
        lines.push(`  ${mark}${label}${option.description ? `  ${style.faint(option.description)}` : ""}`);
      });
      const otherActive = prompt.selected === prompt.question.options.length;
      if (prompt.custom !== null) lines.push(`  ${style.accent("› ")}${prompt.custom}${style.inverse(" ")}`);
      else lines.push(`  ${otherActive ? style.accent("› Type my own answer") : style.faint("  Type my own answer")}`);
      const keys =
        prompt.custom !== null
          ? "enter send · esc back to the list"
          : prompt.question.multiple
            ? "↑↓ move · space pick · enter send · esc dismiss"
            : "↑↓ move · enter pick · esc dismiss";
      lines.push("", `  ${style.faint(keys)}`);
      return lines;
    }
    // While a tool runs, its own row carries the spinner and the clock.
    if (this.status === "working" && running.length === 0) {
      const elapsed = style.muted(duration(msSince(this.startedAt)));
      const note = this.note ? style.italic(style.muted(this.note)) : style.muted("thinking");
      if (this.rows.length && !this.markdown.pending().length) lines.push("");
      lines.push(`${style.brand(spinnerFrame())} ${note}  ${elapsed}`);
    }
    return lines;
  }

  // --- AgentEvents ---

  thinking(note: string | null) {
    if (note === null) this.note = null;
    else if (note) {
      const line = note.replace(/\s+/g, " ").trim();
      this.note = (this.note && !this.note.endsWith(".") ? `${this.note}${line}` : line).slice(-120);
    }
    this.screen.refresh();
  }

  text(delta: string) {
    this.note = null;
    if (this.rows.length && this.rows.every((row) => row.done)) this.foldTools();
    this.markdown.write(delta);
    this.screen.refresh();
  }

  textDone() {
    this.markdown.end();
    this.screen.refresh();
  }

  toolStart(id: string, label: string, kind: string) {
    this.markdown.end();
    this.note = null;
    this.rows.push({ id, label, kind, done: false, startedAt: Date.now() });
    this.screen.refresh();
  }

  toolUpdate(id: string, label: string, note?: string, subagent?: SubagentInfo) {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return;
    if (label) row.label = label;
    if (note !== undefined) row.note = note === "done" ? undefined : note;
    if (subagent) row.subagent = subagent;
    this.screen.refresh();
  }

  toolEnd(record: ToolRecord) {
    let row = this.rows.find((item) => item.id === record.id);
    if (!row) {
      row = { id: record.id, label: record.label, kind: record.kind, done: false, startedAt: record.startedAt };
      this.rows.push(row);
    }
    Object.assign(row, {
      done: true,
      label: record.label,
      kind: record.kind,
      isError: record.isError,
      note: record.note,
      review: record.review,
      reviewing: false,
      added: record.added,
      removed: record.removed,
      path: toolFile(record),
      ms: record.ms,
      subagent: record.subagent ?? row.subagent,
    });
    this.screen.refresh();
  }

  // Closes the rows of calls that will never end, such as those of a failed request.
  toolsStopped() {
    this.stopTools();
    this.screen.refresh();
  }

  private stopTools() {
    for (const row of this.rows.filter((item) => !item.done))
      Object.assign(row, { done: true, isError: true, reviewing: false, note: "didn't run" });
  }

  review(id: string, state: "reviewing" | "approved" | "held", detail?: string) {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return;
    row.reviewing = state === "reviewing";
    if (state !== "reviewing") row.note = state === "approved" ? `approved by ${detail}` : detail;
    this.screen.refresh();
  }

  confirm(label: string, subject: string, pattern: string, note?: string): Promise<ConfirmAnswer> {
    return new Promise((resolve) => {
      this.prompt = { type: "confirm", label, subject, pattern, note, resolve };
      this.screen.status("blocked-permission");
      this.screen.refresh();
    });
  }

  question(question: Question): Promise<string | null> {
    return new Promise((resolve) => {
      this.prompt = {
        type: "question",
        question,
        selected: 0,
        chosen: new Set(),
        custom: question.options.length ? null : "",
        resolve,
      };
      this.screen.status("blocked-question");
      this.screen.refresh();
    });
  }

  // A steering message reached Claude. It goes in the scrollback after the tool runs it follows.
  steered(text: string) {
    this.foldTools();
    this.screen.commit([...(this.wroteText ? [""] : []), ...promptLines(text), ""]);
    this.wroteText = false;
  }

  notice(text: string, tone: "info" | "warn" | "error" = "info") {
    const color = tone === "error" ? style.red : tone === "warn" ? style.orange : style.muted;
    this.screen.commit([`  ${color(text)}`]);
  }
}

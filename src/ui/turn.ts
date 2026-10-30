import type { ConfirmAnswer, AgentEvents } from "../agent/loop";
import { modelLabel } from "../agent/models";
import type { ToolRecord, TurnRecord } from "../session";
import type { Question } from "../tools/types";
import { VERSION } from "../config";
import { columns, duration, homePath, money, spinnerFrame, spread, style, tokens, width, wrapLine } from "./ansi";
import { MarkdownStream } from "./markdown";
import { msSince, now } from "../clock";
import type { Key, LiveFrame, Screen } from "./screen";

// ---------------------------------------------------------------------------
// Pieces shared by the live view and by replaying a saved session.

export function header() {
  return style.muted(`clue ${VERSION} · /help for commands`);
}

// The line under the input: permission mode, model and effort, then the folder.
// A folder too long for the line loses its start: "…/mentioninator/clue (main)".
export function statusLine(mode: string, model: string, effort: string, cwd: string, branch: string | null) {
  const left = `${mode === "full-access" ? style.orange(mode) : style.muted(mode)}${style.muted(` · ${modelLabel(model)} · ${effort}`)}`;
  const room = columns() - 1 - width(left) - 4;
  let place = `${homePath(cwd)}${branch ? ` (${branch})` : ""}`;
  if (width(place) > room) place = room > 12 ? `…${Bun.sliceAnsi(place, -(room - 1))}` : "";
  return spread(left, style.muted(place));
}

export const BAR = "┃ ";

// A prompt as it goes to the scrollback. The terminal wraps it and only the first line has
// the bar, so selecting it copies the text as typed, and it reflows when the window resizes.
export function promptLines(prompt: string) {
  const [first, ...rest] = prompt.split("\n");
  return [`${style.brand(BAR)}${first}`, ...rest];
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
  subagent: ["subagent", "subagents"],
  skill: ["skill", "skills"],
  mcp: ["MCP call", "MCP calls"],
  question: ["question", "questions"],
  result: ["stored result", "stored results"],
};

// A tool run shows at most this many calls. ctrl+o shows the rest.
const MAX_TREE_ROWS = 8;

type Row = { id: string; label: string; kind: string; done: boolean; isError?: boolean; note?: string; review?: string; reviewing?: boolean; added?: number; removed?: number; startedAt: number };

const isHeld = (row: Pick<Row, "review">) => row.review?.startsWith("held") || row.review === "declined" || row.review === "denied";

// "5 tool calls · 2 reads · 1 edit · 2 commands · 1 failed". Line counts show on each edit's row.
function summary(rows: Pick<Row, "kind" | "isError" | "review">[]) {
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
  if (held) parts.push(style.orange(`${held} held`));
  else if (failed) parts.push(style.red(`${failed} failed`));
  const total = rows.length;
  return [style.muted(`${total} tool ${total === 1 ? "call" : "calls"}`), ...parts].join(dot);
}

function rowText(row: Row, clock: string) {
  const extra = [
    row.added || row.removed ? `${style.green(`+${row.added ?? 0}`)} ${style.red(`−${row.removed ?? 0}`)}` : "",
    row.reviewing ? style.orange("reviewing") : "",
    row.note ? style.muted(row.note) : "",
    row.review ? style.muted(row.review) : "",
    clock,
  ].filter(Boolean);
  const label = row.label || "…";
  const text = row.done === false ? label : isHeld(row) ? style.orange(label) : row.isError ? style.red(label) : style.muted(label);
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
  const lastRunning = items.findLast((row) => row.done === false);
  shown.forEach((row, index) => {
    const branch = style.muted(index === shown.length - 1 ? "└ " : "├ ");
    lines.push(`${branch}${rowText(row, row === lastRunning && clock ? clock : "")}`);
  });
  return lines;
}

export function footerLine(turn: Pick<TurnRecord, "ms" | "cost" | "stop" | "usage">) {
  // Most input is read from or written to the cache, so "in" counts all three.
  const input = turn.usage.input + turn.usage.cacheRead + turn.usage.cacheWrite;
  const left = `  ${style.muted(`${duration(turn.ms)} · ${money(turn.cost)} · ${tokens(input)} in · ${tokens(turn.usage.output)} out`)}`;
  return turn.stop === "interrupted" ? `${left}${style.muted(" · ")}${style.orange("interrupted")}` : left;
}

// ---------------------------------------------------------------------------

type Prompt =
  | { type: "confirm"; label: string; subject: string; pattern: string; resolve: (answer: ConfirmAnswer) => void }
  | { type: "question"; question: Question; selected: number; chosen: Set<number>; custom: string | null; resolve: (answer: string | null) => void };

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
        key.text === "y" || key.name === "enter" ? "once" : key.text === "a" ? "always" : key.text === "n" || key.name === "escape" ? "no" : null;
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
    const lines = this.liveLines();
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
      lines.push("", `${style.accent("?")} ${style.bold(this.prompt.label)}`);
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
        const label = active ? style.accent(`› ${index + 1} ${option.label}`) : `  ${style.muted(`${index + 1}`)} ${option.label}`;
        lines.push(`  ${mark}${label}${option.description ? `  ${style.faint(option.description)}` : ""}`);
      });
      const otherActive = prompt.selected === prompt.question.options.length;
      if (prompt.custom !== null) lines.push(`  ${style.accent("› ")}${prompt.custom}${style.inverse(" ")}`);
      else lines.push(`  ${otherActive ? style.accent("› Type my own answer") : style.faint("  Type my own answer")}`);
      const keys = prompt.custom !== null ? "enter send · esc back to the list" : prompt.question.multiple ? "↑↓ move · space pick · enter send · esc dismiss" : "↑↓ move · enter pick · esc dismiss";
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

  toolUpdate(id: string, label: string, note?: string) {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return;
    if (label) row.label = label;
    if (note !== undefined) row.note = note === "done" ? undefined : note;
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
    });
    this.screen.refresh();
  }

  review(id: string, state: "reviewing" | "approved" | "held", detail?: string) {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return;
    row.reviewing = state === "reviewing";
    if (state !== "reviewing") row.note = state === "approved" ? `approved by ${detail}` : detail;
    this.screen.refresh();
  }

  confirm(label: string, subject: string, pattern: string): Promise<ConfirmAnswer> {
    return new Promise((resolve) => {
      this.prompt = { type: "confirm", label, subject, pattern, resolve };
      this.screen.status("blocked-permission");
      this.screen.refresh();
    });
  }

  question(question: Question): Promise<string | null> {
    return new Promise((resolve) => {
      this.prompt = { type: "question", question, selected: 0, chosen: new Set(), custom: question.options.length ? null : "", resolve };
      this.screen.status("blocked-question");
      this.screen.refresh();
    });
  }

  notice(text: string, tone: "info" | "warn" | "error" = "info") {
    const color = tone === "error" ? style.red : tone === "warn" ? style.orange : style.muted;
    this.screen.commit([`  ${color(text)}`]);
  }
}

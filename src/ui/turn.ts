import type { ConfirmAnswer, AgentEvents } from "../agent/loop";
import { modelLabel } from "../agent/models";
import type { ToolRecord, TurnRecord } from "../session";
import type { Question } from "../tools/types";
import { columns, duration, homePath, money, spinnerFrame, spread, style, wrapLine } from "./ansi";
import { MarkdownStream } from "./markdown";
import { msSince, now } from "../clock";
import type { Key, Screen } from "./screen";

// ---------------------------------------------------------------------------
// Pieces shared by the live view and by replaying a saved session.

export function header(model: string, effort: string, mode: string, cwd: string, branch: string | null, readyMs?: number) {
  const left = [
    style.bold(style.accent("clue")),
    style.muted(modelLabel(model)),
    style.muted(effort),
    mode === "full-access" ? style.orange(mode) : style.muted(mode),
    style.muted(`${homePath(cwd)}${branch ? ` (${branch})` : ""}`),
  ].join("  ");
  return spread(left, readyMs === undefined ? "" : style.faint(`ready ${duration(readyMs)}`));
}

export function promptLines(prompt: string) {
  const max = columns() - 3;
  return prompt.split("\n").flatMap((line, index) =>
    wrapLine(line, max).map((piece, pieceIndex) => (index === 0 && pieceIndex === 0 ? `${style.accent("›")} ${style.bold(piece)}` : `  ${style.bold(piece)}`)),
  );
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

type Row = { id: string; label: string; kind: string; done: boolean; isError?: boolean; note?: string; review?: string; reviewing?: boolean; added?: number; removed?: number; startedAt: number };

// "▸ 5 tool calls  2 reads  1 edit +3 −1  2 commands  1 failed"
export function summaryLine(rows: Pick<Row, "kind" | "isError" | "added" | "removed" | "review">[]) {
  const counts = new Map<string, number>();
  let added = 0;
  let removed = 0;
  let failed = 0;
  let held = 0;
  for (const row of rows) {
    counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    added += row.added ?? 0;
    removed += row.removed ?? 0;
    if (row.isError) failed += 1;
    if (row.review?.startsWith("held") || row.review === "declined" || row.review === "denied") held += 1;
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => {
      const [one, many] = KIND_NAMES[kind] ?? [kind, `${kind}s`];
      let part = `${count} ${count === 1 ? one : many}`;
      if ((kind === "edit" || kind === "write") && (added || removed)) part += ` ${style.green(`+${added}`)} ${style.red(`−${removed}`)}`;
      return style.muted(part);
    });
  if (held) parts.push(style.orange(`${held} held`));
  else if (failed) parts.push(style.red(`${failed} failed`));
  const total = rows.length;
  return `  ${style.accent("▸")} ${total} tool ${total === 1 ? "call" : "calls"}   ${parts.join("  ")}`;
}

export function footerLine(turn: Pick<TurnRecord, "firstTokenMs" | "tools" | "ms" | "cost" | "stop">) {
  const parts = [
    turn.firstTokenMs === null ? null : `first token ${duration(turn.firstTokenMs)}`,
    turn.tools ? `${turn.tools} ${turn.tools === 1 ? "tool" : "tools"}` : null,
    duration(turn.ms),
    money(turn.cost),
  ].filter(Boolean);
  const left = `  ${style.faint(parts.join("   "))}${turn.stop === "interrupted" ? `   ${style.orange("interrupted")}` : ""}`;
  return spread(left, style.faint("ctrl+o detail"));
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

  constructor(private screen: Screen) {
    this.markdown = new MarkdownStream((lines) => this.commitText(lines), columns);
  }

  start() {
    this.startedAt = now();
    this.screen.setRenderer(() => ({ lines: this.liveLines() }));
    this.screen.animate(true);
  }

  finish(turn: TurnRecord) {
    this.status = "done";
    this.markdown.end();
    this.foldTools();
    this.screen.animate(false);
    this.screen.setRenderer(() => ({ lines: [] }));
    this.screen.commit(["", footerLine(turn), ""]);
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
      prompt.resolve(answer);
      this.screen.refresh();
      return true;
    }
    const options = prompt.question.options;
    if (prompt.custom !== null) {
      if (key.name === "enter") {
        const text = prompt.custom.trim();
        if (!text) return true;
        this.answer(prompt, text);
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
        const picked = [...(prompt.chosen.size ? prompt.chosen : new Set([prompt.selected]))].map((index) => options[index].label);
        this.answer(prompt, picked.join(", "));
      } else this.answer(prompt, options[prompt.selected].label);
    } else if (key.text && key.name === "char") prompt.custom = key.text;
    this.screen.refresh();
    return true;
  }

  private answer(prompt: Extract<Prompt, { type: "question" }>, answer: string | null) {
    this.prompt = null;
    this.screen.commit([
      `  ${style.accent("?")} ${style.bold(prompt.question.question)}`,
      `    ${answer === null ? style.faint("dismissed") : style.green(answer)}`,
    ]);
    prompt.resolve(answer);
  }

  private commitText(lines: string[]) {
    this.foldTools();
    if (!this.wroteText && lines.every((line) => !line.trim())) return;
    this.wroteText = true;
    this.screen.commit(lines);
  }

  // Once every call in a run has finished, the run folds into one summary line.
  private foldTools() {
    if (this.rows.length === 0 || this.rows.some((row) => !row.done)) return;
    const rows = this.rows;
    this.rows = [];
    this.screen.commit(["", summaryLine(rows), ""]);
    this.wroteText = false;
  }

  private liveLines(): string[] {
    const lines = [...this.markdown.pending()];
    if (this.rows.length && (this.wroteText || lines.length)) lines.push("");
    const running = this.rows.filter((row) => !row.done);
    // While a prompt waits for an answer, it stands in for the row it asks about.
    const shown = this.prompt ? this.rows.filter((row) => row.done) : this.rows;
    for (const row of shown) lines.push(this.rowLine(row, row === running.at(-1)));
    if (this.prompt?.type === "confirm") {
      lines.push(`  ${style.accent("?")} ${style.bold(this.prompt.label)}`);
      lines.push(
        `    ${style.accent("y")} ${style.muted("yes, once")}   ${style.accent("a")} ${style.muted(`always allow ${this.prompt.pattern} this session`)}   ${style.accent("n")} ${style.muted("no")}`,
      );
      return lines;
    }
    if (this.prompt?.type === "question") {
      const prompt = this.prompt;
      lines.push(`  ${style.accent("?")} ${style.bold(prompt.question.question)}`);
      prompt.question.options.forEach((option, index) => {
        const active = index === prompt.selected;
        const mark = prompt.question.multiple ? (prompt.chosen.has(index) ? style.green("■ ") : style.faint("□ ")) : "";
        const label = active ? style.accent(`› ${index + 1} ${option.label}`) : `  ${style.muted(`${index + 1}`)} ${option.label}`;
        lines.push(`    ${mark}${label}${option.description ? `  ${style.faint(option.description)}` : ""}`);
      });
      const otherActive = prompt.selected === prompt.question.options.length;
      if (prompt.custom !== null) lines.push(`    ${style.accent("› ")}${prompt.custom}${style.inverse(" ")}`);
      else lines.push(`    ${otherActive ? style.accent("› Type my own answer") : style.faint("  Type my own answer")}`);
      lines.push(`    ${style.faint(prompt.question.multiple ? "↑↓ move   space pick   enter send   esc dismiss" : "↑↓ move   enter pick   esc dismiss")}`);
      return lines;
    }
    // While a tool runs, its own row carries the spinner and the clock.
    if (this.status === "working" && running.length === 0) {
      const elapsed = style.faint(duration(msSince(this.startedAt)));
      const note = this.note ? style.italic(style.muted(this.note)) : style.muted("thinking");
      if (this.rows.length && !this.markdown.pending().length) lines.push("");
      lines.push(`  ${style.accent(spinnerFrame())} ${note}  ${elapsed}`);
    }
    return lines;
  }

  private rowLine(row: Row, showClock = false) {
    const label = row.label || "…";
    if (!row.done) {
      const status = row.reviewing ? style.orange("reviewing") : row.note ? style.faint(row.note) : "";
      const clock = showClock ? `  ${style.faint(duration(msSince(this.startedAt)))}` : "";
      return `  ${style.accent(spinnerFrame())} ${label}${status ? `  ${status}` : ""}${clock}`;
    }
    const mark = row.review?.startsWith("held") || row.review === "declined" || row.review === "denied" ? style.orange("⊘") : row.isError ? style.red("✗") : style.green("✓");
    const extra = [
      row.added || row.removed ? `${style.green(`+${row.added ?? 0}`)} ${style.red(`−${row.removed ?? 0}`)}` : "",
      row.note ? style.faint(row.note) : "",
      row.review ? style.faint(row.review) : "",
    ].filter(Boolean);
    return `  ${mark} ${style.muted(label)}${extra.length ? `  ${extra.join("  ")}` : ""}`;
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
      this.screen.refresh();
    });
  }

  question(question: Question): Promise<string | null> {
    return new Promise((resolve) => {
      this.prompt = { type: "question", question, selected: 0, chosen: new Set(), custom: question.options.length ? null : "", resolve };
      this.screen.refresh();
    });
  }

  notice(text: string, tone: "info" | "warn" | "error" = "info") {
    const color = tone === "error" ? style.red : tone === "warn" ? style.orange : style.muted;
    this.screen.commit([`  ${color(text)}`]);
  }
}

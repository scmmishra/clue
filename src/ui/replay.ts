import type { Session, ToolRecord, TurnRecord } from "../session";
import { columns, duration, money, rows, style, truncate, wrapLine } from "./ansi";
import { renderMarkdown } from "./markdown";
import type { Key } from "./screen";
import { footerLine, promptLines, toolTree } from "./turn";

type Entry =
  | { type: "prompt"; text: string; at?: number }
  | { type: "text"; text: string }
  | { type: "tools"; tools: ToolRecord[] }
  | { type: "footer"; turn: TurnRecord };

const isContext = (text: string) => text.startsWith("<context>");

// Walks a session in order: prompts, reply text, tool runs and turn footers.
export function sessionEntries(session: Session): Entry[] {
  const entries: Entry[] = [];
  let prompt = 0;
  let group: ToolRecord[] = [];
  const flush = () => {
    if (group.length) entries.push({ type: "tools", tools: group });
    group = [];
  };
  for (const message of session.messages) {
    if (message.role === "user") {
      let text: string | null = null;
      if (typeof message.content === "string") text = message.content;
      else if (message.content.every((block) => block.type === "text")) {
        text = message.content.flatMap((block) => (block.type === "text" && !isContext(block.text) ? [block.text] : [])).join("\n");
      }
      if (text === null) continue; // tool results
      flush();
      if (prompt > 0 && session.turns[prompt - 1]) entries.push({ type: "footer", turn: session.turns[prompt - 1] });
      entries.push({ type: "prompt", text, at: session.turns[prompt]?.startedAt });
      prompt += 1;
      continue;
    }
    if (!Array.isArray(message.content)) {
      flush();
      entries.push({ type: "text", text: String(message.content) });
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        flush();
        entries.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        const record = session.tools.get(block.id);
        group.push(record ?? { id: block.id, name: block.name, input: block.input, label: block.name, kind: "mcp", output: "", isError: false, startedAt: 0, ms: 0 });
      }
    }
  }
  flush();
  if (prompt > 0 && session.turns[prompt - 1]) entries.push({ type: "footer", turn: session.turns[prompt - 1] });
  return entries;
}

function entryLines(entry: Entry, width: number) {
  if (entry.type === "prompt") return [...promptLines(entry.text), ""];
  if (entry.type === "text") return [...renderMarkdown(entry.text, width), ""];
  if (entry.type === "tools") return [...toolTree(entry.tools), ""];
  return [footerLine(entry.turn), ""];
}

// The conversation as it looked on screen, folded the same way. With `limit`,
// renders from the end and stops once that many lines are filled.
export function replay(session: Session, limit = Infinity): { lines: string[]; hidden: number } {
  const width = columns();
  const entries = sessionEntries(session);
  const chunks: string[][] = [];
  let count = 0;
  let index = entries.length - 1;
  for (; index >= 0 && count < limit; index--) {
    const lines = entryLines(entries[index], width);
    chunks.unshift(lines);
    count += lines.length;
  }
  const lines = chunks.flat();
  const cut = Math.max(0, lines.length - limit);
  return { lines: lines.slice(cut), hidden: index + 1 + (cut ? 1 : 0) };
}

// ---------------------------------------------------------------------------
// ctrl+o: everything, unfolded. Commands with their output, diffs, errors,
// timestamps and token use per turn.

const MAX_OUTPUT_LINES = 400;

function time(at: number) {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function toolDetail(tool: ToolRecord, width: number) {
  const mark = tool.isError ? style.red("✗") : style.green("✓");
  const lines = [`  ${mark} ${style.bold(tool.label)}  ${style.faint([tool.startedAt ? time(tool.startedAt) : "", tool.ms ? duration(tool.ms) : "", tool.review ?? ""].filter(Boolean).join("   "))}`];
  if (tool.input && Object.keys(tool.input as object).length && tool.name !== "shell") {
    const input = Bun.inspect(tool.input, { colors: true, depth: 4 });
    for (const line of input.split("\n").slice(0, 40)) lines.push(`    ${line}`);
  }
  if (tool.diff) {
    for (const line of tool.diff.split("\n").slice(0, MAX_OUTPUT_LINES)) {
      const color = line.startsWith("+") ? style.green : line.startsWith("-") ? style.red : style.faint;
      lines.push(`    ${color(line)}`);
    }
  } else if (tool.output) {
    const outputLines = tool.output.split("\n");
    for (const line of outputLines.slice(0, MAX_OUTPUT_LINES)) {
      for (const piece of wrapLine(line, width - 6)) lines.push(`    ${tool.isError ? style.red(piece) : piece}`);
    }
    if (outputLines.length > MAX_OUTPUT_LINES) lines.push(`    ${style.faint(`… ${outputLines.length - MAX_OUTPUT_LINES} more lines`)}`);
  }
  return lines;
}

export function detailLines(session: Session): string[] {
  const width = columns();
  const lines: string[] = [];
  for (const entry of sessionEntries(session)) {
    if (entry.type === "prompt") {
      lines.push(style.faint("─".repeat(width - 1)));
      if (entry.at) lines.push(style.faint(new Date(entry.at).toLocaleString()));
      lines.push(...promptLines(entry.text), "");
    } else if (entry.type === "text") lines.push(...renderMarkdown(entry.text, width), "");
    else if (entry.type === "tools") {
      for (const tool of entry.tools) lines.push(...toolDetail(tool, width), "");
    } else {
      const turn = entry.turn;
      const usage = turn.usage;
      lines.push(
        `  ${style.faint(
          [
            `${turn.model}`,
            turn.firstTokenMs === null ? "" : `first token ${duration(turn.firstTokenMs)}`,
            duration(turn.ms),
            `in ${usage.input}`,
            `cache read ${usage.cacheRead}`,
            `cache write ${usage.cacheWrite}`,
            `out ${usage.output}`,
            usage.webSearches ? `${usage.webSearches} searches` : "",
            money(turn.cost),
          ]
            .filter(Boolean)
            .join("   "),
        )}`,
        "",
      );
    }
  }
  return lines.length ? lines : [style.muted("Nothing in this session yet.")];
}

// A full-screen pager over `build()`. The content is rebuilt on every draw so a running turn shows up.
export class Pager {
  private top = -1;

  constructor(
    private build: () => string[],
    private title: string,
    private close: () => void,
  ) {}

  open() {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    this.draw();
  }

  shut() {
    process.stdout.write("\x1b[?1049l");
    this.close();
  }

  draw() {
    const content = this.build();
    const height = rows() - 1;
    const maxTop = Math.max(0, content.length - height);
    if (this.top === -1 || this.top > maxTop) this.top = maxTop;
    const view = content.slice(this.top, this.top + height);
    while (view.length < height) view.push("");
    const position = content.length <= height ? "all" : `${Math.round(((this.top + height) / content.length) * 100)}%`;
    const bar = style.inverse(` ${this.title}  ${position}  ↑↓ scroll  pgup/pgdn  g/G top/end  esc close `);
    const max = columns();
    process.stdout.write(`\x1b[H${view.map((line) => `\x1b[2K${truncate(line, max)}\x1b[0m`).join("\n")}\n\x1b[2K${truncate(bar, max)}`);
  }

  handle(key: Key) {
    const height = rows() - 1;
    if (key.name === "escape" || key.text === "q" || (key.ctrl && (key.name === "o" || key.name === "c"))) return this.shut();
    if (key.name === "up" || key.text === "k") this.top -= 1;
    else if (key.name === "down" || key.text === "j") this.top += 1;
    else if (key.name === "pageup" || key.text === "b") this.top -= height;
    else if (key.name === "pagedown" || key.text === " ") this.top += height;
    else if (key.text === "g" || key.name === "home") this.top = 0;
    else if (key.text === "G" || key.name === "end") this.top = Number.MAX_SAFE_INTEGER;
    this.top = Math.max(0, this.top);
    this.draw();
  }
}

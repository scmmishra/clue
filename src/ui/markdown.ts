import { colorsEnabled, style, width, wrapLine } from "./ansi";
import { highlight } from "./highlight";

// Renders Markdown for the terminal. Bun parses it, and the callbacks below draw each
// element. Block callbacks return a placeholder, and layout() draws the blocks from the
// top down, so each one knows the width it has. Streaming: finished blocks (text up to
// a blank line outside a code fence) are rendered once and committed. Only the block
// still arriving is rendered again for the live view.

const INDENT = "  ";
const LIST_INDENT = "  ";
const BULLET = "•";
const TASK_DONE = "☒";
const TASK_OPEN = "☐";
const IMAGE = "📷";
const QUOTE_BAR = "│";
const RULE = "─";
const TAB = "    ";
const MIN_WIDTH = 20;

type Align = "left" | "center" | "right";
type Cell = { kind: "cell"; text: string; header: boolean; align?: Align };
type Row = { kind: "row"; cells: Cell[] };
type Item = { kind: "item"; marker: string; nodes: Node[] };
type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "code"; code: string; language?: string }
  | { kind: "list"; items: Item[] }
  | { kind: "quote"; nodes: Node[] }
  | { kind: "rule" }
  | { kind: "table"; rows: Row[] }
  | Item
  | Row
  | Cell;
// Text outside any block, such as the first line of a tight list item.
type Node = Block | string;

// Blocks of the render in progress. A placeholder is \0, the block's index, \0.
// Resume renders every reply before the first paint, while the JIT is still off. There,
// plain loops cost less than forEach, map and filter, so the code below uses them.
let blocks: Block[] = [];
const PLACEHOLDER = /\0(\d+)\0/;
const place = (block: Block) => `\0${blocks.push(block) - 1}\0`;

function nodes(children: string): Node[] {
  const parts = children.split(PLACEHOLDER);
  const result: Node[] = [];
  for (let index = 0; index < parts.length; index++) {
    if (index % 2) result.push(blocks[Number(parts[index])]);
    else {
      const text = parts[index].trim();
      if (text) result.push(text);
    }
  }
  return result;
}

function only<K extends Block["kind"]>(list: Node[], kind: K) {
  const result: Extract<Block, { kind: K }>[] = [];
  for (const node of list)
    if (typeof node !== "string" && node.kind === kind) result.push(node as Extract<Block, { kind: K }>);
  return result;
}

// Model output can hold escape codes. Bun's own renderer drops control characters. render() drops
// them from the whole input once, which also keeps the \0 placeholders unique. A numeric
// reference such as &#x1b; becomes a control character only after parsing, so input with
// one also cleans each text node.
const CONTROL = /[\0-\x08\x0b-\x1f\x7f]/;
const CONTROLS = new RegExp(CONTROL.source, "g");
const clean = (text: string) => (CONTROL.test(text) ? text.replace(CONTROLS, "") : text);

const strike = (text: string) => (colorsEnabled ? `\x1b[9m${text}\x1b[29m` : text);

function hyperlink(text: string, href: string) {
  if (!colorsEnabled) return text === href ? text : `${text} (${href})`;
  const url = href.startsWith("www.") ? `https://${href}` : href;
  return `\x1b]8;;${url}\x1b\\${style.accent(style.underline(text))}\x1b]8;;\x1b\\`;
}

function markerFor(meta: Bun.markdown.ListItemMeta) {
  if (meta.checked !== undefined) return meta.checked ? TASK_DONE : TASK_OPEN;
  return meta.ordered ? `${(meta.start ?? 1) + meta.index}.` : BULLET;
}

const callbacks: Bun.markdown.RenderCallbacks = {
  strong: style.bold,
  emphasis: style.italic,
  strikethrough: strike,
  codespan: style.accent,
  link: (children, meta) => hyperlink(children, meta.href),
  image: (children, meta) => hyperlink(style.violet(`${IMAGE} ${children}`), meta.src),
  paragraph: (children) => place({ kind: "paragraph", text: children }),
  heading: (children) => place({ kind: "heading", text: children }),
  code: (children, meta) => place({ kind: "code", code: children, language: meta?.language }),
  blockquote: (children) => place({ kind: "quote", nodes: nodes(children) }),
  hr: () => place({ kind: "rule" }),
  list: (children) => place({ kind: "list", items: only(nodes(children), "item") }),
  listItem: (children, meta) => place({ kind: "item", marker: markerFor(meta), nodes: nodes(children) }),
  table: (children) => place({ kind: "table", rows: only(nodes(children), "row") }),
  tr: (children) => place({ kind: "row", cells: only(nodes(children), "cell") }),
  th: (children, meta) => place({ kind: "cell", text: children, header: true, align: meta?.align }),
  td: (children, meta) => place({ kind: "cell", text: children, header: false, align: meta?.align }),
};
const decodingCallbacks: Bun.markdown.RenderCallbacks = { ...callbacks, text: clean };

// Soft and hard line breaks both arrive as \n. Both become spaces, and the text is wrapped again.
const wrap = (text: string, size: number) =>
  wrapLine(text.includes("\n") ? text.replace(/\s*\n\s*/g, " ") : text, size);

// A code block between two rules, as long as its longest line. The code keeps its own
// line breaks and is never wrapped, so a copied line matches the source.
function codeBlock(code: string, language: string | undefined, size: number) {
  const source = code.replace(/\n$/, "").replaceAll("\t", TAB);
  const label = language ? ` ${language} ` : "";
  const lines = source ? highlight(source, language) : [];
  const longest = Math.max(0, ...source.split("\n").map(width));
  const ruleWidth = Math.min(size, Math.max(longest, width(label) + 2));
  const top = RULE + label + RULE.repeat(Math.max(1, ruleWidth - 1 - width(label)));
  return [style.faint(top), ...lines, style.faint(RULE.repeat(ruleWidth))];
}

function listLines(list: { items: Item[] }, size: number) {
  let markerWidth = 0;
  // A loose list wraps its items in paragraphs, and gets a blank line between items.
  let loose = false;
  for (const item of list.items) {
    markerWidth = Math.max(markerWidth, width(item.marker));
    if (!loose) for (const node of item.nodes) if (typeof node !== "string" && node.kind === "paragraph") loose = true;
  }
  const hanging = LIST_INDENT + " ".repeat(markerWidth + 1);
  const lines: string[] = [];
  for (let index = 0; index < list.items.length; index++) {
    const item = list.items[index];
    if (loose && index > 0) lines.push("");
    const marker = `${LIST_INDENT}${style.faint(item.marker.padStart(markerWidth))}`;
    const body = blockLines(item.nodes, size - hanging.length);
    if (body.length === 0) lines.push(marker);
    for (let row = 0; row < body.length; row++) {
      const line = body[row];
      if (row === 0) lines.push(`${marker} ${line}`);
      else lines.push(line ? hanging + line : line);
    }
  }
  return lines;
}

function tableLines(rows: Row[], size: number) {
  const count = Math.max(0, ...rows.map((row) => row.cells.length));
  if (count === 0) return [];
  const natural = Array.from({ length: count }, (_, column) =>
    Math.max(1, ...rows.map((row) => width(row.cells[column]?.text ?? ""))),
  );
  // Borders take three columns per cell plus one. The widest column gives up space first.
  const room = Math.max(count, size - (3 * count + 1));
  const widths = [...natural];
  for (let total = widths.reduce((a, b) => a + b, 0); total > room; total--) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 1) break;
    widths[widest]--;
  }
  const border = (left: string, middle: string, right: string) =>
    style.faint(left + widths.map((size) => RULE.repeat(size + 2)).join(middle) + right);
  const align = (text: string, size: number, alignment?: Align) => {
    const gap = Math.max(0, size - width(text));
    if (alignment === "right") return " ".repeat(gap) + text;
    if (alignment === "center") return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(Math.ceil(gap / 2));
    return text + " ".repeat(gap);
  };
  const bar = style.faint("│");
  const lines = [border("┌", "┬", "┐")];
  rows.forEach((row, index) => {
    const cells = widths.map((size, column) => {
      const cell = row.cells[column];
      const text = cell ? (cell.header ? style.bold(cell.text) : cell.text) : "";
      return { lines: wrap(text, size), size, align: cell?.align };
    });
    const height = Math.max(...cells.map((cell) => cell.lines.length));
    for (let line = 0; line < height; line++) {
      const parts = cells.map((cell) => ` ${align(cell.lines[line] ?? "", cell.size, cell.align)} `);
      lines.push(bar + parts.join(bar) + bar);
    }
    const headerEnds = row.cells.some((cell) => cell.header) && !rows[index + 1]?.cells.some((cell) => cell.header);
    if (headerEnds && index < rows.length - 1) lines.push(border("├", "┼", "┤"));
  });
  lines.push(border("└", "┴", "┘"));
  return lines;
}

function nodeLines(node: Node, size: number): string[] {
  if (typeof node === "string") return wrap(node, size);
  switch (node.kind) {
    case "paragraph":
      return wrap(node.text, size);
    case "heading":
      return wrap(style.bold(node.text), size);
    case "code":
      return codeBlock(node.code, node.language, size);
    case "list":
      return listLines(node, size);
    case "quote":
      return blockLines(node.nodes, size - 2).map((line) => style.faint(QUOTE_BAR) + (line ? ` ${line}` : ""));
    case "rule":
      return [style.faint(RULE.repeat(size))];
    case "table":
      return tableLines(node.rows, size);
    case "item":
      return listLines({ items: [node] }, size);
    default:
      return [];
  }
}

const isText = (node: Node | undefined) => typeof node === "string" || node?.kind === "paragraph";

// Lays out blocks one after another, with a blank line between them. A list right after
// text stays attached to it, as in "Steps:" followed by the steps.
function blockLines(list: Node[], size: number) {
  const lines: string[] = [];
  for (let index = 0; index < list.length; index++) {
    const node = list[index];
    const attached = typeof node !== "string" && node.kind === "list" && isText(list[index - 1]);
    if (index > 0 && !attached) lines.push("");
    for (const line of nodeLines(node, size)) lines.push(line);
  }
  return lines;
}

const PARSER_OPTIONS = { autolinks: true };

// Anything Markdown would parse: inline marks, links, HTML, entities, and lines that start
// a heading, list, quote, rule or code block. Text without any of it is only paragraphs.
const MARKUP = /[\\`*_~[\]!<>&|#@]|https?:|www\.|^\s*(?:[-+=]|\d+[.)])|^(?: {4}|\t)/m;
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

// Plain text skips the parser. That matters on resume, where every reply in the session
// is rendered before the first paint, while the JIT is still off.
function parse(source: string): Node[] {
  if (!MARKUP.test(source)) {
    const paragraphs: Node[] = [];
    for (const part of source.split(PARAGRAPH_BREAK)) if (part.trim()) paragraphs.push(part.trim());
    return paragraphs;
  }
  return nodes(Bun.markdown.render(source, source.includes("&#") ? decodingCallbacks : callbacks, PARSER_OPTIONS));
}

function render(text: string, columns: number): string[] {
  blocks = [];
  const lines = blockLines(parse(clean(text)), Math.max(MIN_WIDTH, columns - INDENT.length - 1));
  blocks = [];
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  for (let index = 0; index < lines.length; index++) if (lines[index]) lines[index] = INDENT + lines[index];
  return lines;
}

// Index just past the last blank line that sits outside a code fence, or -1.
function lastBoundary(text: string) {
  let fenced = false;
  let boundary = -1;
  let index = 0;
  for (const line of text.split("\n")) {
    const end = index + line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && line.trim() === "" && end <= text.length) boundary = end;
    index = end;
  }
  return boundary;
}

export class MarkdownStream {
  private buffer = "";
  private blocks = 0;

  constructor(
    private push: (lines: string[]) => void,
    private columns: () => number,
  ) {}

  write(text: string) {
    this.buffer += text;
    const boundary = lastBoundary(this.buffer);
    if (boundary <= 0) return;
    const done = this.buffer.slice(0, boundary);
    this.buffer = this.buffer.slice(boundary);
    this.commit(done);
  }

  // The block still arriving, rendered for the live view.
  pending(): string[] {
    return this.buffer.trim() ? render(this.buffer, this.columns()) : [];
  }

  end() {
    const rest = this.buffer;
    this.buffer = "";
    this.commit(rest);
    this.blocks = 0;
  }

  private commit(text: string) {
    if (!text.trim()) return;
    const lines = render(text, this.columns());
    if (lines.length === 0) return;
    this.push(this.blocks++ > 0 ? ["", ...lines] : lines);
  }
}

// Renders a complete Markdown string to lines.
export const renderMarkdown = (text: string, columns: number) => render(text, columns);

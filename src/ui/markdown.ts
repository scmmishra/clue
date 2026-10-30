import { colorsEnabled, lightBackground, style } from "./ansi";

// Streams Markdown through Bun's native renderer. Finished blocks (text up to a
// blank line outside a code fence) are rendered once and committed; only the
// block still arriving is re-rendered for the live view.

const INDENT = "  ";

// Bun's theme colors headings, list markers, links and inline code. These
// replacements turn them into clue's greys. Code blocks keep their syntax colors.
// The codes are the ones Bun 1.4 emits. A new Bun that changes them only brings the colors back.
const BRIGHT = style.accent("\0").split("\0")[0];
const RECOLOR: [RegExp, string][] = [
  [/\x1b\[48;5;\d+m\x1b\[38;5;\d+m([^\x1b]*)\x1b\[39m\x1b\[49m/g, style.accent("$1")],
  [/\x1b\[1m\x1b\[3[56]m/g, "\x1b[1m"],
  [/\x1b\[3[26]m(• |☒ |\d+\. )/g, "\x1b[2m$1"],
  [/\x1b\[34m\x1b\[4m/g, `${BRIGHT}\x1b[4m`],
];
const HEADING_RULE = /^\x1b\[2m[═─]+\x1b\[0m$/;

function render(text: string, columns: number): string[] {
  let out = Bun.markdown.ansi(text, { columns: Math.max(20, columns - INDENT.length - 1), hyperlinks: colorsEnabled, colors: colorsEnabled, light: lightBackground });
  if (colorsEnabled) for (const [pattern, replacement] of RECOLOR) out = out.replace(pattern, replacement);
  const lines = out.replace(/\n+$/, "").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  // Headings are bold. The rule Bun draws under each one is dropped.
  const kept = lines.filter((line, index) => !(index > 0 && lines[index - 1].startsWith("\x1b[1m") && HEADING_RULE.test(line)));
  return kept.map((line) => (line ? INDENT + line : line));
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

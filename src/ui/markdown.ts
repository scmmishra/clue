import { colorsEnabled } from "./ansi";

// Streams Markdown through Bun's native renderer. Finished blocks (text up to a
// blank line outside a code fence) are rendered once and committed; only the
// block still arriving is re-rendered for the live view.

const INDENT = "  ";

function render(text: string, columns: number): string[] {
  const out = Bun.markdown.ansi(text, { columns: Math.max(20, columns - INDENT.length - 1), hyperlinks: colorsEnabled, colors: colorsEnabled });
  const lines = out.replace(/\n+$/, "").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.map((line) => (line ? INDENT + line : line));
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

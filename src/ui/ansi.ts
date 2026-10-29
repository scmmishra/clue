// Terminal styling on Bun's native ANSI functions. One accent, a dim tone for
// metadata, and diff colors. NO_COLOR turns every style into plain text.

const enabled = !process.env.NO_COLOR && process.env.TERM !== "dumb";

// Bun.color picks 16, 256 or 24-bit codes from what the terminal supports.
const fg = (hex: string) => (enabled ? (Bun.color(hex, "ansi") ?? "") : "");
const FG_RESET = "\x1b[39m";

const wrap = (open: string, close: string) => (text: string) => (enabled && open ? `${open}${text}${close}` : text);

// The palette: warm gold for clue itself, cool greys around it.
const color = (hex: string) => wrap(fg(hex), FG_RESET);

export const style = {
  accent: color("#E6B450"),
  muted: color("#8A93A5"),
  faint: color("#5C6370"),
  green: color("#8BD49C"),
  red: color("#F07178"),
  blue: color("#82AAFF"),
  violet: color("#C3A6FF"),
  orange: color("#FFB86C"),
  bold: wrap("\x1b[1m", "\x1b[22m"),
  italic: wrap("\x1b[3m", "\x1b[23m"),
  underline: wrap("\x1b[4m", "\x1b[24m"),
  inverse: wrap("\x1b[7m", "\x1b[27m"),
};

export const colorsEnabled = enabled;

export const stripAnsi = (text: string) => Bun.stripANSI(text);

// Display width, ignoring escape codes and counting wide characters as two columns.
export const width = (text: string) => Bun.stringWidth(text);

export const columns = () => Math.max(process.stdout.columns || 80, 20);
export const rows = () => Math.max(process.stdout.rows || 24, 8);

// Cuts a styled string to a display width, keeping escape codes and links intact.
export const truncate = (text: string, max: number, ellipsis = "…") => (width(text) <= max ? text : Bun.sliceAnsi(text, 0, max, ellipsis));

// Word-wraps a styled line to `max` columns. Long words break mid-word.
export const wrapLine = (text: string, max: number): string[] =>
  max < 4 || width(text) <= max ? [text] : Bun.wrapAnsi(text, max, { hard: true }).split("\n");

// Pads a styled string with spaces to a display width.
export const pad = (text: string, size: number) => text + " ".repeat(Math.max(0, size - width(text)));

// Places `right` at the end of a line that starts with `left`.
export function spread(left: string, right: string, size = columns() - 1) {
  const gap = size - width(left) - width(right);
  return gap >= 2 ? left + " ".repeat(gap) + right : left;
}

export const term = {
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clearDown: "\x1b[J",
  up: (n: number) => (n > 0 ? `\x1b[${n}A` : ""),
  column: (n: number) => `\x1b[${n + 1}G`,
  bracketedPasteOn: "\x1b[?2004h",
  bracketedPasteOff: "\x1b[?2004l",
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinnerFrame = () => SPINNER[Math.floor(Date.now() / 80) % SPINNER.length];

export function duration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

export function money(usd: number | null) {
  if (usd === null) return "–";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function homePath(path: string) {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

import { columns, term, truncate } from "./ansi";
import { shouldRing, statusReport, type ProgramStatus } from "./status";

// Output model: finished lines are printed once and become normal scrollback.
// Only the "live" lines at the bottom (input, running tools, a spinner) are
// redrawn in place. That keeps the terminal's own scrolling, search and copy.

export type LiveFrame = { lines: string[]; cursor?: { row: number; col: number } };

const FRAME_MS = 16;

export class Screen {
  private live: LiveFrame = { lines: [] };
  private drawnRows = 0;
  private cursorRowFromTop = 0;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private suspended = false;
  private held: string[] = [];
  private render: () => LiveFrame = () => ({ lines: [] });
  bell = false;

  constructor(private out: NodeJS.WriteStream = process.stdout) {}

  // The function that produces the live lines. Called on every redraw.
  setRenderer(render: () => LiveFrame) {
    this.render = render;
    this.refresh();
  }

  // Redraws on a timer while something animates, such as a spinner.
  animate(on: boolean) {
    if (on && !this.ticker) this.ticker = setInterval(() => this.refresh(), 80);
    if (!on && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  // Prints finished lines above the live area.
  commit(lines: string[]) {
    if (lines.length === 0) return;
    if (this.suspended) {
      this.held.push(...lines);
      return;
    }
    this.out.write(this.erase() + lines.map((line) => `${line}\x1b[0m`).join("\n") + "\n" + this.draw());
  }

  refresh() {
    if (this.scheduled || this.suspended) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.flush();
    }, FRAME_MS);
  }

  flush() {
    if (this.suspended) return;
    this.out.write(this.erase() + this.draw());
  }

  // Stops drawing while a full-screen view owns the terminal.
  suspend() {
    this.out.write(this.erase());
    this.suspended = true;
  }

  resume() {
    this.suspended = false;
    const held = this.held;
    this.held = [];
    this.drawnRows = 0;
    this.cursorRowFromTop = 0;
    if (held.length) this.commit(held);
    else this.flush();
  }

  // Reports clue's state to the terminal. It moves nothing on screen, so it needs no redraw.
  status(status: ProgramStatus, unattendedMs = 0) {
    this.out.write(statusReport(status) + (this.bell && shouldRing(status, unattendedMs) ? "\x07" : ""));
  }

  // Clears the live area and leaves the cursor at its first column.
  clearLive() {
    this.out.write(this.erase());
    this.drawnRows = 0;
  }

  private erase() {
    if (this.drawnRows === 0) return "\r";
    return `${term.up(this.cursorRowFromTop)}\r${term.clearDown}`;
  }

  // A row that scrolls past the top of the terminal can never be erased, so it would stay
  // behind in the scrollback. The frame keeps its end, and the cursor stays in view.
  private visible({ lines, cursor }: LiveFrame) {
    const limit = Math.max(1, (this.out.rows || Infinity) - 1);
    if (lines.length <= limit) return { rows: lines, cursor };
    const start = cursor ? Math.min(cursor.row, lines.length - limit) : lines.length - limit;
    return { rows: lines.slice(start, start + limit), cursor: cursor && { row: cursor.row - start, col: cursor.col } };
  }

  private draw() {
    this.live = this.render();
    const max = columns() - 1;
    const { rows: shown, cursor } = this.visible(this.live);
    const lines = shown.map((line) => truncate(line, max));
    this.drawnRows = lines.length;
    if (lines.length === 0) {
      this.cursorRowFromTop = 0;
      return term.hideCursor;
    }
    let text = lines.map((line) => `${line}\x1b[0m`).join("\n");
    if (cursor) {
      const fromBottom = lines.length - 1 - cursor.row;
      text += term.up(fromBottom) + term.column(cursor.col) + term.showCursor;
      this.cursorRowFromTop = cursor.row;
    } else {
      text += term.hideCursor;
      this.cursorRowFromTop = lines.length - 1;
    }
    return text;
  }
}

// ---------------------------------------------------------------------------
// Keys

export type Key = {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  text?: string;
};

const SEQUENCES: Record<string, Key> = {
  "\r": { name: "enter" },
  "\n": { name: "newline" },
  "\x1b\r": { name: "newline" },
  "\x1b[13;2u": { name: "newline" },
  "\x1b[13;2~": { name: "newline" },
  "\x7f": { name: "backspace" },
  "\b": { name: "backspace" },
  "\x1b\x7f": { name: "backspace", meta: true },
  "\x17": { name: "backspace", meta: true },
  "\x1b[3~": { name: "delete" },
  "\x1b[A": { name: "up" },
  "\x1b[B": { name: "down" },
  "\x1b[C": { name: "right" },
  "\x1b[D": { name: "left" },
  "\x1bOA": { name: "up" },
  "\x1bOB": { name: "down" },
  "\x1bOC": { name: "right" },
  "\x1bOD": { name: "left" },
  "\x1b[1;3C": { name: "right", meta: true },
  "\x1b[1;3D": { name: "left", meta: true },
  "\x1b[1;5C": { name: "right", meta: true },
  "\x1b[1;5D": { name: "left", meta: true },
  "\x1bf": { name: "right", meta: true },
  "\x1bb": { name: "left", meta: true },
  "\x1b[H": { name: "home" },
  "\x1b[F": { name: "end" },
  "\x1bOH": { name: "home" },
  "\x1bOF": { name: "end" },
  "\x1b[1~": { name: "home" },
  "\x1b[4~": { name: "end" },
  "\x1b[5~": { name: "pageup" },
  "\x1b[6~": { name: "pagedown" },
  "\x1b[Z": { name: "tab", shift: true },
  "\t": { name: "tab" },
  "\x1b": { name: "escape" },
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// tmux negotiates the kitty protocol with the outer terminal itself.
export const keyModes = (tmux: boolean) => ({
  on: (tmux ? "" : term.kittyKeysOn) + term.modifyKeysOn,
  off: (tmux ? "" : term.kittyKeysOff) + term.modifyKeysOff,
});

const KITTY_KEY = /^\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::(\d+))?)?(?:;[\d:]*)?u/;
const MODIFIED_KEY = /^\x1b\[27;(\d+);(\d+)~/;
const FUNCTIONAL_KEY = /^\x1b\[(\d+);(\d+)(?::(\d))?([ABCDHF~])/;
// Caps lock and num lock. A terminal can report them with every key, but they aren't shortcuts.
const LOCK_FLAGS = 64 | 128;
const KEYPAD_ENTER = 57414;
// Keys with no character, such as caps lock, use this Unicode private range.
const PRIVATE_KEYS = [57344, 63743];
const KEY_RELEASE = 3;

// A key reported with its modifiers. Ctrl and alt become the sequences terminals send
// without these reports, so every key keeps one meaning.
// Maps an arrow, home, end or tilde key with reported modifiers to the key without lock flags.
function functionalKey(number: string, mods: number, event: number, final: string): Key | null {
  if (event === KEY_RELEASE) return null;
  const flags = (mods - 1) & ~LOCK_FLAGS;
  if (flags) return SEQUENCES[`\x1b[${number};${flags + 1}${final}`] ?? null;
  return SEQUENCES[final === "~" ? `\x1b[${number}~` : `\x1b[${final}`] ?? null;
}

function reportedKey(code: number, mods: number, event: number): Key[] {
  const flags = (mods - 1) & ~LOCK_FLAGS;
  const [shift, alt, ctrl, command] = [flags & 1, flags & 2, flags & 4, flags & 8];
  if (event === KEY_RELEASE || command) return [];
  if (code === 13 || code === KEYPAD_ENTER) return [{ name: flags ? "newline" : "enter" }];
  if (code >= PRIVATE_KEYS[0] && code <= PRIVATE_KEYS[1]) return [];
  if (code === 27) return [{ name: "escape" }];
  if (code === 9) return [shift ? { name: "tab", shift: true } : { name: "tab" }];
  if (code === 127 || code === 8) return [alt || ctrl ? { name: "backspace", meta: true } : { name: "backspace" }];
  const char = String.fromCodePoint(code);
  if (ctrl && /[a-z]/i.test(char)) return parseKeys(String.fromCharCode(code & 31));
  if (alt) return parseKeys(`\x1b${char}`);
  return [{ name: "char", text: shift ? char.toUpperCase() : char }];
}

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let index = 0;
  while (index < data.length) {
    if (data.startsWith(PASTE_START, index)) {
      const end = data.indexOf(PASTE_END, index);
      const text = data.slice(index + PASTE_START.length, end === -1 ? undefined : end);
      keys.push({ name: "paste", text: text.replace(/\r\n?/g, "\n") });
      index = end === -1 ? data.length : end + PASTE_END.length;
      continue;
    }
    if (data[index] === "\x1b") {
      const rest = data.slice(index);
      const kitty = rest.match(KITTY_KEY);
      const modified = rest.match(MODIFIED_KEY);
      const functional = rest.match(FUNCTIONAL_KEY);
      if (functional) {
        const key = functionalKey(functional[1], Number(functional[2]), Number(functional[3] ?? 1), functional[4]);
        if (key) keys.push(key);
        index += functional[0].length;
        continue;
      }
      if (kitty) {
        keys.push(...reportedKey(Number(kitty[1]), Number(kitty[2] ?? 1), Number(kitty[3] ?? 1)));
        index += kitty[0].length;
        continue;
      }
      if (modified) {
        keys.push(...reportedKey(Number(modified[2]), Number(modified[1]), 1));
        index += modified[0].length;
        continue;
      }
    }
    let matched = false;
    for (const length of [7, 6, 5, 4, 3, 2]) {
      const chunk = data.slice(index, index + length);
      if (chunk.length === length && SEQUENCES[chunk]) {
        keys.push(SEQUENCES[chunk]);
        index += length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const char = data[index];
    if (char === "\x1b" && index + 1 < data.length) {
      // Unknown escape sequence: skip it whole.
      const rest = data.slice(index).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
      if (rest) {
        index += rest[0].length;
        continue;
      }
      keys.push({ name: data[index + 1], meta: true });
      index += 2;
      continue;
    }
    if (SEQUENCES[char]) {
      keys.push(SEQUENCES[char]);
      index += 1;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 32) {
      keys.push({ name: String.fromCharCode(code + 96), ctrl: true });
      index += 1;
      continue;
    }
    const point = String.fromCodePoint(data.codePointAt(index)!);
    keys.push({ name: "char", text: point });
    index += point.length;
  }
  return keys;
}

export type KeyHandler = (key: Key) => void;

// Owns raw stdin. The app swaps the handler as focus moves between the editor,
// a running turn, a permission prompt or a picker.
export class Keyboard {
  private handler: KeyHandler = () => {};
  private started = false;
  private held: Key[] | null = null;
  private modes = keyModes(Boolean(process.env.TMUX));

  start() {
    if (this.started || !process.stdin.isTTY) return;
    this.started = true;
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdout.write(term.bracketedPasteOn + this.modes.on);
    // These modes outlive clue, so any way out has to turn them off.
    process.once("exit", () => this.stop());
    process.stdin.on("data", (data: string) => {
      for (const key of parseKeys(data)) this.deliver(key);
    });
    process.stdin.resume();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    process.stdout.write(term.bracketedPasteOff + this.modes.off + term.showCursor);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  set(handler: KeyHandler) {
    this.handler = handler;
  }

  // Keys that arrive during `work` wait for it, so Enter can't overtake a paste.
  hold(work: Promise<unknown>) {
    this.held ??= [];
    void work.finally(() => {
      const keys = this.held ?? [];
      this.held = null;
      for (const key of keys) this.deliver(key);
    });
  }

  private deliver(key: Key) {
    if (this.held) this.held.push(key);
    else this.handler(key);
  }
}

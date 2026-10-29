import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { CLUE_HOME, ensureDir, paths } from "../config";
import { columns, style, width } from "./ansi";
import type { Key, LiveFrame } from "./screen";

const PROMPT = "› ";
const CONTINUATION = "  ";
const HISTORY_LIMIT = 500;
const PASTE_FOLD_LINES = 12;

export type Command = { name: string; description: string };

// A small line editor: multi-line input, history, paste, word movement.
export class Editor {
  text = "";
  cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = "";
  private completionIndex = 0;

  constructor(
    private commands: Command[],
    private placeholder = "Describe a task, or type / for commands",
  ) {
    try {
      if (existsSync(paths.history)) {
        this.history = readFileSync(paths.history, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string)
          .slice(-HISTORY_LIMIT);
      }
    } catch {
      this.history = [];
    }
  }

  remember(entry: string) {
    if (!entry.trim() || this.history.at(-1) === entry) return;
    this.history.push(entry);
    try {
      ensureDir(CLUE_HOME);
      appendFileSync(paths.history, `${JSON.stringify(entry)}\n`);
    } catch {}
  }

  clear() {
    this.text = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.completionIndex = 0;
  }

  private insert(value: string) {
    this.text = this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor);
    this.cursor += value.length;
    this.completionIndex = 0;
  }

  private matches(): Command[] {
    if (!this.text.startsWith("/") || this.text.includes(" ") || this.text.includes("\n")) return [];
    return this.commands.filter((command) => command.name.startsWith(this.text.slice(1)));
  }

  private wordLeft() {
    let index = this.cursor;
    while (index > 0 && /\s/.test(this.text[index - 1])) index--;
    while (index > 0 && !/\s/.test(this.text[index - 1])) index--;
    return index;
  }

  private wordRight() {
    let index = this.cursor;
    while (index < this.text.length && /\s/.test(this.text[index])) index++;
    while (index < this.text.length && !/\s/.test(this.text[index])) index++;
    return index;
  }

  private lineBounds() {
    const start = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
    const end = this.text.indexOf("\n", this.cursor);
    return { start, end: end === -1 ? this.text.length : end };
  }

  // Returns "submit" when Enter should send the text.
  handle(key: Key): "submit" | "handled" | "ignored" {
    switch (key.name) {
      case "char":
        this.insert(key.text ?? "");
        return "handled";
      case "paste":
        this.insert(key.text ?? "");
        return "handled";
      case "newline":
        this.insert("\n");
        return "handled";
      case "enter": {
        // A trailing backslash continues the input on a new line.
        if (this.text[this.cursor - 1] === "\\") {
          this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
          this.cursor -= 1;
          this.insert("\n");
          return "handled";
        }
        const matches = this.matches();
        if (matches.length && this.text.slice(1) !== matches[0].name && !this.commands.some((command) => command.name === this.text.slice(1))) {
          this.text = `/${matches[this.completionIndex % matches.length].name}`;
          this.cursor = this.text.length;
        }
        return this.text.trim() ? "submit" : "handled";
      }
      case "tab": {
        const matches = this.matches();
        if (matches.length) {
          this.text = `/${matches[this.completionIndex % matches.length].name} `;
          this.cursor = this.text.length;
          this.completionIndex += 1;
        }
        return "handled";
      }
      case "backspace":
        if (key.meta) {
          const start = this.wordLeft();
          this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
          this.cursor = start;
        } else if (this.cursor > 0) {
          const previous = String.fromCodePoint(this.text.codePointAt(this.cursor - 1) ?? 0).length === 2 ? 2 : 1;
          this.text = this.text.slice(0, this.cursor - previous) + this.text.slice(this.cursor);
          this.cursor -= previous;
        }
        this.completionIndex = 0;
        return "handled";
      case "delete":
        this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
        return "handled";
      case "left":
        this.cursor = key.meta ? this.wordLeft() : Math.max(0, this.cursor - 1);
        return "handled";
      case "right":
        this.cursor = key.meta ? this.wordRight() : Math.min(this.text.length, this.cursor + 1);
        return "handled";
      case "home":
        this.cursor = this.lineBounds().start;
        return "handled";
      case "end":
        this.cursor = this.lineBounds().end;
        return "handled";
      case "up":
      case "down":
        return this.moveVertical(key.name === "up" ? -1 : 1);
    }
    if (key.ctrl) {
      switch (key.name) {
        case "a":
          this.cursor = this.lineBounds().start;
          return "handled";
        case "e":
          this.cursor = this.lineBounds().end;
          return "handled";
        case "u": {
          const { start } = this.lineBounds();
          this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
          this.cursor = start;
          return "handled";
        }
        case "k": {
          const { end } = this.lineBounds();
          this.text = this.text.slice(0, this.cursor) + this.text.slice(end);
          return "handled";
        }
        case "w": {
          const start = this.wordLeft();
          this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
          this.cursor = start;
          return "handled";
        }
        case "p":
          return this.moveVertical(-1);
        case "n":
          return this.moveVertical(1);
      }
    }
    return "ignored";
  }

  // Up and down move between lines, and through history from the first or last line.
  private moveVertical(direction: -1 | 1): "handled" {
    const { start, end } = this.lineBounds();
    const onFirst = start === 0;
    const onLast = end === this.text.length;
    if ((direction === -1 && !onFirst) || (direction === 1 && !onLast)) {
      const column = this.cursor - start;
      if (direction === -1) {
        const previousStart = this.text.lastIndexOf("\n", start - 2) + 1;
        this.cursor = Math.min(previousStart + column, start - 1);
      } else {
        const nextEnd = this.text.indexOf("\n", end + 1);
        this.cursor = Math.min(end + 1 + column, nextEnd === -1 ? this.text.length : nextEnd);
      }
      return "handled";
    }
    if (this.history.length === 0) return "handled";
    if (direction === -1) {
      if (this.historyIndex === -1) {
        this.draft = this.text;
        this.historyIndex = this.history.length;
      }
      this.historyIndex = Math.max(0, this.historyIndex - 1);
      this.text = this.history[this.historyIndex];
    } else {
      if (this.historyIndex === -1) return "handled";
      this.historyIndex += 1;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = -1;
        this.text = this.draft;
      } else this.text = this.history[this.historyIndex];
    }
    this.cursor = this.text.length;
    return "handled";
  }

  // The input as live lines, with the cursor position.
  frame(hint?: string): LiveFrame {
    const max = columns() - 1;
    const prompt = style.accent(PROMPT);
    if (!this.text) {
      const lines = [`${prompt}${style.faint(this.placeholder)}`];
      if (hint) lines.push(hint);
      return { lines, cursor: { row: 0, col: width(PROMPT) } };
    }
    const lines: string[] = [];
    let cursorRow = 0;
    let cursorCol = width(PROMPT);
    const logical = this.text.split("\n");
    // A long paste shows folded until the cursor moves into it.
    const folded = logical.length > PASTE_FOLD_LINES && this.cursor === this.text.length;
    let offset = 0;
    const visible = folded ? [...logical.slice(0, 3), `… ${logical.length - 6} more lines`, ...logical.slice(-3)] : logical;
    visible.forEach((line, index) => {
      const lead = index === 0 ? prompt : CONTINUATION;
      const leadWidth = width(PROMPT);
      const room = Math.max(10, max - leadWidth);
      const pieces: string[] = [];
      let rest = line;
      do {
        let take = 0;
        let used = 0;
        while (take < rest.length && used + width(rest[take]) <= room) {
          used += width(rest[take]);
          take += 1;
        }
        pieces.push(rest.slice(0, take));
        rest = rest.slice(take);
      } while (rest.length);
      const isFoldMarker = folded && index === 3;
      const lineStart = offset;
      pieces.forEach((piece, pieceIndex) => {
        lines.push((pieceIndex === 0 ? lead : CONTINUATION) + (isFoldMarker ? style.faint(piece) : piece));
      });
      if (!folded) {
        const lineEnd = lineStart + line.length;
        if (this.cursor >= lineStart && this.cursor <= lineEnd) {
          let column = this.cursor - lineStart;
          let pieceIndex = 0;
          while (pieceIndex < pieces.length - 1 && column > pieces[pieceIndex].length) {
            column -= pieces[pieceIndex].length;
            pieceIndex += 1;
          }
          cursorRow = lines.length - pieces.length + pieceIndex;
          cursorCol = leadWidth + width(pieces[pieceIndex].slice(0, column));
        }
        offset = lineEnd + 1;
      }
    });
    if (folded) {
      cursorRow = lines.length - 1;
      cursorCol = width(PROMPT) + width(logical.at(-1) ?? "");
    }
    const matches = this.matches();
    if (matches.length) {
      for (const [index, command] of matches.slice(0, 8).entries()) {
        const active = index === this.completionIndex % matches.length;
        lines.push(`  ${active ? style.accent(`/${command.name}`) : style.muted(`/${command.name}`)}  ${style.faint(command.description)}`);
      }
    } else if (hint) lines.push(hint);
    return { lines, cursor: { row: cursorRow, col: cursorCol } };
  }
}

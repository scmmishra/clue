import type { UndoResult } from "../agent/undo";
import type { RewindPoint } from "../session";
import { display } from "../tools/files";
import { columns, rows as terminalRows, style, truncate } from "./ansi";
import { MAX_ROWS } from "./file-mention";
import { ago } from "./picker";
import type { Key } from "./screen";

export type RewindRow = { point: RewindPoint; files: number; ranShell: boolean; restorable: boolean };
export type RewindChoice = { point: RewindPoint; keepFiles: boolean; force: boolean };

const PROMPT_WIDTH = 36;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function details({ files, ranShell, restorable }: RewindRow) {
  if (!restorable) return "conversation only";
  return [files ? plural(files, "file") : "", ranShell ? "shell" : ""].filter(Boolean).join(" · ");
}

// The list `esc esc` opens under the input, newest prompt first.
export class RewindPicker {
  private index = 0;
  private changed: string[] | null = null;

  constructor(private rows: RewindRow[]) {}

  // Every prompt from the selected one to the newest is dropped.
  get turnsDropped() {
    return this.index + 1;
  }

  conflict(paths: string[]) {
    this.changed = paths;
  }

  handle(key: Key): RewindChoice | "cancel" | null {
    const { point } = this.rows[this.index];
    if (key.name === "escape") return "cancel";
    if (key.name === "enter") return { point, keepFiles: false, force: this.changed !== null };
    if (key.name === "tab" && !key.shift) return { point, keepFiles: true, force: false };
    const move = key.name === "up" ? -1 : key.name === "down" ? 1 : 0;
    if (move) {
      this.index = (this.index + move + this.rows.length) % this.rows.length;
      this.changed = null;
    }
    return null;
  }

  frame() {
    const max = columns() - 1;
    const room = Math.max(3, Math.min(MAX_ROWS, terminalRows() - 8));
    const top = Math.max(0, this.index - room + 1);
    const lines = [`  ${style.muted("Rewind to before:")}`];
    this.rows.slice(top, top + room).forEach((row, offset) => {
      const prompt = truncate(row.point.text.replace(/\s+/g, " ").trim(), PROMPT_WIDTH).padEnd(PROMPT_WIDTH);
      const when = row.point.at ? ago(row.point.at).padEnd(9) : " ".repeat(9);
      const text = truncate(`${prompt} ${when} ${details(row)}`.trimEnd(), max - 2);
      lines.push(offset + top === this.index ? style.brand(`› ${style.accent(text)}`) : style.muted(`  ${text}`));
    });
    lines.push("");
    if (this.changed) {
      lines.push(`  ${style.orange(truncate(`Changed since: ${this.changed.join(", ")}`, max - 2))}`);
      lines.push(`  ${style.faint("enter overwrite · tab keep files · esc cancel")}`);
    } else lines.push(`  ${style.faint("enter rewind · tab keep files · esc cancel")}`);
    return lines;
  }
}

// What goes into the scrollback, which can't be edited, so the old output stays above the marker.
export function rewindReport(turns: number, files: UndoResult | null, cwd: string) {
  const done = files?.kind === "done" ? files : null;
  const count = (done?.restored.length ?? 0) + (done?.deleted.length ?? 0);
  const parts = [`rewound ${plural(turns, "turn")}`, ...(count ? [`restored ${plural(count, "file")}`] : [])];
  return [
    `  ${style.muted(`── ${parts.join(" · ")} · earlier output above no longer applies ──`)}`,
    ...(done?.failed ?? []).map((path) => `  ${style.red(`Could not restore ${display(cwd, path)}`)}`),
    ...(done?.ranShell ? [`  ${style.faint("Shell commands from those turns weren't undone.")}`] : []),
    "",
  ];
}

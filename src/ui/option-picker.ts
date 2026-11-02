import { style } from "./ansi";
import type { Key } from "./screen";

// `levels` are the dial's levels this row allows, such as the efforts a model takes.
export type Option = { value: string; label: string; detail?: string; levels?: readonly string[] };

// One setting under the list that ← and → move, for the highlighted row, such as effort.
export type Dial = { name: string; level: string };

// A short list under the input, for a command with no argument, such as /model.
export class OptionPicker {
  private index: number;

  constructor(
    private title: string,
    private options: Option[],
    current: string,
    private dial?: Dial,
  ) {
    this.index = Math.max(
      0,
      options.findIndex((option) => option.value === current),
    );
  }

  // Every level any row allows, in order. Rows allow the same levels or fewer from the top.
  private allLevels() {
    return this.options.reduce<readonly string[]>(
      (longest, option) => ((option.levels?.length ?? 0) > longest.length ? option.levels! : longest),
      [],
    );
  }

  // The dial's setting, or the highlighted row's lowest level when the row doesn't allow it.
  get chosenLevel() {
    const levels = this.options[this.index].levels ?? [];
    const level = this.dial?.level ?? "";
    return levels.includes(level) ? level : (levels[0] ?? "");
  }

  // The chosen value, "" to cancel, or null to keep the list open.
  handle(key: Key): string | null {
    if (key.name === "escape") return "";
    if (key.name === "enter") return this.options[this.index].value;
    if ((key.name === "left" || key.name === "right") && this.dial) {
      const levels = this.options[this.index].levels ?? [];
      const next = levels[levels.indexOf(this.chosenLevel) + (key.name === "right" ? 1 : -1)];
      if (next) this.dial.level = next;
      return null;
    }
    const move = key.name === "up" ? -1 : key.name === "down" ? 1 : 0;
    this.index = (this.index + move + this.options.length) % this.options.length;
    return null;
  }

  // "Effort    low   [ medium ]   high". Each level keeps its place as the marks move.
  private dialLine(dial: Dial) {
    const allowed = this.options[this.index].levels ?? [];
    const chosen = this.chosenLevel;
    const levels = this.allLevels().map((level) => {
      if (level === chosen) return style.accent(`[ ${level} ]`);
      const text = `  ${level}  `;
      return allowed.includes(level) ? style.muted(text) : style.faint(text);
    });
    return `  ${style.muted(dial.name.padEnd(8))}${levels.join(" ")}`;
  }

  frame() {
    const size = Math.max(...this.options.map((option) => option.label.length)) + 2;
    const rows = this.options.map(({ label, detail }, index) => {
      const row = `${label.padEnd(size)}${detail ?? ""}`.trimEnd();
      return index === this.index ? style.brand(`› ${style.accent(row)}`) : style.muted(`  ${row}`);
    });
    const dial = this.dial ? ["", this.dialLine(this.dial)] : [];
    const keys = this.dial
      ? `←→ ${this.dial.name.toLowerCase()} · enter select · esc cancel`
      : "enter select · esc cancel";
    return [`  ${style.muted(this.title)}`, ...rows, ...dial, "", `  ${style.faint(keys)}`];
  }
}

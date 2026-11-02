import { style } from "./ansi";
import type { Key } from "./screen";

// `levels` gives the row a dial that ← and → move, such as a model's effort.
export type Option = { value: string; label: string; detail?: string; levels?: readonly string[] };

// A short list under the input, for a command with no argument, such as /model.
export class OptionPicker {
  private index: number;

  constructor(
    private title: string,
    private options: Option[],
    current: string,
    // The dial's setting. A row without it shows its own lowest level.
    private level = "",
  ) {
    this.index = Math.max(
      0,
      options.findIndex((option) => option.value === current),
    );
  }

  private hasDial() {
    return this.options.some((option) => option.levels?.length);
  }

  // The level the row shows: the dial's setting, or the row's lowest level when it lacks that one.
  private levelOf(option: Option) {
    const levels = option.levels ?? [];
    return levels.includes(this.level) ? this.level : (levels[0] ?? "");
  }

  // The level of the highlighted row, for the caller to apply with its value.
  get chosenLevel() {
    return this.levelOf(this.options[this.index]);
  }

  // The chosen value, "" to cancel, or null to keep the list open.
  handle(key: Key): string | null {
    if (key.name === "escape") return "";
    if (key.name === "enter") return this.options[this.index].value;
    if (key.name === "left" || key.name === "right") {
      const levels = this.options[this.index].levels ?? [];
      const at = levels.indexOf(this.chosenLevel);
      const next = levels[at + (key.name === "right" ? 1 : -1)];
      if (next) this.level = next;
      return null;
    }
    const move = key.name === "up" ? -1 : key.name === "down" ? 1 : 0;
    this.index = (this.index + move + this.options.length) % this.options.length;
    return null;
  }

  frame() {
    const size = Math.max(...this.options.map((option) => option.label.length)) + 2;
    const dialSize = Math.max(0, ...this.options.map((option) => option.levels?.length ?? 0));
    const levelSize = Math.max(
      0,
      ...this.options.flatMap((option) => option.levels ?? []).map((level) => level.length),
    );
    const rows = this.options.map((option, index) => {
      const levels = option.levels ?? [];
      const at = levels.indexOf(this.levelOf(option));
      const dial = dialSize
        ? `${levels
            .map((_, position) => (position <= at ? "●" : "○"))
            .join("")
            .padEnd(dialSize)}  ${this.levelOf(option).padEnd(levelSize)}  `
        : "";
      const row = `${option.label.padEnd(size)}${dial}${option.detail ?? ""}`.trimEnd();
      return index === this.index ? style.brand(`› ${style.accent(row)}`) : style.muted(`  ${row}`);
    });
    const keys = this.hasDial() ? "←→ effort · enter select · esc cancel" : "enter select · esc cancel";
    return [`  ${style.muted(this.title)}`, ...rows, "", `  ${style.faint(keys)}`];
  }
}

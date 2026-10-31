import { style } from "./ansi";
import type { Key } from "./screen";

export type Option = { value: string; label: string; detail?: string };

// A short list under the input, for a command with no argument, such as /model.
export class OptionPicker {
  private index: number;

  constructor(
    private title: string,
    private options: Option[],
    current: string,
  ) {
    this.index = Math.max(
      0,
      options.findIndex((option) => option.value === current),
    );
  }

  // The chosen value, "" to cancel, or null to keep the list open.
  handle(key: Key): string | null {
    if (key.name === "escape") return "";
    if (key.name === "enter") return this.options[this.index].value;
    const move = key.name === "up" ? -1 : key.name === "down" ? 1 : 0;
    this.index = (this.index + move + this.options.length) % this.options.length;
    return null;
  }

  frame() {
    const size = Math.max(...this.options.map((option) => option.label.length)) + 2;
    const rows = this.options.map(({ label, detail }, index) => {
      const row = `${label.padEnd(size)}${detail ?? ""}`.trimEnd();
      return index === this.index ? style.brand(`› ${style.accent(row)}`) : style.muted(`  ${row}`);
    });
    return [`  ${style.muted(this.title)}`, ...rows, "", `  ${style.faint("enter select · esc cancel")}`];
  }
}

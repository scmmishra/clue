import { expect, test } from "bun:test";
import { OptionPicker } from "../src/ui/option-picker";

const options = [
  { value: "a", label: "first", detail: "one" },
  { value: "b", label: "second" },
  { value: "c", label: "third" },
];
const shown = (picker: OptionPicker) => picker.frame().map((line) => Bun.stripANSI(line));

test("the list starts on the current value", () => {
  const picker = new OptionPicker("Pick", options, "b");
  expect(shown(picker).slice(0, 4)).toEqual(["  Pick", "  first   one", "› second", "  third"]);
  expect(picker.handle({ name: "enter" })).toBe("b");
});

test("an unknown current value starts at the top", () => {
  expect(new OptionPicker("Pick", options, "custom").handle({ name: "enter" })).toBe("a");
});

test("arrows move and wrap", () => {
  const picker = new OptionPicker("Pick", options, "a");
  expect(picker.handle({ name: "up" })).toBeNull();
  expect(picker.handle({ name: "enter" })).toBe("c");
  picker.handle({ name: "down" });
  expect(picker.handle({ name: "enter" })).toBe("a");
});

test("escape cancels, and other keys do nothing", () => {
  const picker = new OptionPicker("Pick", options, "b");
  expect(picker.handle({ name: "escape" })).toBe("");
  expect(picker.handle({ name: "char", text: "x" })).toBeNull();
  expect(picker.handle({ name: "enter" })).toBe("b");
});

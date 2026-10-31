import { expect, test } from "bun:test";
import { term } from "../src/ui/ansi";
import { Screen, type LiveFrame } from "../src/ui/screen";

function capture(rows?: number) {
  const out = { text: "", rows, write: (chunk: string) => ((out.text += chunk), true) };
  return { out, screen: new Screen(out as unknown as NodeJS.WriteStream) };
}

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `row ${index}`);
const drawn = (text: string) => Bun.stripANSI(text).replace(/\r/g, "").split("\n");

function draw(rows: number | undefined, frame: LiveFrame) {
  const { out, screen } = capture(rows);
  screen.setRenderer(() => frame);
  screen.flush();
  return { out, screen };
}

test("a frame that fits is drawn whole", () => {
  expect(drawn(draw(10, { lines: numbered(9) }).out.text)).toEqual(numbered(9));
});

test("a frame taller than the terminal keeps its last rows, and leaves one row free", () => {
  expect(drawn(draw(5, { lines: numbered(20) }).out.text)).toEqual(["row 16", "row 17", "row 18", "row 19"]);
});

test("the input keeps the status line and its cursor row in view", () => {
  const { out } = draw(5, { lines: numbered(8), cursor: { row: 5, col: 2 } });
  expect(drawn(out.text)).toEqual(["row 4", "row 5", "row 6", "row 7"]);
  expect(out.text).toContain(term.up(2));
});

test("a cursor near the top of a tall frame stays in view", () => {
  const { out } = draw(5, { lines: numbered(8), cursor: { row: 1, col: 2 } });
  expect(drawn(out.text)).toEqual(["row 1", "row 2", "row 3", "row 4"]);
  expect(out.text).toContain(term.up(3));
});

test("the next redraw erases only the rows that were drawn", () => {
  const { out, screen } = draw(5, { lines: numbered(8), cursor: { row: 5, col: 2 } });
  out.text = "";
  screen.flush();
  expect(out.text.startsWith(`${term.up(1)}\r${term.clearDown}`)).toBe(true);
});

test("a terminal one row tall still draws the cursor's row", () => {
  expect(drawn(draw(1, { lines: numbered(8), cursor: { row: 5, col: 2 } }).out.text)).toEqual(["row 5"]);
});

test("a terminal with no known height draws the whole frame", () => {
  expect(drawn(draw(undefined, { lines: numbered(30) }).out.text)).toHaveLength(30);
});

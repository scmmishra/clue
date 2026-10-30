import { expect, test } from "bun:test";
import { tokens } from "../src/ui/ansi";
import { footerLine } from "../src/ui/turn";

const usage = { input: 100, output: 52, cacheRead: 3000, cacheWrite: 200, webSearches: 0 };
const footer = (turn: Parameters<typeof footerLine>[0]) => Bun.stripANSI(footerLine(turn));

test("the footer counts cached input as tokens in", () => {
  expect(footer({ ms: 2500, cost: 0.06, stop: "end_turn", usage })).toBe("  2.5s · $0.06 · 3.3k in · 52 out");
});

test("the footer of an interrupted turn keeps its tokens", () => {
  expect(footer({ ms: 2500, cost: 0.06, stop: "interrupted", usage })).toBe("  2.5s · $0.06 · 3.3k in · 52 out · interrupted");
});

test("token counts shorten as they grow", () => {
  expect([0, 999, 1000, 3300, 12_345, 1_500_000].map(tokens)).toEqual(["0", "999", "1.0k", "3.3k", "12k", "1.5M"]);
});

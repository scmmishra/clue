import { expect, test } from "bun:test";
import { contextTokens } from "../src/agent/loop";
import type { TurnRecord } from "../src/session";
import { usageReport } from "../src/ui/usage";

const turn = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  prompt: "hi",
  startedAt: 0,
  ms: 1,
  firstTokenMs: 1,
  tools: 0,
  usage: { input: 1000, output: 500, cacheRead: 7000, cacheWrite: 2000, webSearches: 0 },
  cost: 0.5,
  model: "claude-opus-5-5",
  stop: "end_turn",
  context: 75_000,
  ...overrides,
});
const report = (turns: TurnRecord[]) => usageReport(turns).map((line) => Bun.stripANSI(line));

test("the report shows context against the compaction point", () => {
  const lines = report([turn()]);
  expect(lines[0]).toBe("  Context   75k of 150k before compaction (50%)");
  expect(lines[1]).toBe(`            ${"█".repeat(12)}${"░".repeat(12)}`);
});

test("context comes from the latest turn, and totals add up", () => {
  const lines = report([turn({ context: 10_000 }), turn({ context: 30_000 })]);
  expect(lines[0]).toContain("30k of 150k");
  expect(lines.join("\n")).toContain("$1.00 across 2 prompts");
  expect(lines.join("\n")).toContain("2.0k in · 14k cache read · 4.0k cache write · 1.0k out");
  expect(lines.join("\n")).toContain("70% of input came from the cache");
});

test("the bar stays full past the compaction point", () => {
  expect(report([turn({ context: 400_000 })])[1].trim()).toBe("█".repeat(24));
});

test("a session from an older version has no context yet", () => {
  expect(report([turn({ context: undefined })])[0]).toBe("  Context   Shows after the next reply.");
});

test("an empty session says so", () => {
  expect(report([])[0]).toBe("  Context   No prompts yet.");
});

test("a second model and web searches get their own rows", () => {
  const text = report([turn({ usage: { ...turn().usage, webSearches: 3 } }), turn({ model: "claude-haiku-5-5", cost: 0.25 })]).join("\n");
  expect(text).toContain("3 searches");
  expect(text).toContain("opus 5.5 $0.50 · haiku 5.5 $0.25");
});

test("one model and no searches leave those rows out", () => {
  const text = report([turn()]).join("\n");
  expect(text).not.toContain("Models");
  expect(text).not.toContain("Web");
});

test("a model with no price is called out", () => {
  expect(report([turn({ cost: null })]).join("\n")).toContain("1 with no known price");
});

test("context size is everything sent in the request", () => {
  expect(contextTokens({ input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 5 } as never)).toBe(240);
});

test("after a compaction, context size comes from the last message entry", () => {
  const usage = {
    input_tokens: 999_999,
    output_tokens: 5,
    iterations: [
      { type: "compaction", input_tokens: 180_000, output_tokens: 2000 },
      { type: "message", input_tokens: 4000, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 5 },
    ],
  };
  expect(contextTokens(usage as never)).toBe(5000);
});

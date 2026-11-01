import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cost, fastEnabled } from "../src/agent/models";
import { buildRequest, fastRejected } from "../src/agent/provider";
import { checkSetting } from "../src/config";
import { Session, type TurnRecord } from "../src/session";
import { style } from "../src/ui/ansi";
import { footerLine, statusLine } from "../src/ui/turn";

const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, webSearches: 1 };
const options = { model: "claude-opus-5-5", effort: "medium" as const, messages: [] };

test("fast mode is on only for a model that has it", () => {
  expect(fastEnabled({ model: "claude-opus-5-5", fast: true })).toBe(true);
  expect(fastEnabled({ model: "claude-opus-5", fast: true })).toBe(true);
  expect(fastEnabled({ model: "claude-sonnet-5-5", fast: true })).toBe(false);
  expect(fastEnabled({ model: "a-proxy-model", fast: true })).toBe(false);
  expect(fastEnabled({ model: "claude-opus-5-5", fast: false })).toBe(false);
});

test("a fast request carries the speed and its beta, and a standard one has neither", () => {
  const fast = buildRequest({ ...options, fast: true }) as any;
  expect(fast.speed).toBe("fast");
  expect(fast.betas).toContain("fast-mode-2026-02-01");
  const standard = buildRequest(options) as any;
  expect(standard.speed).toBeUndefined();
  expect(standard.betas).not.toContain("fast-mode-2026-02-01");
});

test("fast mode doubles the token prices, but not web searches", () => {
  expect(cost("claude-opus-5-5", usage)).toBeCloseTo(24.01);
  expect(cost("claude-opus-5-5", usage, true)).toBeCloseTo(48.01);
  expect(cost("claude-opus-5", usage, true)).toBeCloseTo(60.01);
});

test("only an error about fast mode counts as a rejection of it", () => {
  expect(fastRejected(new Error("speed: not available for this organization"))).toBe(true);
  expect(fastRejected(new Error("fast-mode-2026-02-01 is not enabled"))).toBe(true);
  expect(fastRejected(new Error("messages.0: image exceeds the size limit"))).toBe(false);
  expect(fastRejected(new Error("breakfast"))).toBe(false);
});

test("the status line shows fast mode and the session's cost", () => {
  const base = { mode: "auto", model: "claude-opus-5-5", effort: "medium", cwd: "/tmp/app", branch: "main" };
  const line = (fast: boolean, spent: number) => Bun.stripANSI(statusLine({ ...base, fast, spent }));
  expect(line(false, 0)).toStartWith("auto · opus 5.5 · medium ");
  expect(line(true, 0)).toStartWith("auto · opus 5.5 · medium · fast ");
  expect(line(false, 1.5)).toStartWith("auto · opus 5.5 · medium · $1.50 ");
  expect(line(true, 0.001)).toStartWith("auto · opus 5.5 · medium · fast · $0.00 ");
  expect(line(true, 0.007)).toStartWith("auto · opus 5.5 · medium · fast · $0.01 ");
  expect(statusLine({ ...base, fast: true })).toContain(style.orange("fast"));
});

test("the footer marks a reply that came in fast mode", () => {
  const turn = { ms: 2500, cost: 0.06, stop: "end_turn", usage };
  expect(Bun.stripANSI(footerLine(turn))).not.toContain("fast");
  expect(Bun.stripANSI(footerLine({ ...turn, fast: true }))).toEndWith("out · fast");
});

test("the session's total counts turns, rewound turns and compactions", () => {
  const session = Session.create(realpathSync(mkdtempSync(join(tmpdir(), "clue-spent-"))));
  expect(session.spent).toBe(0);
  session.turns.push({ cost: 0.25 } as TurnRecord, { cost: null } as TurnRecord);
  session.rewound.push({ cost: 0.5 } as TurnRecord);
  session.compactions.push({ cost: 0.125 } as never);
  expect(session.spent).toBe(0.875);
});

test("fast is a true or false setting", () => {
  expect(checkSetting("fast", true)).toBeNull();
  expect(checkSetting("fast", "yes")).toBe("fast must be true or false");
});

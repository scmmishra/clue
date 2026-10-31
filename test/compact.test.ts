import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequest } from "../src/agent/provider";
import { Session, startsWithSummary, type CompactionRecord, type MessageParam } from "../src/session";
import { usageReport } from "../src/ui/usage";

const summary: MessageParam = {
  role: "assistant",
  content: [{ type: "compaction", content: "Summary.", signature: "sig" } as never],
};
const options = (messages: MessageParam[], summarize = false) => ({
  model: "claude-opus-5-5",
  effort: "medium" as const,
  messages,
  summarize,
});
const record = (at = 5000): CompactionRecord => ({
  message: summary,
  usage: { input: 5000, output: 700, cacheRead: 0, cacheWrite: 0, webSearches: 0 },
  cost: 0.25,
  model: "claude-opus-5-5",
  at,
});
const session = () => Session.create(realpathSync(mkdtempSync(join(tmpdir(), "clue-compact-"))));

test("an ordinary request uses automatic compaction", () => {
  const request = buildRequest(options([{ role: "user", content: "hi" }])) as any;
  expect(request.context_management.edits[0].type).toBe("compact_20260112");
  expect(request.betas).toContain("compact-2026-01-12");
  expect(request.compaction).toBeUndefined();
});

test("a summary request has no automatic compaction, which the API rejects alongside it", () => {
  const request = buildRequest(options([{ role: "user", content: "hi" }], true)) as any;
  expect(request.compaction).toEqual({ type: "summarize" });
  expect(request.context_management).toBeUndefined();
  expect(request.betas).toContain("compact-2026-09-04");
  expect(request.fallbacks).toBeUndefined();
});

test("a request that carries a summary needs the beta and drops automatic compaction", () => {
  const request = buildRequest(options([summary, { role: "user", content: "next" }])) as any;
  expect(request.betas).toContain("compact-2026-09-04");
  expect(request.betas).not.toContain("compact-2026-01-12");
  expect(request.context_management).toBeUndefined();
});

test("only a block at the start counts as a summary", () => {
  expect(startsWithSummary([summary])).toBe(true);
  expect(startsWithSummary([{ role: "user", content: "hi" }, summary])).toBe(false);
  expect(startsWithSummary([])).toBe(false);
});

test("a compaction replaces what is sent, and the transcript keeps everything", () => {
  const current = session();
  current.appendMessage({ role: "user", content: "first" });
  current.append({ t: "compacted", ...record() });
  current.appendMessage({ role: "user", content: "second" });
  expect(current.messages).toEqual([summary, { role: "user", content: "second" }]);
  expect(current.transcript.map((message) => message.content)).toEqual(["first", "second"]);
});

test("a saved session loads with its summary", () => {
  const current = session();
  current.appendMessage({ role: "user", content: "first" });
  current.append({ t: "compacted", ...record() });
  current.appendMessage({ role: "user", content: "second" });
  const loaded = Session.load(current.file)!;
  expect(loaded.messages).toEqual(current.messages);
  expect(loaded.transcript).toHaveLength(2);
  expect(loaded.compactions).toHaveLength(1);
});

test("the next prompt brings the opening context again, once", () => {
  const current = session();
  expect(current.needsContext).toBe(true);
  current.appendMessage({ role: "user", content: "first" });
  expect(current.needsContext).toBe(false);
  current.append({ t: "compacted", ...record() });
  expect(current.needsContext).toBe(true);
  current.appendMessage({ role: "user", content: "second" });
  expect(current.needsContext).toBe(false);
});

const turn = {
  prompt: "hi",
  startedAt: 1000,
  ms: 1000,
  firstTokenMs: 1,
  tools: 0,
  usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, webSearches: 0 },
  cost: 0.5,
  model: "claude-opus-5-5",
  stop: "end_turn",
  context: 90_000,
};

test("/usage counts a compaction's cost, and has no context size until the next reply", () => {
  const text = usageReport([turn], [record()])
    .map((line) => Bun.stripANSI(line))
    .join("\n");
  expect(text).toContain("$0.75 across 1 prompt");
  expect(text).toContain("6.0k in");
  expect(text).toContain("Shows after the next reply.");
});

test("/usage shows context again after the next reply", () => {
  const text = usageReport([{ ...turn, startedAt: 9000 }], [record()])
    .map((line) => Bun.stripANSI(line))
    .join("\n");
  expect(text).toContain("90k of 150k");
});

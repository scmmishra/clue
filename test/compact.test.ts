import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keptCount, KEEP_RECENT_TOKENS } from "../src/agent/compaction";
import { compactAt, cost, DEFAULT_COMPACT_AT } from "../src/agent/models";
import { COMPACT_PROMPT } from "../src/agent/prompt";
import { buildRequest, withSummaryRequest } from "../src/agent/provider";
import { Session, summaryText, type CompactionRecord, type MessageParam } from "../src/session";
import { usageReport } from "../src/ui/usage";

const options = (messages: MessageParam[]) => ({ model: "claude-opus-5-5", effort: "medium" as const, messages });
const record = (kept = 0, at = 5000): CompactionRecord => ({
  summary: summaryText("Summary."),
  kept,
  usage: { input: 5000, output: 700, cacheRead: 0, cacheWrite: 0, webSearches: 0 },
  cost: 0.25,
  model: "claude-opus-5-5",
  at,
});
const session = () => Session.create(realpathSync(mkdtempSync(join(tmpdir(), "clue-compact-"))));
const summaryMessage = (summary = "Summary."): MessageParam => ({
  role: "user",
  content: [{ type: "text", text: summaryText(summary) }],
});

const thinking = { type: "thinking" as const, thinking: "Hmm.", signature: "sig" };
const call = (id: string): MessageParam => ({
  role: "assistant",
  content: [thinking, { type: "tool_use", id, name: "read_file", input: { path: "a.ts" } }],
});
const result = (id: string, text = "contents"): MessageParam => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: text }],
});
// Text of about this many tokens.
const tokens = (count: number) => "x".repeat(count * 4);

test("requests leave compaction to clue", () => {
  const request = buildRequest(options([{ role: "user", content: "hi" }])) as any;
  expect(request.context_management).toBeUndefined();
  expect(request.compaction).toBeUndefined();
  expect(request.betas.filter((beta: string) => beta.startsWith("compact"))).toEqual([]);
  expect(request.fallbacks).toBe("default");
});

test("clue compacts at 80% of the window left after the longest reply", () => {
  expect(compactAt("claude-opus-5-5")).toBe(748_800);
  expect(compactAt("claude-sonnet-5-5")).toBe(748_800);
  // A pair compacts where its executor does.
  expect(compactAt("claude-sonnet-5-5+opus-5-5")).toBe(748_800);
  expect(compactAt("claude-unknown-9")).toBe(DEFAULT_COMPACT_AT);
});

test("Sonnet 5.5 cache reads cost $0.10 per million tokens", () => {
  const usage = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0, webSearches: 0 };
  expect(cost("claude-sonnet-5-5", usage)).toBeCloseTo(0.1);
});

test("a compaction keeps the latest messages after its summary, without their thinking", () => {
  const current = session();
  current.appendMessage({ role: "user", content: "first" });
  current.appendMessage({ role: "assistant", content: [thinking, { type: "text", text: "one" }] });
  current.appendMessage({ role: "user", content: "second" });
  current.appendMessage(call("t1"));
  current.appendMessage(result("t1"));
  current.appendMessage({ role: "assistant", content: [thinking] });
  current.append({ t: "compacted", ...record(4) });
  expect(current.messages).toEqual([
    summaryMessage(),
    { role: "user", content: "second" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } }] },
    result("t1"),
    { role: "assistant", content: [{ type: "text", text: "(thinking omitted)" }] },
  ]);
  // The transcript keeps every message as it was.
  expect(current.transcript).toHaveLength(6);
  expect(current.transcript[1]).toEqual({ role: "assistant", content: [thinking, { type: "text", text: "one" }] });
  // The prompts still sent can be rewound to. The summarized ones can't.
  expect(current.rewindPoints.map((point) => point.text)).toEqual(["second"]);
});

test("a saved session loads with the same messages it sends", () => {
  const current = session();
  current.appendMessage({ role: "user", content: "first" });
  current.appendMessage({ role: "assistant", content: [thinking, { type: "text", text: "one" }] });
  current.append({ t: "compacted", ...record(1) });
  current.appendMessage({ role: "user", content: "second" });
  current.appendMessage({ role: "assistant", content: [thinking, { type: "text", text: "two" }] });
  const loaded = Session.load(current.file)!;
  expect(loaded.messages).toEqual(current.messages);
  // Thinking written after the summary stays, since the messages before it are sent unchanged.
  expect(loaded.messages.at(-1)).toEqual({ role: "assistant", content: [thinking, { type: "text", text: "two" }] });
  expect(loaded.transcript).toHaveLength(4);
  expect(loaded.compactions).toHaveLength(1);
});

test("a later compaction folds the earlier summary into its own", () => {
  const current = session();
  current.appendMessage({ role: "user", content: "first" });
  current.append({ t: "compacted", ...record(0) });
  current.appendMessage({ role: "user", content: "second" });
  current.append({ t: "compacted", ...record(1) });
  expect(current.messages).toEqual([summaryMessage(), { role: "user", content: "second" }]);
});

test("a session the API compacted resumes from its summary, without thinking", () => {
  const current = session();
  current.appendMessage({ role: "user", content: "first" });
  current.append({
    t: "compacted",
    message: {
      role: "assistant",
      content: [{ type: "compaction", content: "Old summary.", signature: "sig" } as never],
    },
    usage: { input: 5000, output: 700, cacheRead: 0, cacheWrite: 0, webSearches: 0 },
    cost: 0.25,
    model: "claude-opus-5-5",
    at: 5000,
  });
  current.appendMessage({ role: "user", content: "second" });
  current.appendMessage({ role: "assistant", content: [thinking, { type: "text", text: "two" }] });
  const loaded = Session.load(current.file)!;
  expect(loaded.messages).toEqual([
    summaryMessage("Old summary."),
    { role: "user", content: "second" },
    { role: "assistant", content: [{ type: "text", text: "two" }] },
  ]);
  expect(loaded.summarized).toBe(true);
});

test("a reply the API compacted during a turn goes on after its summary", () => {
  const current = session();
  current.appendMessage({ role: "user", content: "first" });
  current.appendMessage(call("t1"));
  current.appendMessage(result("t1"));
  current.appendMessage({
    role: "assistant",
    content: [
      { type: "compaction", content: "Mid-turn summary.", signature: "sig" } as never,
      thinking,
      { type: "text", text: "Going on." },
    ],
  });
  const loaded = Session.load(current.file)!;
  expect(loaded.messages).toEqual([
    summaryMessage("Mid-turn summary."),
    { role: "assistant", content: [{ type: "text", text: "Going on." }] },
  ]);
  expect(loaded.transcript).toHaveLength(4);
  expect(loaded.needsContext).toBe(true);
});

test("the next prompt brings the opening context again, unless a kept message holds it", () => {
  const current = session();
  expect(current.needsContext).toBe(true);
  const opening: MessageParam = {
    role: "user",
    content: [
      { type: "text", text: "<context>\nhere\n</context>" },
      { type: "text", text: "first" },
    ],
  };
  current.appendMessage(opening);
  expect(current.needsContext).toBe(false);
  current.append({ t: "compacted", ...record(1) });
  expect(current.needsContext).toBe(false);
  current.append({ t: "compacted", ...record(0) });
  expect(current.needsContext).toBe(true);
  current.appendMessage(opening);
  expect(current.needsContext).toBe(false);
});

test("a compaction keeps nothing when the whole conversation is smaller than what it keeps", () => {
  expect(
    keptCount([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]),
  ).toBe(0);
  // Thinking is dropped from what is kept, so it counts for nothing.
  const thoughtful: MessageParam = { role: "assistant", content: [{ ...thinking, thinking: tokens(50_000) }] };
  expect(keptCount([{ role: "user", content: "hi" }, thoughtful])).toBe(0);
});

test("a compaction keeps about 20k tokens, from where a prompt starts", () => {
  const messages: MessageParam[] = [
    { role: "user", content: tokens(10_000) },
    { role: "assistant", content: tokens(10_000) },
    { role: "user", content: tokens(10_000) },
    { role: "assistant", content: tokens(10_000) },
  ];
  expect(KEEP_RECENT_TOKENS).toBe(20_000);
  expect(keptCount(messages)).toBe(2);
});

test("a compaction can keep a reply without the prompt before it", () => {
  const messages: MessageParam[] = [
    { role: "user", content: tokens(30_000) },
    call("t1"),
    result("t1"),
    { role: "assistant", content: "done" },
  ];
  expect(keptCount(messages)).toBe(3);
});

test("a compaction never keeps tool results without their call", () => {
  const messages: MessageParam[] = [
    { role: "user", content: "read it" },
    call("t1"),
    result("t1", tokens(30_000)),
    { role: "assistant", content: "done" },
  ];
  // The results alone are over the budget, so the kept part starts after them.
  expect(keptCount(messages)).toBe(1);
  // With nothing after them, nothing can be kept.
  expect(keptCount(messages.slice(0, 3))).toBe(0);
});

test("a reply right after another can't start what is kept", () => {
  const messages: MessageParam[] = [
    { role: "user", content: "search" },
    { role: "assistant", content: tokens(5_000) },
    { role: "assistant", content: tokens(30_000) },
  ];
  // The second reply goes on from the first, which paused for a server tool.
  expect(keptCount(messages)).toBe(0);
});

test("the summary request goes at the end of the conversation, which stays as it was", () => {
  const conversation: MessageParam[] = [{ role: "user", content: "hi" }, call("t1")];
  expect(withSummaryRequest(conversation, COMPACT_PROMPT)).toEqual([
    ...conversation,
    { role: "user", content: [{ type: "text", text: COMPACT_PROMPT }] },
  ]);
  const midTurn = [...conversation, result("t1")];
  const request = withSummaryRequest(midTurn, COMPACT_PROMPT);
  expect(request.at(-1)).toEqual({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "contents" },
      { type: "text", text: COMPACT_PROMPT },
    ],
  });
  expect(midTurn.at(-1)).toEqual(result("t1"));
  expect(withSummaryRequest([{ role: "user", content: "hi" }], "Sum up.")).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "text", text: "Sum up." },
      ],
    },
  ]);
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

test("/usage measures context against the model's compaction point", () => {
  const text = usageReport([{ ...turn, startedAt: 9000 }], [record()], [], [], compactAt("claude-opus-5-5"))
    .map((line) => Bun.stripANSI(line))
    .join("\n");
  expect(text).toContain("90k of 749k");
});

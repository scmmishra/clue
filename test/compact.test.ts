import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepFrom } from "../src/agent/compaction";
import { compactAt, MIN_COMPACT_AT } from "../src/agent/models";
import { COMPACT_INSTRUCTIONS } from "../src/agent/prompt";
import { buildRequest } from "../src/agent/provider";
import { checkSetting } from "../src/config";
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

test("an ordinary request leaves compaction to clue", () => {
  const request = buildRequest(options([{ role: "user", content: "hi" }])) as any;
  expect(request.context_management).toBeUndefined();
  expect(request.compaction).toBeUndefined();
  expect(request.betas ?? []).not.toContain("compact-2026-09-04");
});

test("a summary request asks for clue's summary instead of the API's default one", () => {
  const request = buildRequest(options([{ role: "user", content: "hi" }], true)) as any;
  expect(request.compaction).toEqual({ type: "summarize", instructions: COMPACT_INSTRUCTIONS });
  expect(COMPACT_INSTRUCTIONS.length).toBeGreaterThan(0);
  expect(COMPACT_INSTRUCTIONS.length).toBeLessThanOrEqual(16_384);
  expect(request.context_management).toBeUndefined();
  expect(request.betas).toContain("compact-2026-09-04");
  expect(request.fallbacks).toBeUndefined();
});

test("a request that carries a summary needs the beta", () => {
  const request = buildRequest(options([summary, { role: "user", content: "next" }])) as any;
  expect(request.betas).toContain("compact-2026-09-04");
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

test("a session the API compacted on its own resumes from the API's summary, as plain text", () => {
  const current = session();
  const reply: MessageParam = {
    role: "assistant",
    content: [
      { type: "compaction", content: "Summary." } as never,
      { type: "thinking", thinking: "Hmm.", signature: "s1" },
      { type: "text", text: "Reading it." },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
    ],
  };
  const result: MessageParam = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }],
  };
  const next: MessageParam = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Done.", signature: "s2" },
      { type: "text", text: "Done." },
    ],
  };
  current.appendMessage({ role: "user", content: "first" });
  current.appendMessage({ role: "assistant", content: "hello" });
  current.appendMessage({ role: "user", content: "second" });
  current.appendMessage(reply);
  current.appendMessage(result);
  current.appendMessage(next);
  const loaded = Session.load(current.file)!;
  expect(loaded.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "The earlier conversation was compacted. Its summary:\n\nSummary." }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Reading it." },
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
      ],
    },
    result,
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ]);
  expect(loaded.transcript).toHaveLength(6);
  // No compaction block is left, so the request needs no compaction beta.
  expect(buildRequest(options(loaded.messages)).betas ?? []).not.toContain("compact-2026-09-04");
  expect(loaded.carriesSummary).toBe(true);
  expect(loaded.needsContext).toBe(true);
  expect(loaded.rewindPoints).toEqual([]);
  // clue's own compaction replaces it as usual.
  loaded.append({ t: "compacted", ...record() });
  expect(loaded.messages).toEqual([summary]);
});

test("the next prompt brings the opening context again, once", () => {
  const current = session();
  expect(current.needsContext).toBe(true);
  current.appendMessage({ role: "user", content: "first" });
  expect(current.needsContext).toBe(false);
  current.append({ t: "compacted", ...record() });
  expect(current.needsContext).toBe(true);
  current.appendMessage({ role: "user", content: "Continue with the task." });
  expect(current.needsContext).toBe(true);
  current.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "<context>\nfolder" },
      { type: "text", text: "second" },
    ],
  });
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

test("/usage measures context against the current model's compaction point", () => {
  const text = usageReport([{ ...turn, startedAt: 9000 }], [record()], [], [], 300_000)
    .map((line) => Bun.stripANSI(line))
    .join("\n");
  expect(text).toContain("90k of 300k");
});

// Messages in the shape of a session: prompts, replies, tool calls and their results.
const prompt = (text: string): MessageParam => ({ role: "user", content: text });
const reply = (text: string): MessageParam => ({ role: "assistant", content: [{ type: "text", text }] });
const toolCall = (id: string): MessageParam => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "read_file", input: { path: "a.ts" } }],
});
const toolResult = (id: string, text = "ok"): MessageParam => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: text }],
});
const big = (tokens: number) => "x".repeat(tokens * 4);

test("compaction keeps the latest messages that fit", () => {
  const messages = [prompt(big(30_000)), reply("one"), prompt("two"), reply("two")];
  expect(keepFrom(messages, 1_000)).toBe(1);
  const longer = [prompt("one"), reply(big(30_000)), prompt("two"), reply("two")];
  expect(keepFrom(longer, 1_000)).toBe(2);
});

test("in a long turn, the kept part starts at a tool call, never at its result", () => {
  const messages = [prompt("go"), toolCall("a"), toolResult("a", big(30_000)), toolCall("b"), toolResult("b")];
  expect(keepFrom(messages, 1_000)).toBe(3);
  expect(messages[keepFrom(messages, 1_000)].role).toBe("assistant");
});

test("when the latest turn alone is too big, compaction keeps nothing", () => {
  const messages = [prompt("go"), toolCall("a"), toolResult("a", big(30_000))];
  expect(keepFrom(messages, 1_000)).toBe(messages.length);
});

test("two replies in a row stay together", () => {
  const paused: MessageParam = { role: "assistant", content: [{ type: "text", text: "searching" }] };
  const messages = [prompt(big(30_000)), paused, reply("done")];
  expect(keepFrom(messages, 1_000)).toBe(1);
  expect(keepFrom([prompt(big(30_000)), reply(big(30_000)), reply("done")], 1_000)).toBe(3);
});

test("a summary on its own is never all that gets summarized", () => {
  expect(keepFrom([summary, prompt("next")], 1_000)).toBe(2);
  expect(keepFrom([summary, prompt("next"), reply("done")], 1_000)).toBe(2);
});

test("a compaction that keeps messages puts the summary in front of them", () => {
  const current = session();
  current.appendMessage({ role: "user", content: "first" });
  current.appendMessage(reply("first reply"));
  current.appendMessage({ role: "user", content: "second" });
  current.appendMessage(reply("second reply"));
  current.append({ t: "compacted", ...record(), kept: 2 });
  expect(current.messages).toEqual([summary, { role: "user", content: "second" }, reply("second reply")]);
  const loaded = Session.load(current.file)!;
  expect(loaded.messages).toEqual(current.messages);
});

test("the opening context comes back after a compaction that summarized it", () => {
  const current = session();
  current.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "<context>\nfolder" },
      { type: "text", text: "hi" },
    ],
  });
  current.appendMessage(reply("hello"));
  current.append({ t: "compacted", ...record(), kept: 1 });
  expect(current.needsContext).toBe(true);
  current.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "<context>\nfolder" },
      { type: "text", text: "next" },
    ],
  });
  expect(current.needsContext).toBe(false);
});

test("a kept message that holds the context means it isn't sent again", () => {
  const current = session();
  current.appendMessage({ role: "user", content: "old" });
  current.appendMessage(reply("old reply"));
  current.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "<context>\nfolder" },
      { type: "text", text: "hi" },
    ],
  });
  current.appendMessage(reply("hello"));
  current.append({ t: "compacted", ...record(), kept: 2 });
  expect(current.needsContext).toBe(false);
});

test("each model compacts at its own point, and the setting moves it", () => {
  // 80% of the window, less the longest reply: (1M - 64k) * 0.8.
  expect(compactAt("claude-opus-5-5")).toBe(748_800);
  expect(compactAt("claude-sonnet-5-5+opus-5-5")).toBe(748_800);
  // Under Haiku 5.5's long-prompt price.
  expect(compactAt("claude-haiku-5-5")).toBeLessThan(100_000);
  // A model clue doesn't know keeps the API's default.
  expect(compactAt("claude-unknown")).toBe(150_000);
  expect(compactAt("claude-opus-5-5", 500_000)).toBe(500_000);
  expect(compactAt("claude-opus-5-5", "40%")).toBe(400_000);
  expect(compactAt("claude-opus-5-5", 1_000)).toBe(MIN_COMPACT_AT);
  // Room stays for the reply and one more step.
  expect(compactAt("claude-opus-5-5", 2_000_000)).toBe(850_000);
  expect(compactAt("claude-opus-5-5", "half")).toBe(748_800);
});

test("compact_at takes a token count or a share of the window", () => {
  expect(checkSetting("compact_at", 400_000)).toBeNull();
  expect(checkSetting("compact_at", "40%")).toBeNull();
  expect(checkSetting("compact_at", 10_000)).toContain("at least 50000");
  expect(checkSetting("compact_at", "95%")).toContain("5%");
  expect(checkSetting("compact_at", "lots")).toContain("token count");
});

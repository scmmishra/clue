import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequest } from "../src/agent/provider";
import { fingerprint, MessageThread, THREAD_IDLE_MS, THREADS_BETA } from "../src/agent/thread";
import { Session } from "../src/session";

const options = {
  model: "claude-opus-5-5",
  effort: "medium" as const,
  messages: [{ role: "user" as const, content: "hi" }],
};
const replyOf = (fields: Record<string, unknown> = {}) =>
  ({
    id: "msg_one",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    usage: { iterations: [{ type: "message" }] },
    ...fields,
  }) as never;
const reply = replyOf();
const next = [
  ...options.messages,
  { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
  { role: "user" as const, content: "and now?" },
];
const apiError = (status: number, code: string) => ({
  status,
  error: { type: "error", error: { type: "invalid_request_error", message: "", details: { error_code: code } } },
});

// A thread that holds one reply, and a clock the test moves.
function threaded(revision = () => 0) {
  const clock = { now: 0 };
  const thread = new MessageThread(revision, () => clock.now);
  thread.prepare(buildRequest(options));
  thread.record(reply);
  return { thread, clock };
}

test("the first request creates a thread with the whole request", () => {
  const request = buildRequest(options);
  const sent = new MessageThread().prepare(request);
  expect(sent.thread).toEqual({ type: "create" });
  expect(sent.betas).toContain(THREADS_BETA);
  expect(sent.system).toEqual(request.system);
  expect(sent.tools).toEqual(request.tools);
  expect(sent.messages).toEqual(request.messages);
});

test("a later request continues the thread with only the new messages", () => {
  const { thread } = threaded();
  const sent = thread.prepare(buildRequest({ ...options, messages: next }));
  expect(sent.thread).toEqual({ type: "continue", previous_message_id: "msg_one" });
  expect(sent.messages).toEqual([{ role: "user", content: "and now?" }]);
  expect("system" in sent).toBe(false);
  expect("tools" in sent).toBe(false);
  expect(sent.betas).toContain(THREADS_BETA);
});

test("a conversation that was replaced or cut back starts a new thread", () => {
  let revision = 0;
  const { thread } = threaded(() => revision);
  revision += 1;
  const sent = thread.prepare(buildRequest({ ...options, messages: next }));
  expect(sent.thread).toEqual({ type: "create" });
  expect(sent.messages).toEqual(next);
  expect(sent.system).toBeDefined();
});

test("a conversation shorter than the thread starts a new thread", () => {
  const { thread } = threaded();
  expect(thread.prepare(buildRequest({ ...options, messages: [] })).thread).toEqual({ type: "create" });
});

test("a request after the thread has gone idle starts a new thread", () => {
  const early = threaded();
  early.clock.now = THREAD_IDLE_MS - 1;
  expect(early.thread.prepare(buildRequest({ ...options, messages: next })).thread?.type).toBe("continue");
  const late = threaded();
  late.clock.now = THREAD_IDLE_MS;
  expect(late.thread.prepare(buildRequest({ ...options, messages: next })).thread?.type).toBe("create");
});

test("a changed effort, model or fast mode starts a new thread", () => {
  for (const change of [{ effort: "high" as const }, { model: "claude-sonnet-5-5" }, { fast: true }]) {
    const { thread } = threaded();
    const sent = thread.prepare(buildRequest({ ...options, ...change, messages: next }));
    expect(sent.thread, JSON.stringify(change)).toEqual({ type: "create" });
  }
});

test("the fingerprint ignores the order of betas and the value of fallbacks", () => {
  const request = buildRequest({ ...options, fast: true });
  const reordered = { ...request, betas: [...request.betas!].reverse() };
  expect(fingerprint(reordered)).toBe(fingerprint(request));
  const otherFallbacks = { ...request, fallbacks: "other" } as unknown as typeof request;
  expect(fingerprint(otherFallbacks)).toBe(fingerprint(request));
  const { fallbacks: _fallbacks, ...withoutFallbacks } = request as typeof request & { fallbacks?: unknown };
  expect(fingerprint(withoutFallbacks as typeof request)).not.toBe(fingerprint(request));
});

test("a turn the API doesn't keep is not continued", () => {
  const replies = {
    refusal: replyOf({ stop_reason: "refusal" }),
    fallback: replyOf({ usage: { iterations: [{ type: "fallback_message" }] } }),
    "cut-off tool call": replyOf({
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", id: "t", name: "read_file", input: {} }],
    }),
  };
  for (const [name, message] of Object.entries(replies)) {
    const thread = new MessageThread();
    thread.prepare(buildRequest(options));
    thread.record(message);
    expect(thread.prepare(buildRequest({ ...options, messages: next })).thread, name).toEqual({ type: "create" });
  }
});

test("a request that never got its reply leaves nothing to continue", () => {
  const { thread } = threaded();
  // Sent as a continue, then stopped: the API may hold a reply clue never received.
  expect(thread.prepare(buildRequest({ ...options, messages: next })).thread?.type).toBe("continue");
  expect(thread.prepare(buildRequest({ ...options, messages: next })).thread).toEqual({ type: "create" });
});

test("a refused thread request is sent again as a create", () => {
  const later = [...next, { role: "assistant" as const, content: [] }, { role: "user" as const, content: "more" }];
  for (const code of ["thread_not_found", "thread_already_continued", "thread_continue_in_flight"]) {
    const { thread } = threaded();
    // A reply to a continue, so a lost thread later is not the API failing to store it.
    thread.prepare(buildRequest({ ...options, messages: next }));
    thread.record(replyOf({ id: "msg_two" }));
    expect(thread.prepare(buildRequest({ ...options, messages: later })).thread?.type).toBe("continue");
    expect(thread.recover(apiError(400, code)), code).toBe(true);
    expect(thread.prepare(buildRequest({ ...options, messages: later })).thread, code).toEqual({ type: "create" });
  }
});

test("a thread lost once is replayed, and lost again right after the replay turns threads off", () => {
  const later = [...next, { role: "assistant" as const, content: [] }, { role: "user" as const, content: "more" }];
  const { thread } = threaded();
  expect(thread.prepare(buildRequest({ ...options, messages: next })).thread?.type).toBe("continue");
  expect(thread.recover(apiError(404, "thread_not_found"))).toBe(true);
  expect(thread.prepare(buildRequest({ ...options, messages: next })).thread).toEqual({ type: "create" });
  thread.record(replyOf({ id: "msg_replay" }));
  expect(thread.prepare(buildRequest({ ...options, messages: later })).thread?.type).toBe("continue");
  expect(thread.recover(apiError(404, "thread_not_found"))).toBe(true);
  const sent = thread.prepare(buildRequest({ ...options, messages: later }));
  expect(sent.thread).toBeUndefined();
  expect(sent.betas ?? []).not.toContain(THREADS_BETA);
});

test("a thread lost after a replay that was continued fine is replayed again", () => {
  const later = [...next, { role: "assistant" as const, content: [] }, { role: "user" as const, content: "more" }];
  const last = [...later, { role: "assistant" as const, content: [] }, { role: "user" as const, content: "last" }];
  const { thread } = threaded();
  thread.prepare(buildRequest({ ...options, messages: next }));
  thread.recover(apiError(404, "thread_not_found"));
  thread.prepare(buildRequest({ ...options, messages: next }));
  thread.record(replyOf({ id: "msg_replay" }));
  thread.prepare(buildRequest({ ...options, messages: later }));
  thread.record(replyOf({ id: "msg_after" }));
  expect(thread.prepare(buildRequest({ ...options, messages: last })).thread?.type).toBe("continue");
  expect(thread.recover(apiError(404, "thread_not_found"))).toBe(true);
  expect(thread.prepare(buildRequest({ ...options, messages: last })).thread).toEqual({ type: "create" });
});

test("a request threads can't serve turns threads off", () => {
  const thread = new MessageThread();
  thread.prepare(buildRequest(options));
  expect(thread.recover(apiError(400, "thread_unsupported_request"))).toBe(true);
  expect(thread.prepare(buildRequest(options)).thread).toBeUndefined();
});

test("an error that isn't about the thread is left to the loop", () => {
  const { thread } = threaded();
  thread.prepare(buildRequest({ ...options, messages: next }));
  expect(thread.recover(new Error("overloaded"))).toBe(false);
  expect(thread.recover(apiError(400, "invalid_request"))).toBe(false);
});

test("a session's revision goes up for a rewind, and not for an added message", () => {
  const session = Session.create(mkdtempSync(join(tmpdir(), "clue-revision-")));
  session.appendMessage({ role: "user", content: "one" });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "two" }] });
  expect(session.revision).toBe(0);
  session.append({ t: "rewind", transcript: 0, turns: 0 });
  expect(session.revision).toBe(1);
  expect(session.messages).toEqual([]);
});

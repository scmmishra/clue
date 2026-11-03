import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequest } from "../src/agent/provider";
import { MessageThread, THREADS_BETA } from "../src/agent/thread";
import { Session } from "../src/session";

const options = {
  model: "claude-opus-5-5",
  effort: "medium" as const,
  messages: [{ role: "user" as const, content: "hi" }],
};
const reply = { id: "msg_one", content: [{ type: "text", text: "hello" }] } as never;

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
  const thread = new MessageThread();
  thread.prepare(buildRequest(options));
  thread.record(reply);
  const messages = [
    ...options.messages,
    { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
    { role: "user" as const, content: "and now?" },
  ];
  const sent = thread.prepare(buildRequest({ ...options, messages }));
  expect(sent.thread).toEqual({ type: "continue", previous_message_id: "msg_one" });
  expect(sent.messages).toEqual([{ role: "user", content: "and now?" }]);
  expect("system" in sent).toBe(false);
  expect("tools" in sent).toBe(false);
  expect(sent.betas).toContain(THREADS_BETA);
});

test("a conversation that was replaced or cut back starts a new thread", () => {
  let revision = 0;
  const thread = new MessageThread(() => revision);
  thread.prepare(buildRequest(options));
  thread.record(reply);
  const messages = [
    ...options.messages,
    { role: "assistant" as const, content: [] },
    { role: "user" as const, content: "next" },
  ];
  expect(thread.prepare(buildRequest({ ...options, messages })).thread?.type).toBe("continue");
  revision += 1;
  const sent = thread.prepare(buildRequest({ ...options, messages }));
  expect(sent.thread).toEqual({ type: "create" });
  expect(sent.messages).toEqual(messages);
  expect(sent.system).toBeDefined();
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

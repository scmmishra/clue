import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { buildRequest } from "../src/agent/provider";
import { MessageThread } from "../src/agent/thread";

const options = {
  model: "claude-opus-5-5",
  effort: "medium" as const,
  messages: [{ role: "user" as const, content: "hi" }],
};

test("the thread passes the request on unchanged and keeps its sha256", () => {
  const thread = new MessageThread();
  expect(thread.lastHash).toBeNull();
  const request = buildRequest(options);
  const before = JSON.stringify(request);
  expect(thread.prepare(request)).toBe(request);
  expect(JSON.stringify(request)).toBe(before);
  expect(thread.lastHash).toBe(createHash("sha256").update(before).digest("hex"));
});

test("a different request gets a different hash", () => {
  const thread = new MessageThread();
  thread.prepare(buildRequest(options));
  const first = thread.lastHash;
  thread.prepare(buildRequest({ ...options, messages: [{ role: "user", content: "hello" }] }));
  expect(thread.lastHash).not.toBe(first);
});

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent/loop";
import { MessageThread, THREAD_FRESH_MS, THREADS_BETA } from "../src/agent/thread";
import { Permissions } from "../src/permissions";
import { Session, type MessageParam } from "../src/session";
import { requests, startMockApi, threads } from "./mock-api";

// A client whose streams finish when the test says. Each call records the body it was sent.
function fakeClient(reject: (body: any) => unknown = () => null) {
  const sent: any[] = [];
  let finish: (message: unknown) => void = () => {};
  const client = {
    beta: {
      messages: {
        stream(body: any) {
          sent.push(body);
          const listeners: ((message: unknown) => void)[] = [];
          finish = (message) => listeners.forEach((listener) => listener(message));
          return {
            on: (_event: string, listener: (message: unknown) => void) => listeners.push(listener),
            withResponse: async () => {
              const error = reject(body);
              if (error) throw error;
            },
          };
        },
      },
    },
  };
  return { client: client as never, sent, finish: (message: unknown) => finish(message) };
}

const reply = (id: string, stop = "tool_use", extra: Record<string, unknown> = {}) => ({
  id,
  role: "assistant",
  content: [{ type: "text", text: `reply ${id}` }],
  stop_reason: stop,
  usage: {},
  ...extra,
});

const request = (messages: MessageParam[], extra: Record<string, unknown> = {}) =>
  ({
    model: "claude-opus-5-5",
    max_tokens: 1000,
    stream: true,
    system: [{ type: "text", text: "system" }],
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
    cache_control: { type: "ephemeral" },
    betas: ["compact-2026-09-04"].slice(0, 0),
    messages,
    ...extra,
  }) as never;

const apiError = (status: number, code: string) => ({ status, error: { error: { details: { error_code: code } } } });
const signal = new AbortController().signal;

// Sends `messages` through the thread, and finishes the reply as `id`.
async function turn(
  thread: MessageThread,
  fake: ReturnType<typeof fakeClient>,
  messages: MessageParam[],
  id: string,
  extra = {},
) {
  await thread.stream(fake.client, request(messages, extra), signal);
  const message = reply(id);
  fake.finish(message);
  return { role: "assistant", content: message.content } as MessageParam;
}

test("the first request starts a thread, and the next sends only the new messages", async () => {
  const thread = new MessageThread();
  const fake = fakeClient();
  const history: MessageParam[] = [{ role: "user", content: "hi" }];
  history.push(await turn(thread, fake, history, "msg_1"));
  history.push({ role: "user", content: "next" });
  await turn(thread, fake, history, "msg_2");
  expect(fake.sent[0].thread).toEqual({ type: "create" });
  expect(fake.sent[0].betas).toContain(THREADS_BETA);
  expect(fake.sent[0].system).toBeDefined();
  expect(fake.sent[1].thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
  expect(fake.sent[1].messages).toEqual([{ role: "user", content: "next" }]);
  expect(fake.sent[1].system).toBeUndefined();
  expect(fake.sent[1].tools).toBeUndefined();
  expect(fake.sent[1].cache_control).toEqual({ type: "ephemeral" });
});

test("a conversation cut back, such as by a rewind, starts a new thread", async () => {
  const thread = new MessageThread();
  const fake = fakeClient();
  const history: MessageParam[] = [{ role: "user", content: "hi" }];
  history.push(await turn(thread, fake, history, "msg_1"));
  await turn(thread, fake, [{ role: "user", content: "instead" }], "msg_2");
  expect(fake.sent[1].thread).toEqual({ type: "create" });
});

test("a changed reply in the history starts a new thread", async () => {
  const thread = new MessageThread();
  const fake = fakeClient();
  await turn(thread, fake, [{ role: "user", content: "hi" }], "msg_1");
  const edited: MessageParam[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "something else" }] },
    { role: "user", content: "next" },
  ];
  await turn(thread, fake, edited, "msg_2");
  expect(fake.sent[1].thread).toEqual({ type: "create" });
});

test("a change to a field the thread fixes starts a new thread", async () => {
  const thread = new MessageThread();
  const fake = fakeClient();
  const history: MessageParam[] = [{ role: "user", content: "hi" }];
  history.push(await turn(thread, fake, history, "msg_1"));
  history.push({ role: "user", content: "next" });
  await turn(thread, fake, history, "msg_2", { betas: ["fast-mode-2026-02-01"] });
  expect(fake.sent[1].thread).toEqual({ type: "create" });
});

test("after 4.5 minutes, clue starts a new thread without asking for the old one", async () => {
  let now = 0;
  const thread = new MessageThread(() => now);
  const fake = fakeClient();
  const history: MessageParam[] = [{ role: "user", content: "hi" }];
  history.push(await turn(thread, fake, history, "msg_1"));
  history.push({ role: "user", content: "next" });
  now = THREAD_FRESH_MS + 1;
  await turn(thread, fake, history, "msg_2");
  expect(fake.sent[1].thread).toEqual({ type: "create" });
});

test("a thread the API lost is sent again in full, once", async () => {
  const thread = new MessageThread();
  const fake = fakeClient((body) => (body.thread?.type === "continue" ? apiError(404, "thread_not_found") : null));
  const history: MessageParam[] = [{ role: "user", content: "hi" }];
  history.push(await turn(thread, fake, history, "msg_1"));
  history.push({ role: "user", content: "next" });
  await turn(thread, fake, history, "msg_2");
  expect(fake.sent.map((body) => body.thread.type)).toEqual(["create", "continue", "create"]);
  expect(fake.sent[2].messages).toHaveLength(3);
});

test("when the API refuses threads, the session goes on without them", async () => {
  const thread = new MessageThread();
  const fake = fakeClient((body) => (body.thread ? apiError(400, "thread_unsupported_request") : null));
  await thread.stream(fake.client, request([{ role: "user", content: "hi" }]), signal);
  await thread.stream(fake.client, request([{ role: "user", content: "again" }]), signal);
  expect(fake.sent.map((body) => body.thread?.type ?? "none")).toEqual(["create", "none", "none"]);
  expect(fake.sent[1].betas ?? []).not.toContain(THREADS_BETA);
  expect(thread.enabled).toBe(false);
});

test("other errors reach the loop", async () => {
  const thread = new MessageThread();
  const fake = fakeClient(() => apiError(400, "something_else"));
  await expect(thread.stream(fake.client, request([{ role: "user", content: "hi" }]), signal)).rejects.toBeDefined();
});

test("a reply that never finished, a refusal or a fallback model's reply can't be continued", async () => {
  for (const ending of ["unfinished", "refusal", "fallback"]) {
    const thread = new MessageThread();
    const fake = fakeClient();
    const history: MessageParam[] = [{ role: "user", content: "hi" }];
    await thread.stream(fake.client, request(history), signal);
    if (ending === "refusal") fake.finish(reply("msg_1", "refusal"));
    if (ending === "fallback")
      fake.finish(reply("msg_1", "end_turn", { usage: { iterations: [{ type: "fallback_message" }] } }));
    history.push({ role: "assistant", content: [{ type: "text", text: "reply msg_1" }] });
    history.push({ role: "user", content: "next" });
    await turn(thread, fake, history, "msg_2");
    expect(fake.sent[1].thread).toEqual({ type: "create" });
  }
});

test("after pause_turn, the next request continues with no new messages", async () => {
  const thread = new MessageThread();
  const fake = fakeClient();
  const history: MessageParam[] = [{ role: "user", content: "search the web" }];
  await thread.stream(fake.client, request(history), signal);
  const paused = reply("msg_1", "pause_turn");
  fake.finish(paused);
  history.push({ role: "assistant", content: paused.content } as MessageParam);
  await turn(thread, fake, history, "msg_2");
  expect(fake.sent[1].thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
  expect(fake.sent[1].messages).toEqual([]);
});

test("a request that carries a summary or automatic compaction goes without a thread", async () => {
  const thread = new MessageThread();
  const fake = fakeClient();
  const summary = { role: "assistant", content: [{ type: "compaction", content: "Summary.", signature: "s" }] };
  await thread.stream(fake.client, request([summary as never, { role: "user", content: "hi" }]), signal);
  await thread.stream(
    fake.client,
    request([{ role: "user", content: "hi" }], { context_management: { edits: [] } }),
    signal,
  );
  expect(fake.sent.map((body) => body.thread)).toEqual([undefined, undefined]);
  expect(thread.enabled).toBe(true);
});

// End to end, against the mock API, which rebuilds each thread as the API does.
let server: ReturnType<typeof startMockApi>;
beforeAll(() => {
  server = startMockApi();
  process.env.ANTHROPIC_BASE_URL = server.url.origin;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});
afterAll(() => server.stop(true));
afterEach(() => {
  threads.unsupported = null;
});

function agent(threadsSetting?: boolean) {
  const session = Session.create(realpathSync(mkdtempSync(join(tmpdir(), "clue-threads-"))));
  session.ephemeral = true;
  return new Agent({
    cwd: session.cwd,
    session,
    settings: { model: "claude-opus-5-5", effort: "medium", fast: false, threads: threadsSetting },
    permissions: new Permissions("full-access", {}, session.cwd),
    mcp: { configuredNames: () => [] } as never,
    skills: () => [],
    events: {
      thinking() {},
      text() {},
      textDone() {},
      toolStart() {},
      toolUpdate() {},
      toolEnd() {},
      review() {},
      confirm: async () => "no",
      question: async () => null,
      notice() {},
    },
    interactive: false,
  });
}

test("a session's requests after the first send only what is new, and Claude sees the whole conversation", async () => {
  const sentBefore = threads.sent.length;
  const requestsBefore = requests.length;
  const clue = agent();
  await clue.runTurn("first prompt", signal);
  await clue.runTurn("second prompt", signal);
  const sent = threads.sent.slice(sentBefore);
  // Each turn calls read_file once: the first turn's two requests, then the second turn's two.
  expect(sent.map((body) => body.thread!.type)).toEqual(["create", "continue", "continue", "continue"]);
  expect(sent.slice(1).every((body) => body.system === undefined && body.tools === undefined)).toBe(true);
  expect(JSON.stringify(sent[2].messages)).toContain("second prompt");
  expect(JSON.stringify(sent[2].messages)).not.toContain("first prompt");
  // The conversation the API rebuilt is the session's.
  const rebuilt = requests.slice(requestsBefore).at(-1)!;
  expect(rebuilt.messages).toEqual(JSON.parse(JSON.stringify(clue.session.messages.slice(0, -1))));
});

test("an expired thread costs one full resend, and the turn goes on", async () => {
  const clue = agent();
  await clue.runTurn("first prompt", signal);
  threads.held.clear();
  const before = threads.sent.length;
  const turn = await clue.runTurn("second prompt", signal);
  expect(turn.stop).toBe("end_turn");
  expect(threads.sent.slice(before).map((body) => body.thread!.type)).toEqual(["continue", "create", "continue"]);
});

test("an account without threads works as before", async () => {
  threads.unsupported = "hipaa";
  const before = requests.length;
  const clue = agent();
  const turn = await clue.runTurn("first prompt", signal);
  expect(turn.stop).toBe("end_turn");
  expect(clue.thread!.enabled).toBe(false);
  expect(requests.slice(before).every((body) => body.thread === undefined)).toBe(true);
});

test('"threads": false sends every request in full', async () => {
  const before = threads.sent.length;
  const clue = agent(false);
  await clue.runTurn("first prompt", signal);
  expect(clue.thread).toBeNull();
  expect(threads.sent.length).toBe(before);
});

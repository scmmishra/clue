import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvents } from "../src/agent/loop";
import { Permissions } from "../src/permissions";
import { Session, type ToolRecord } from "../src/session";

// Read-only calls start while the reply streams. Each script is one reply. A number in it pauses
// the stream for that many milliseconds, and the server notes when it sent `message_stop`.

type Event = Record<string, unknown>;
const PAUSE = 150;

const start = (): Event => ({
  type: "message_start",
  message: {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "m",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});
const stop = (reason: string): Event[] => [
  { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];
const text = (index: number, value: string): Event[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index },
];
const call = (index: number, id: string, name: string, input: unknown, complete = true): Event[] => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
  {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: complete ? JSON.stringify(input) : '{"path":"cut' },
  },
  { type: "content_block_stop", index },
];

let restore = () => {};
afterEach(() => restore());

function project() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clue-early-")));
  for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(cwd, name), `export const ${name[0]} = 1;\n`);
  mkdirSync(join(cwd, "sub"));
  writeFileSync(join(cwd, "sub", "AGENTS.md"), "Use tabs in sub.\n");
  writeFileSync(join(cwd, "sub", "x.ts"), "export const x = 1;\n");
  return cwd;
}

async function runScripted(cwd: string, scripts: (Event | number)[][], abortAfter?: number) {
  const bodies: { messages: { content: unknown }[] }[] = [];
  const stoppedAt: number[] = [];
  const encoder = new TextEncoder();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as (typeof bodies)[number]);
      const script = scripts.shift() ?? [start(), ...text(0, "ok"), ...stop("end_turn")];
      const body = new ReadableStream({
        async start(controller) {
          for (const item of script) {
            if (typeof item === "number") {
              await Bun.sleep(item);
              continue;
            }
            if (item.type === "message_stop") stoppedAt.push(Date.now());
            controller.enqueue(encoder.encode(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`));
          }
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const base = process.env.ANTHROPIC_BASE_URL;
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = server.url.origin;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  restore = () => {
    server.stop(true);
    process.env.ANTHROPIC_BASE_URL = base;
    process.env.ANTHROPIC_API_KEY = key;
  };
  const session = Session.create(cwd);
  session.ephemeral = true;
  const ends: ToolRecord[] = [];
  const controller = new AbortController();
  const events: AgentEvents = {
    thinking() {},
    text() {},
    textDone() {},
    toolStart() {},
    toolUpdate() {},
    toolEnd: (record) => void ends.push(record),
    review() {},
    confirm: async () => "no",
    question: async () => null,
    notice() {},
    toolsStopped() {},
  };
  const agent = new Agent({
    cwd,
    session,
    settings: { model: "claude-opus-5-5", effort: "medium", fast: false },
    permissions: new Permissions("full-access", {}, cwd),
    mcp: { configuredNames: () => [] } as never,
    skills: () => [],
    events,
    interactive: false,
  });
  if (abortAfter !== undefined) setTimeout(() => controller.abort(), abortAfter);
  let error: unknown = null;
  const turn = await agent.runTurn("go", controller.signal).catch((thrown) => void (error = thrown));
  return { agent, session, ends, bodies, stoppedAt, error, turn };
}

const resultIds = (body: { messages: { content: unknown }[] }) =>
  (body.messages.at(-1)!.content as { type: string; tool_use_id: string }[])
    .filter((block) => block.type === "tool_result")
    .map((block) => block.tool_use_id);

test("read-only calls start while the reply is still streaming", async () => {
  const cwd = project();
  const run = await runScripted(cwd, [
    [
      start(),
      ...call(0, "a", "read_file", { path: "a.ts" }),
      PAUSE,
      ...call(1, "b", "grep_files", { pattern: "export" }),
      PAUSE,
      ...call(2, "c", "read_file", { path: "c.ts" }),
      PAUSE,
      ...stop("tool_use"),
    ],
  ]);
  expect(run.error).toBeNull();
  const replyEnded = run.stoppedAt[0]!;
  const started = Object.fromEntries(run.ends.map((record) => [record.id, record.startedAt]));
  // Each call started before the reply finished, so none waited for the others to stream.
  for (const id of ["a", "b", "c"]) expect(started[id]!).toBeLessThan(replyEnded);
  expect(started.a!).toBeLessThan(started.b! - PAUSE / 2);
  // Results go back in the order Claude asked for them, and each call is recorded once.
  expect(resultIds(run.bodies[1]!)).toEqual(["a", "b", "c"]);
  expect([...run.session.tools.keys()].sort()).toEqual(["a", "b", "c"]);
  expect(run.ends.every((record) => !record.isError)).toBe(true);
});

test("a read after a write waits for the write, and one before it doesn't", async () => {
  const cwd = project();
  const run = await runScripted(cwd, [
    [
      start(),
      ...call(0, "before", "read_file", { path: "a.ts" }),
      PAUSE,
      ...call(1, "write", "write_file", { path: "new.ts", content: "export const n = 2;\n" }),
      PAUSE,
      ...call(2, "after", "read_file", { path: "new.ts" }),
      PAUSE,
      ...stop("tool_use"),
    ],
  ]);
  const replyEnded = run.stoppedAt[0]!;
  const record = (id: string) => run.ends.find((end) => end.id === id)!;
  expect(record("before").startedAt).toBeLessThan(replyEnded);
  expect(record("after").startedAt).toBeGreaterThanOrEqual(replyEnded);
  // The read saw the file the write created.
  expect(record("after").isError).toBe(false);
  expect(record("after").output).toContain("export const n = 2;");
});

test("a request that fails after a call started records nothing, and the read never counts", async () => {
  const cwd = project();
  const run = await runScripted(cwd, [
    [
      start(),
      ...call(0, "x", "read_file", { path: "sub/x.ts" }),
      PAUSE,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ],
  ]);
  expect(run.error).not.toBeNull();
  expect(run.ends).toEqual([]);
  expect(run.session.tools.size).toBe(0);
  // Claude never saw the read, so the file isn't marked as read and sub's instructions are still unsent.
  expect(run.agent.readStamps.has(join(cwd, "sub", "x.ts"))).toBe(false);
  expect(run.agent.seenInstructions.has(join(cwd, "sub", "AGENTS.md"))).toBe(false);
});

test("a reply cut off by the output limit drops the calls that started, as before", async () => {
  const cwd = project();
  const run = await runScripted(cwd, [
    [
      start(),
      ...call(0, "x", "read_file", { path: "sub/x.ts" }),
      PAUSE,
      ...call(1, "cut", "read_file", {}, false),
      ...stop("max_tokens"),
    ],
  ]);
  expect(run.error).toBeNull();
  expect(run.ends.map((record) => [record.id, record.isError, record.note])).toEqual([
    ["x", true, "cut off by the output limit"],
    ["cut", true, "cut off by the output limit"],
  ]);
  expect(run.agent.seenInstructions.has(join(cwd, "sub", "AGENTS.md"))).toBe(false);
});

test("an interrupt while the reply streams stops a call that started", async () => {
  const cwd = project();
  const run = await runScripted(
    cwd,
    [[start(), ...call(0, "x", "read_file", { path: "sub/x.ts" }), 2000, ...stop("tool_use")]],
    PAUSE,
  );
  expect(run.turn && (run.turn as { stop: string }).stop).toBe("interrupted");
  expect(run.ends).toEqual([]);
  expect(run.agent.seenInstructions.has(join(cwd, "sub", "AGENTS.md"))).toBe(false);
});

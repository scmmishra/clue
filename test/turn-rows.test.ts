import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvents } from "../src/agent/loop";
import { loadSettings } from "../src/config";
import { Permissions } from "../src/permissions";
import { Session, type ToolRecord, type TurnRecord } from "../src/session";
import type { Screen } from "../src/ui/screen";
import { TurnView } from "../src/ui/turn";

// A screen that keeps what the view commits to the scrollback.
function recording() {
  const commits: string[] = [];
  const screen = {
    commit: (lines: string[]) => commits.push(...lines.map((line) => Bun.stripANSI(line))),
    refresh() {},
    setRenderer() {},
    animate() {},
    status() {},
  } as unknown as Screen;
  return { commits, view: new TurnView(screen) };
}

const turn = {
  prompt: "go",
  startedAt: Date.now(),
  ms: 10,
  tools: 2,
  stop: "end_turn",
  cost: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 },
} as TurnRecord;
const ended = (id: string, label: string): ToolRecord => ({
  id,
  name: "read_file",
  input: {},
  label,
  kind: "read",
  output: "",
  isError: false,
  startedAt: Date.now(),
  ms: 1,
});

test("a row that never ended still reaches the scrollback when the turn finishes", () => {
  const { commits, view } = recording();
  view.toolStart("cut", "Reading cut.ts", "read");
  view.toolStart("ok", "Reading ok.ts", "read");
  view.toolEnd(ended("ok", "Read ok.ts"));
  view.text("All done.");
  view.textDone();
  view.finish(turn);
  const text = commits.join("\n");
  expect(text).toContain("Read ok.ts");
  expect(text).toContain("Reading cut.ts");
});

test("rows of a failed request close, so the next rows can fold", () => {
  const { commits, view } = recording();
  view.toolStart("lost", "Reading lost.ts", "read");
  view.toolsStopped();
  view.toolStart("next", "Reading next.ts", "read");
  view.toolEnd(ended("next", "Read next.ts"));
  view.text("Done.");
  const text = commits.join("\n");
  expect(text).toContain("didn't run");
  expect(text).toContain("Read next.ts");
});

test("a subagent row takes its model and calls from the loop, and keeps them in the scrollback", () => {
  const { commits, view } = recording();
  view.toolStart("sub", "Subagent: Look around", "subagent");
  const info = { model: "claude-haiku-5-5", chosen: true, calls: 2, startedAt: Date.now() };
  view.toolUpdate("sub", "", undefined, info);
  view.toolEnd({ ...ended("sub", "Subagent finished: Look around"), kind: "subagent", ms: 4000 });
  view.text("Done.");
  const text = commits.join("\n");
  expect(text).toContain("1 subagent");
  expect(text).toContain("✓ Look around  haiku 5.5  2 calls · 4.0s");
});

// ---------------------------------------------------------------------------
// The loop, against a server that answers each request with the next script.

type Event = Record<string, unknown>;
const start = (): Event => ({
  type: "message_start",
  message: {
    id: "msg",
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
const toolUse = (index: number, id: string, json: string): Event[] => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "read_file", input: {} } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } },
  { type: "content_block_stop", index },
];
const encode = (events: Event[]) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

let restore = () => {};
afterEach(() => restore());

async function runScripted(scripts: Event[][]) {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const events = scripts.shift() ?? [start(), ...text(0, "ok"), ...stop("end_turn")];
      return new Response(encode(events).join(""), { headers: { "content-type": "text/event-stream" } });
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
  const session = Session.create(realpathSync(mkdtempSync(join(tmpdir(), "clue-turn-rows-"))));
  session.ephemeral = true;
  const started: string[] = [];
  const ends: ToolRecord[] = [];
  let stopped = 0;
  const events: AgentEvents = {
    thinking() {},
    text() {},
    textDone() {},
    toolStart: (id) => void started.push(id),
    toolUpdate() {},
    toolEnd: (record) => void ends.push(record),
    review() {},
    confirm: async () => "no",
    question: async () => null,
    notice() {},
    toolsStopped: () => void stopped++,
  };
  const { model, effort } = loadSettings();
  const agent = new Agent({
    cwd: session.cwd,
    session,
    settings: { model, effort, fast: false },
    permissions: new Permissions("full-access", {}, session.cwd),
    mcp: { configuredNames: () => [] } as never,
    skills: () => [],
    events,
    interactive: false,
  });
  let error: unknown = null;
  await agent.runTurn("go", new AbortController().signal).catch((thrown) => (error = thrown));
  return { started, ends, stopped: () => stopped, session, error };
}

test("a tool call cut off by the output limit ends as a failed call, and the session records it", async () => {
  const run = await runScripted([[start(), ...toolUse(0, "cut", '{"path":"a'), ...stop("max_tokens")]]);
  expect(run.started).toEqual(["cut"]);
  expect(run.ends.map((record) => [record.id, record.isError])).toEqual([["cut", true]]);
  expect(run.session.tools.get("cut")?.isError).toBe(true);
});

test("an advisor call whose answer never comes ends as a failed call", async () => {
  const run = await runScripted([
    [
      start(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "adv", name: "advisor", input: {} },
      },
      { type: "content_block_stop", index: 0 },
      ...text(1, "Done."),
      ...stop("end_turn"),
    ],
  ]);
  expect(run.started).toEqual(["adv"]);
  expect(run.ends.map((record) => [record.id, record.isError])).toEqual([["adv", true]]);
});

test("a request that breaks after starting a tool call closes its rows", async () => {
  const run = await runScripted([
    [
      start(),
      ...toolUse(0, "lost", '{"path":"a.ts"}').slice(0, 1),
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ],
  ]);
  expect(run.error).not.toBeNull();
  expect(run.started).toEqual(["lost"]);
  expect(run.stopped()).toBe(1);
});

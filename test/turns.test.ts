import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTINUE_PROMPT, Session, type TurnRecord } from "../src/session";
import { sessionEntries } from "../src/ui/replay";
import { usageReport } from "../src/ui/usage";
import { startMockApi } from "./mock-api";

let server: ReturnType<typeof startMockApi>;
beforeAll(() => {
  server = startMockApi();
});
afterAll(() => server.stop(true));

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "clue-turns-")));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, webSearches: 0 };
const turnAt = (prompt: string, transcript: number | undefined, startedAt: number): TurnRecord =>
  ({
    prompt,
    startedAt,
    ms: 1,
    firstTokenMs: 1,
    tools: 0,
    usage,
    cost: 0.1,
    model: "m",
    stop: "end_turn",
    transcript,
  }) as TurnRecord;

// Three prompts and replies. The second prompt's turn record is missing, as after a crash.
function sessionWithGap() {
  const session = Session.create(folder());
  ["one", "two", "three"].forEach((text, index) => {
    session.appendMessage({ role: "user", content: text });
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: `reply ${index}` }] });
  });
  session.append({ t: "turn", turn: turnAt("one", 0, 100) });
  session.append({ t: "turn", turn: turnAt("three", 4, 300) });
  return session;
}

test("a missing turn record doesn't shift the pairing of later prompts", () => {
  const session = sessionWithGap();
  expect(session.rewindPoints.map(({ text, turns, at }) => [text, turns, at])).toEqual([
    ["one", 0, 100],
    ["two", 1, undefined],
    ["three", 1, 300],
  ]);
  const entries = sessionEntries(session);
  const shape = entries.flatMap((entry) =>
    entry.type === "prompt" ? [entry.text] : entry.type === "footer" ? [`footer ${entry.turn.prompt}`] : [],
  );
  expect(shape).toEqual(["one", "footer one", "two", "three", "footer three"]);
});

test("rewinding past a gap drops the right turn", () => {
  const session = sessionWithGap();
  const three = session.rewindPoints.at(-1)!;
  session.append({ t: "rewind", transcript: three.transcript, turns: three.turns });
  expect(session.turns.map((turn) => turn.prompt)).toEqual(["one"]);
  expect(session.rewound.map((turn) => turn.prompt)).toEqual(["three"]);
});

test("a session from before turn positions pairs prompts in order", () => {
  const session = Session.create(folder());
  session.appendMessage({ role: "user", content: "one" });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "reply" }] });
  session.append({ t: "turn", turn: turnAt("one", undefined, 100) });
  session.appendMessage({ role: "user", content: "two" });
  expect(session.rewindPoints.map(({ text, turns, at }) => [text, turns, at])).toEqual([
    ["one", 0, 100],
    ["two", 1, undefined],
  ]);
});

test("a session's title never comes from a steering or clue's own message", () => {
  const session = Session.create(folder());
  session.appendMessage({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "a", content: "x" },
      { type: "text", text: "steer" },
    ],
  });
  session.appendMessage({ role: "user", content: CONTINUE_PROMPT });
  session.appendMessage({ role: "user", content: "the real prompt" });
  expect((session as unknown as { title: string }).title).toBe("the real prompt");
});

test("the context size ignores a turn older than the last compaction", () => {
  const turn = { ...turnAt("one", 0, 100), context: 160_000 };
  const compaction = { at: 500, usage, cost: 0, model: "m" } as never;
  const session = Session.create(folder());
  expect(session.lastContextSize).toBeUndefined();
  session.append({ t: "turn", turn });
  expect(session.lastContextSize).toBe(160_000);
  session.compactions.push(compaction);
  expect(session.lastContextSize).toBeUndefined();
  expect(usageReport([turn], [compaction]).join("\n")).toContain("Shows after the next reply");
});

test("rewind finds a turn's file edits after a crash left a tool call open", async () => {
  const cwd = folder();
  const session = Session.create(cwd);
  session.appendMessage({ role: "user", content: "before the crash" });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_x", name: "shell", input: { command: "true" } }],
  });
  const proc = Bun.spawn(["bun", join(import.meta.dir, "agent-turn.ts"), session.file, "create the note"], {
    env: { ...process.env, ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "sk-ant-test" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const { transcript, point, files } = JSON.parse(await new Response(proc.stdout).text());
  expect(files).toBe(1);
  expect(transcript).toBe(point);
}, 15_000);

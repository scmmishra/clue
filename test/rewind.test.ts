import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTINUE_PROMPT, Session, type MessageParam, type TurnRecord } from "../src/session";
import { sessionEntries } from "../src/ui/replay";
import { RewindPicker, rewindReport, sentAt, type RewindRow } from "../src/ui/rewind";
import { usageReport } from "../src/ui/usage";

const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, webSearches: 0 };
const turn = (prompt: string): TurnRecord => ({
  prompt,
  startedAt: 1000,
  ms: 1,
  firstTokenMs: 1,
  tools: 0,
  usage,
  cost: 0.5,
  model: "claude-opus-5-5",
  stop: "end_turn",
  context: 1000,
});

function chat(prompts: string[]) {
  const session = Session.create(realpathSync(mkdtempSync(join(tmpdir(), "clue-rewind-"))));
  prompts.forEach((prompt, index) => {
    session.appendMessage({
      role: "user",
      content: index
        ? prompt
        : [
            { type: "text", text: "<context>x</context>" },
            { type: "text", text: prompt },
          ],
    });
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: `reply ${prompt}` }] });
    session.append({ t: "turn", turn: turn(prompt) });
  });
  return session;
}

test("every prompt is a point, without the context or tool results", () => {
  const session = chat(["one", "two"]);
  session.appendMessage({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "a", content: "x" }],
  });
  expect(session.rewindPoints.map((point) => [point.text, point.transcript, point.turns])).toEqual([
    ["one", 0, 0],
    ["two", 2, 1],
  ]);
});

test("clue's own continue message isn't a prompt", () => {
  const session = chat(["one"]);
  session.appendMessage({ role: "user", content: CONTINUE_PROMPT });
  expect(session.rewindPoints).toHaveLength(1);
  expect(sessionEntries(session).filter((entry) => entry.type === "prompt")).toHaveLength(1);
});

test("a rewind cuts the messages, the transcript and the turns", () => {
  const session = chat(["one", "two", "three"]);
  const [, two] = session.rewindPoints;
  session.append({ t: "rewind", transcript: two.transcript, turns: two.turns });
  expect(session.messages).toHaveLength(2);
  expect(session.transcript).toHaveLength(2);
  expect(session.turns.map((record) => record.prompt)).toEqual(["one"]);
  expect(session.rewound).toHaveLength(2);
});

test("a saved rewind loads the same way, and a new prompt follows it", () => {
  const session = chat(["one", "two"]);
  const [, two] = session.rewindPoints;
  session.append({ t: "rewind", transcript: two.transcript, turns: two.turns });
  session.appendMessage({ role: "user", content: "again" });
  const loaded = Session.load(session.file)!;
  expect(loaded.messages).toEqual(session.messages);
  expect(loaded.rewindPoints.map((point) => point.text)).toEqual(["one", "again"]);
});

test("rewinding to the first prompt empties the session, so the context goes again", () => {
  const session = chat(["one", "two"]);
  session.append({ t: "rewind", transcript: 0, turns: 0 });
  expect(session.isEmpty).toBe(true);
  expect(session.needsContext).toBe(true);
});

test("only prompts since a compaction are points, and a rewind keeps the summary", () => {
  const session = chat(["one"]);
  const summary: MessageParam = {
    role: "assistant",
    content: [{ type: "compaction", content: "S", signature: "s" } as never],
  };
  session.append({ t: "compacted", message: summary, usage, cost: 0, model: "m", at: 2000 });
  session.appendMessage({ role: "user", content: "two" });
  session.appendMessage({ role: "assistant", content: "reply" });
  session.append({ t: "turn", turn: turn("two") });
  const points = session.rewindPoints;
  expect(points.map((point) => point.text)).toEqual(["two"]);
  session.append({ t: "rewind", transcript: points[0].transcript, turns: points[0].turns });
  expect(session.messages).toEqual([summary]);
  expect(session.needsContext).toBe(true);
});

test("turns a rewind dropped still count toward the cost", () => {
  const session = chat(["one", "two"]);
  session.append({ t: "rewind", transcript: 2, turns: 1 });
  const text = usageReport(session.turns, session.compactions, session.rewound)
    .map((line) => Bun.stripANSI(line))
    .join("\n");
  expect(text).toContain("$1.00");
});

const row = (text: string, overrides: Partial<RewindRow> = {}): RewindRow => ({
  point: { text, transcript: 0, turns: 0 },
  files: 0,
  ranShell: false,
  restorable: true,
  ...overrides,
});
const shown = (picker: RewindPicker) => picker.frame().map((line) => Bun.stripANSI(line));

test("each row says what a rewind can do", () => {
  const lines = shown(
    new RewindPicker([
      row("resumed", { restorable: false }),
      row("both", { files: 1, ranShell: true }),
      row("edited", { files: 3 }),
    ]),
  );
  expect(lines[1]).toContain("conversation only");
  expect(lines[2]).toContain("1 file · shell");
  expect(lines[3]).toContain("› edited");
  expect(lines[3]).toContain("3 files");
  expect(lines.at(-1)).toContain("enter rewind · tab keep files · esc cancel");
});

test("the cursor starts on the newest prompt, up goes back, and arrows wrap", () => {
  const picker = new RewindPicker([row("old"), row("new")]);
  expect(picker.turnsDropped).toBe(1);
  picker.handle({ name: "up" });
  expect(picker.handle({ name: "enter" })).toMatchObject({ point: { text: "old" }, keepFiles: false, force: false });
  expect(picker.turnsDropped).toBe(2);
  expect(picker.handle({ name: "tab" })).toMatchObject({ keepFiles: true });
  picker.handle({ name: "up" });
  expect(picker.turnsDropped).toBe(1);
  expect(picker.handle({ name: "escape" })).toBe("cancel");
  expect(picker.handle({ name: "char", text: "x" })).toBeNull();
});

test("a long list opens on the newest prompts and scrolls only past the window's edge", () => {
  const picker = new RewindPicker(Array.from({ length: 15 }, (_, index) => row(`p${index}`)));
  const prompts = () => shown(picker).filter((line) => /\bp\d+\b/.test(line));
  const first = () => prompts()[0].match(/p\d+/)![0];
  expect(prompts()).toHaveLength(10);
  expect(first()).toBe("p5");
  expect(prompts().at(-1)).toContain("› p14");
  for (let step = 0; step < 9; step++) picker.handle({ name: "up" });
  expect(prompts()[0]).toContain("› p5");
  picker.handle({ name: "up" });
  expect(prompts()[0]).toContain("› p4");
  picker.handle({ name: "down" });
  expect(first()).toBe("p4");
});

test("recent prompts show minutes ago, older ones the time, and other days the date too", () => {
  const now = new Date(2026, 9, 31, 21, 20).getTime();
  const at = (...parts: [number, number, number, number, number]) => new Date(...parts);
  const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  expect(sentAt(now - 20_000, now)).toBe("now");
  expect(sentAt(now - 12 * 60_000, now)).toBe("12m ago");
  expect(sentAt(now - 29 * 60_000, now)).toBe("29m ago");
  const earlier = at(2026, 9, 31, 18, 5);
  expect(sentAt(earlier.getTime(), now)).toBe(time(earlier));
  const yesterday = at(2026, 9, 30, 23, 50);
  expect(sentAt(yesterday.getTime(), now)).toBe(
    `${yesterday.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time(yesterday)}`,
  );
  const lastYear = at(2025, 11, 31, 9, 0);
  expect(sentAt(lastYear.getTime(), now)).toContain("2025");
});

test("prompts from the same hours get different times, in one column", () => {
  const now = Date.now();
  const rows = [row("a", {}), row("b", {}), row("c", {})];
  rows[0].point.at = now - 3 * 3_600_000;
  rows[1].point.at = now - 3 * 3_600_000 + 7 * 60_000;
  rows[2].point.at = now - 5 * 60_000;
  const lines = shown(new RewindPicker(rows)).slice(1, 4);
  const times = rows.map((r) => sentAt(r.point.at!, now));
  expect(new Set(times).size).toBe(3);
  lines.forEach((line, index) => expect(line).toContain(times[index]));
  const column = lines.map((line, index) => line.indexOf(times[index]));
  expect(new Set(column).size).toBe(1);
});

test("a conflict shows the files, and enter then overwrites", () => {
  const picker = new RewindPicker([row("new")]);
  picker.conflict(["a.ts"]);
  expect(shown(picker).join("\n")).toContain("Changed since: a.ts");
  expect(picker.handle({ name: "enter" })).toMatchObject({ force: true });
});

test("the marker says what happened, and that the old output stays", () => {
  const lines = rewindReport(
    2,
    { kind: "done", restored: ["/p/a.ts"], deleted: ["/p/b.ts"], failed: ["/p/c.ts"], ranShell: true },
    "/p",
  ).map((line) => Bun.stripANSI(line));
  expect(lines[0]).toBe("  ── rewound 2 turns · restored 2 files · earlier output above no longer applies ──");
  expect(lines).toContain("  Could not restore c.ts");
  expect(lines).toContain("  Shell commands from those turns weren't undone.");
  expect(Bun.stripANSI(rewindReport(1, null, "/p")[0])).toContain("rewound 1 turn ·");
});

import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { loadSettings } from "../src/config";
import { Session, type TurnRecord } from "../src/session";
import { pickSession } from "../src/ui/picker";
import type { Key, KeyHandler } from "../src/ui/screen";

process.env.ANTHROPIC_API_KEY ??= "sk-ant-test";

const ENTER: Key = { name: "enter" };
const CTRL_C: Key = { name: "c", ctrl: true };
const char = (text: string): Key => ({ name: "char", text });

// The App's private parts these tests drive.
type Inside = {
  mode: string;
  steering: unknown;
  queued: { text: string; images: [] } | null;
  optionPicker: unknown;
  rewindPicker: unknown;
  load(session: Session): boolean;
  idle(): void;
  submit(text: string): Promise<void>;
  runTurn(prompt: string, images: []): Promise<void>;
  openRewind(): void;
  compact(): Promise<void>;
  agent: { runTurn(prompt: string): Promise<TurnRecord> };
  screen: Record<string, unknown>;
  keyboard: { deliver(key: Key): void; set(handler: KeyHandler): void; handler: KeyHandler };
};

// An App with one message in its session, and a screen that draws nothing.
function app() {
  const session = Session.create(realpathSync(mkdtempSync(join(tmpdir(), "clue-app-mode-"))));
  session.ephemeral = true;
  session.appendMessage({ role: "user", content: "fix it" });
  const inside = new App({ settings: loadSettings(), session, resumed: false }) as unknown as Inside;
  inside.load(session);
  for (const name of ["commit", "refresh", "setRenderer", "status", "flush", "animate"]) inside.screen[name] = () => {};
  inside.idle();
  const type = (...keys: Key[]) => keys.forEach((key) => inside.keyboard.deliver(key));
  return { inside, type };
}

// A command that runs until the test lets it finish.
function pending() {
  let finish = () => {};
  const work = new Promise<void>((resolve) => (finish = resolve));
  return { work, finish };
}

const record = (prompt: string): TurnRecord => ({
  prompt,
  startedAt: Date.now(),
  ms: 10,
  firstTokenMs: null,
  tools: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 },
  cost: 0,
  model: loadSettings().model,
  stop: "end_turn",
});

test("a prompt typed during a command starts its turn after the command, and the turn keeps the keyboard", async () => {
  const { inside, type } = app();
  const compact = pending();
  inside.compact = () => compact.work;
  const turnHandler: KeyHandler = () => {};
  const started: string[] = [];
  inside.runTurn = async (prompt) => {
    started.push(prompt);
    inside.keyboard.set(turnHandler);
    await new Promise(() => {});
  };
  const done = inside.submit("/compact");
  type(char("h"), char("i"), ENTER);
  expect(started).toEqual([]);
  compact.finish();
  await done;
  expect(started).toEqual(["hi"]);
  expect(inside.keyboard.handler).toBe(turnHandler);
});

test("a queued command runs in command mode after the turn, so Enter waits instead of steering", async () => {
  const { inside, type } = app();
  const compact = pending();
  inside.compact = () => compact.work;
  const prompts: string[] = [];
  inside.agent.runTurn = async (prompt) => {
    prompts.push(prompt);
    return record(prompt);
  };
  inside.queued = { text: "/compact", images: [] };
  await inside.runTurn("go", []);
  type(char("x"), ENTER);
  expect(inside.steering).toBeNull();
  expect(inside.mode).toBe("command");
  expect(prompts).toEqual(["go"]);
  compact.finish();
  await Bun.sleep(20);
  expect(prompts).toEqual(["go", "x"]);
  expect(inside.mode).toBe("idle");
});

test("ctrl+c cancels an option list, like esc", async () => {
  const { inside, type } = app();
  await inside.submit("/effort");
  expect(inside.optionPicker).not.toBeNull();
  type(CTRL_C);
  expect(inside.optionPicker).toBeNull();
  expect(inside.mode).toBe("idle");
});

test("ctrl+c cancels the rewind list, like esc", () => {
  const { inside, type } = app();
  inside.openRewind();
  expect(inside.rewindPicker).not.toBeNull();
  type(CTRL_C);
  expect(inside.rewindPicker).toBeNull();
  expect(inside.mode).toBe("idle");
});

test("ctrl+c cancels the /resume list", async () => {
  let handler: KeyHandler = () => {};
  const screen = { setRenderer() {}, refresh() {}, flush() {} };
  const keyboard = { set: (next: KeyHandler) => (handler = next) };
  const choice = pickSession(screen as never, keyboard as never, mkdtempSync(join(tmpdir(), "clue-app-resume-")));
  handler(CTRL_C);
  expect(await choice).toBeNull();
});

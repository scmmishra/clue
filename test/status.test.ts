import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, paths, saveSetting } from "../src/config";
import { Screen, type Key } from "../src/ui/screen";
import { shouldRing, statusReport, turnStatus, type ProgramStatus } from "../src/ui/status";
import { TurnView } from "../src/ui/turn";
import { startMockApi } from "./mock-api";

const capture = () => {
  const out = { text: "", write: (chunk: string) => ((out.text += chunk), true) };
  return { out, screen: new Screen(out as unknown as NodeJS.WriteStream) };
};

test("each status is one OSC 7501 report that names clue", () => {
  expect(statusReport("idle")).toBe("\x1b]7501;state=idle:app=clue\x1b\\");
  expect(statusReport("working")).toBe("\x1b]7501;state=working:app=clue\x1b\\");
  expect(statusReport("done")).toBe("\x1b]7501;state=done:app=clue\x1b\\");
  expect(statusReport("error")).toBe("\x1b]7501;state=error:app=clue\x1b\\");
  expect(statusReport("blocked-permission")).toBe("\x1b]7501;state=blocked:kind=permission:app=clue\x1b\\");
  expect(statusReport("blocked-question")).toBe("\x1b]7501;state=blocked:kind=question:app=clue\x1b\\");
});

test("clear removes the record, so it names no app", () => {
  expect(statusReport("clear")).toBe("\x1b]7501;state=clear\x1b\\");
});

test("a finished turn reports done, an interrupted one idle and a failed one error", () => {
  expect(turnStatus({ stop: "end_turn" })).toBe("done");
  expect(turnStatus({ stop: "refusal" })).toBe("done");
  expect(turnStatus({ stop: "interrupted" })).toBe("idle");
  expect(turnStatus(null)).toBe("error");
});

test("the screen writes a report, even while a full-screen view owns the terminal", () => {
  const { out, screen } = capture();
  screen.status("working");
  screen.suspend();
  screen.status("done");
  expect(out.text).toContain(statusReport("working"));
  expect(out.text).toContain(statusReport("done"));
});

test("a permission prompt reports blocked until it is answered", async () => {
  const { out, screen } = capture();
  const view = new TurnView(screen);
  const answer = view.confirm("Run deploy?", "deploy", "deploy *");
  expect(out.text).toContain(statusReport("blocked-permission"));
  expect(out.text).not.toContain(statusReport("working"));
  view.handleKey({ name: "char", text: "y" });
  expect(await answer).toBe("once");
  expect(out.text.endsWith(statusReport("working"))).toBe(true);
});

test("a question reports blocked until it is answered or dismissed", async () => {
  const { out, screen } = capture();
  const view = new TurnView(screen);
  const answer = view.question({ question: "Which one?", options: [{ label: "first" }] });
  expect(out.text).toContain(statusReport("blocked-question"));
  view.handleKey({ name: "escape" });
  expect(await answer).toBeNull();
  expect(out.text).toContain(statusReport("working"));
});

test("clue rings when it needs you, and after long unattended work", () => {
  expect(shouldRing("blocked-permission", 0)).toBe(true);
  expect(shouldRing("blocked-question", 0)).toBe(true);
  expect(shouldRing("done", 29_999)).toBe(false);
  expect(shouldRing("done", 30_000)).toBe(true);
  expect(shouldRing("error", 29_999)).toBe(false);
  expect(shouldRing("error", 30_000)).toBe(true);
});

test("clue never rings for idle, working or clear, however long it took", () => {
  for (const status of ["idle", "working", "clear"] as const) expect(shouldRing(status, 3_600_000)).toBe(false);
});

test("the screen rings after the report, and only when the bell is on", () => {
  const { out, screen } = capture();
  screen.status("blocked-permission");
  expect(out.text).toBe(statusReport("blocked-permission"));

  out.text = "";
  screen.bell = true;
  screen.status("blocked-permission");
  expect(out.text).toBe(`${statusReport("blocked-permission")}\x07`);

  out.text = "";
  screen.status("done", 1000);
  expect(out.text).toBe(statusReport("done"));

  out.text = "";
  screen.status("done", 30_000);
  expect(out.text).toBe(`${statusReport("done")}\x07`);
});

test("answering a prompt restarts the unattended time", async () => {
  const { screen } = capture();
  const view = new TurnView(screen);
  const answer = view.confirm("Run deploy?", "deploy", "deploy *");
  await Bun.sleep(40);
  expect(view.unattendedMs).toBeGreaterThan(30);
  view.handleKey({ name: "char", text: "y" });
  await answer;
  expect(view.unattendedMs).toBeLessThan(30);
});

test("the bell defaults to on and settings.json can turn it off", async () => {
  expect(loadSettings().bell).toBe(true);
  await saveSetting("bell", false);
  expect(loadSettings().bell).toBe(false);
  rmSync(paths.settings);
});

const runSession = async (settings?: object) => {
  const server = startMockApi();
  const home = mkdtempSync(join(tmpdir(), "clue-status-home-"));
  if (settings) writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 100, rows: 30, data: (_terminal, data) => (output += decoder.decode(data, { stream: true })) });
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "--permission-mode", "ask"], {
    cwd: mkdtempSync(join(tmpdir(), "clue-status-")),
    env: { ...process.env, SHELL: "/bin/sh", CLUE_HOME: home, ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "" },
    terminal,
  });
  const until = async (status: ProgramStatus) => {
    const deadline = Date.now() + 8000;
    while (!output.includes(statusReport(status)) && Date.now() < deadline) await Bun.sleep(10);
    expect(output, `waiting for ${status}`).toContain(statusReport(status));
  };

  await until("idle");
  terminal.write("please push");
  await Bun.sleep(50);
  terminal.write("\r");
  await until("blocked-permission");
  terminal.write("y");
  await until("done");
  terminal.write("\x04");
  await proc.exited;
  terminal.close();
  server.stop(true);
  return output;
};

test("clue reports each state to the terminal across a real session, and rings once for the prompt", async () => {
  const output = await runSession();
  const reports = [...output.matchAll(/\x1b\]7501;state=([a-z]+(?::kind=[a-z]+)?)/g)].map((match) => match[1]);
  expect(reports).toEqual(["idle", "working", "blocked:kind=permission", "working", "done", "clear"]);
  expect(output.split("\x07").length - 1).toBe(1);
}, 15_000);

test("a session with the bell off never rings", async () => {
  const output = await runSession({ bell: false });
  expect(output).toContain(statusReport("blocked-permission"));
  expect(output).not.toContain("\x07");
}, 15_000);

const fruits = { question: "Which fruits?", options: [{ label: "apple" }, { label: "mango" }, { label: "kiwi" }], multiple: true };
const press = (view: TurnView, ...keys: Key[]) => keys.forEach((key) => view.handleKey(key));
const typed = (text: string): Key[] => [...text].map((char) => ({ name: "char", text: char }));
const down: Key = { name: "down" };
const space: Key = { name: "char", text: " " };
const enter: Key = { name: "enter" };

test("a typed answer adds to the picked options, in the order of the list", async () => {
  const view = new TurnView(capture().screen);
  const answer = view.question(fruits);
  press(view, down, down, space);
  press(view, { name: "up" }, space);
  press(view, ...typed("banana"), enter);
  expect(await answer).toBe("mango, kiwi, banana");
});

test("a typed answer with nothing picked is sent alone", async () => {
  const view = new TurnView(capture().screen);
  const answer = view.question(fruits);
  press(view, ...typed("banana"), enter);
  expect(await answer).toBe("banana");
});

test("an empty typed answer still sends the picked options", async () => {
  const view = new TurnView(capture().screen);
  const answer = view.question(fruits);
  press(view, down, space, { name: "up" }, { name: "up" }, { name: "up" });
  press(view, enter);
  press(view, enter);
  expect(await answer).toBe("mango");
});

test("an empty typed answer with nothing picked keeps waiting", () => {
  const { out, screen } = capture();
  const view = new TurnView(screen);
  void view.question(fruits);
  press(view, { name: "up" }, enter, enter);
  expect(out.text).not.toContain(statusReport("working"));
});

test("going back from typing keeps the picks", async () => {
  const view = new TurnView(capture().screen);
  const answer = view.question(fruits);
  press(view, down, space, ...typed("x"), { name: "escape" }, down, space, enter);
  expect(await answer).toBe("mango, kiwi");
});

test("a typed answer to a single-choice question is sent alone", async () => {
  const view = new TurnView(capture().screen);
  const answer = view.question({ question: "Which?", options: [{ label: "apple" }] });
  press(view, ...typed("banana"), enter);
  expect(await answer).toBe("banana");
});

test("while typing, the hint says what the keys do then", () => {
  const { screen } = capture();
  const view = new TurnView(screen);
  void view.question(fruits);
  const hint = () => (view as unknown as { liveLines(): string[] }).liveLines().at(-1)!;
  expect(Bun.stripANSI(hint())).toContain("space pick");
  press(view, ...typed("b"));
  expect(Bun.stripANSI(hint())).toBe("  enter send · esc back to the list");
});

const multiLine = "Run cat > a <<'EOF'\none\ntwo\nEOF?";
const frameOf = (view: TurnView) => (view as unknown as { frame(): { lines: string[]; cursor?: { row: number } } }).frame();

test("every live row is one line, so a redraw erases exactly what it drew", () => {
  const view = new TurnView(capture().screen);
  void view.confirm(multiLine, "x", "x *");
  const { lines } = frameOf(view);
  expect(lines.every((line) => !line.includes("\n"))).toBe(true);
});

test("a permission prompt still shows the whole command", () => {
  const view = new TurnView(capture().screen);
  void view.confirm(multiLine, "x", "x *");
  const text = frameOf(view).lines.map((line) => Bun.stripANSI(line)).join("\n");
  for (const part of ["Run cat > a <<'EOF'", "one", "two", "EOF?"]) expect(text).toContain(part);
});

test("the input's cursor stays on the input under a tall turn", () => {
  const { screen } = capture();
  const composer = () => ({ lines: ["┃ ", "", "status"], cursor: { row: 0, col: 2 } });
  const view = new TurnView(screen, composer);
  view.toolStart("1", "Running a\nb\nc", "command");
  const { lines, cursor } = frameOf(view);
  expect(Bun.stripANSI(lines[cursor!.row])).toBe("┃ ");
});

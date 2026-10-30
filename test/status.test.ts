import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Screen } from "../src/ui/screen";
import { statusReport, turnStatus, type ProgramStatus } from "../src/ui/status";
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

test("clue reports each state to the terminal across a real session", async () => {
  const server = startMockApi();
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 100, rows: 30, data: (_terminal, data) => (output += decoder.decode(data, { stream: true })) });
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "--permission-mode", "ask"], {
    cwd: mkdtempSync(join(tmpdir(), "clue-status-")),
    env: { ...process.env, SHELL: "/bin/sh", CLUE_HOME: mkdtempSync(join(tmpdir(), "clue-status-home-")), ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "" },
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

  const reports = [...output.matchAll(/\x1b\]7501;state=([a-z]+(?::kind=[a-z]+)?)/g)].map((match) => match[1]);
  expect(reports).toEqual(["idle", "working", "blocked:kind=permission", "working", "done", "clear"]);
}, 15_000);

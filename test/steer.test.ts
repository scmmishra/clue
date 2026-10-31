import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitsServerTool } from "../src/agent/loop";
import { Session, steerText, type MessageParam } from "../src/session";
import { detailLines, replay, sessionEntries } from "../src/ui/replay";

const result = { type: "tool_result", tool_use_id: "a", content: "x" } as const;

test("a server tool without its result holds back a steer, and one with it doesn't", () => {
  const search = { type: "server_tool_use", id: "s", name: "web_search", input: {} };
  const found = { type: "web_search_tool_result", tool_use_id: "s", content: [] };
  const read = { type: "tool_use", id: "a", name: "read_file", input: {} };
  expect(awaitsServerTool([search, read] as never)).toBe(true);
  expect(awaitsServerTool([search, found, read] as never)).toBe(false);
  expect(awaitsServerTool([read] as never)).toBe(false);
});

test("steer text is the text that rides along with tool results", () => {
  expect(steerText({ role: "user", content: [result, { type: "text", text: "go left" }] })).toBe("go left");
  expect(steerText({ role: "user", content: [result] })).toBeNull();
  expect(steerText({ role: "user", content: [{ type: "text", text: "a prompt" }] })).toBeNull();
  expect(steerText({ role: "user", content: "a prompt" })).toBeNull();
  expect(steerText({ role: "assistant", content: [{ type: "text", text: "reply" }] })).toBeNull();
});

function steered() {
  const session = Session.create(realpathSync(mkdtempSync(join(tmpdir(), "clue-steer-"))));
  const messages: MessageParam[] = [
    { role: "user", content: "fix it" },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read_file", input: {} }] },
    { role: "user", content: [result, { type: "text", text: "use the other file" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  for (const message of messages) session.appendMessage(message);
  return session;
}

test("a resumed session shows the steer after the tools it followed, as the user's own line", () => {
  const session = steered();
  expect(sessionEntries(session).map((entry) => entry.type)).toEqual(["prompt", "tools", "steer", "text"]);
  for (const lines of [replay(session).lines, detailLines(session)]) {
    expect(lines.map((line) => Bun.stripANSI(line)).join("\n")).toContain("┃ use the other file");
  }
});

test("a steer is part of its turn, so rewind doesn't list it", () => {
  expect(steered().rewindPoints.map((point) => point.text)).toEqual(["fix it"]);
});

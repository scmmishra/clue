import { expect, test } from "bun:test";
import { Session } from "../src/session";
import { RESUME_SCROLLBACK_BYTES, replay } from "../src/ui/replay";

function session(prompts: number, size = 10) {
  const result = new Session("resume-test", "/tmp/project");
  result.ephemeral = true;
  for (let index = 0; index < prompts; index++) {
    result.appendMessage({ role: "user", content: `prompt number ${index}` });
    result.appendMessage({ role: "assistant", content: [{ type: "text", text: "x".repeat(size) }] });
  }
  return result;
}

const text = (lines: string[]) => Bun.stripANSI(lines.join("\n"));
const size = (lines: string[]) => lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);

test("resume keeps up to a megabyte", () => {
  expect(RESUME_SCROLLBACK_BYTES).toBe(1024 * 1024);
});

test("with no cap, everything is rendered and nothing is hidden", () => {
  const { lines, hidden } = replay(session(50));
  expect(text(lines)).toContain("prompt number 0");
  expect(text(lines)).toContain("prompt number 49");
  expect(hidden).toBe(0);
});

test("a session under the cap comes back whole", () => {
  const { lines, hidden } = replay(session(50), RESUME_SCROLLBACK_BYTES);
  expect(text(lines)).toContain("prompt number 0");
  expect(hidden).toBe(0);
});

test("a session over the cap keeps its end, within the cap", () => {
  const { lines, hidden } = replay(session(50, 200), 2000);
  expect(text(lines)).toContain("prompt number 49");
  expect(text(lines)).not.toContain("prompt number 0\n");
  expect(hidden).toBeGreaterThan(0);
  expect(size(lines)).toBeLessThanOrEqual(2000);
});

test("the cap counts bytes, so wide characters can't overrun it", () => {
  const wide = new Session("resume-wide", "/tmp/project");
  wide.ephemeral = true;
  for (let index = 0; index < 40; index++) wide.appendMessage({ role: "user", content: "日本語".repeat(40) });
  expect(size(replay(wide, 1000).lines)).toBeLessThanOrEqual(1000);
});

test("a last entry bigger than the cap still shows its end", () => {
  const { lines, hidden } = replay(session(1, 40), 30);
  expect(lines.length).toBeGreaterThan(0);
  expect(hidden).toBeGreaterThan(0);
});

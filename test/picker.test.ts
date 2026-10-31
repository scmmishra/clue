import { expect, test } from "bun:test";
import type { SessionMeta } from "../src/session";
import { sessionRow } from "../src/ui/picker";

const meta = (overrides: Partial<SessionMeta> = {}) =>
  ({
    id: "mvw6xkyk-hukv",
    cwd: "/Users/someone/code/projects/clue",
    name: null,
    title: "fix the flaky spec",
    updated: Date.now(),
    prompts: 3,
    ...overrides,
  }) as SessionMeta;
const row = (session: SessionMeta, active = false, max = 100) => Bun.stripANSI(sessionRow(session, 13, max, active));

test("a row leads with the ID, and leaves out the folder, which every row shares", () => {
  const text = row(meta());
  expect(text.trim().startsWith("mvw6xkyk-hukv")).toBe(true);
  expect(text).toContain("fix the flaky spec");
  expect(text).not.toContain("clue");
});

test("a named session leads with its name", () => {
  const text = row(meta({ name: "auth-work" }));
  expect(text.trim().startsWith("auth-work")).toBe(true);
  expect(text).not.toContain("mvw6xkyk-hukv");
});

test("the selected row is marked", () => {
  expect(row(meta(), true).trim().startsWith("›")).toBe(true);
});

test("a row fits the width", () => {
  const long = meta({ title: "x".repeat(300) });
  expect(Bun.stringWidth(row(long, false, 80))).toBeLessThanOrEqual(80);
});

test("an empty session still has a title", () => {
  expect(row(meta({ title: "" }))).toContain("(empty)");
});

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseReviewer, reviewAction } from "../src/permissions";
import { resetReviewers, reviewers, startMockApi } from "./mock-api";

const KEY = "sk-or-test";
const HAIKU = { provider: "anthropic", model: "claude-haiku-5-5" } as const;
const SONNET = { provider: "anthropic", model: "claude-sonnet-5-5" } as const;
const JEV = { provider: "openrouter", model: "typesafe/jev-1.14" } as const;

test.each([
  ["nothing set, no key", undefined, undefined, HAIKU],
  ["nothing set, with a key", undefined, KEY, JEV],
  ["anthropic alone, with a key", { provider: "anthropic" }, KEY, HAIKU],
  ["openrouter alone", { provider: "openrouter" }, KEY, JEV],
  ["a short model name", { provider: "anthropic", model: "sonnet" }, undefined, SONNET],
  ["a versioned short name", { provider: "anthropic", model: "haiku-5-5" }, undefined, HAIKU],
  ["a full model id", { provider: "anthropic", model: "claude-sonnet-5-5" }, undefined, SONNET],
  ["jev", { provider: "openrouter", model: "jev" }, KEY, JEV],
  ["typesafe/jev", { provider: "openrouter", model: "typesafe/jev" }, KEY, JEV],
  ["a pinned jev", { provider: "openrouter", model: "typesafe/jev-1.14" }, KEY, JEV],
  ["a model alone picks anthropic", { model: "haiku" }, KEY, HAIKU],
  ["a model alone picks openrouter", { model: "jev" }, KEY, JEV],
])("%s", (_name, review, key, expected) => {
  expect(chooseReviewer(review as never, key)).toEqual(expected);
});

test.each([
  ["openrouter with a Claude model", { provider: "openrouter", model: "haiku" }, KEY],
  ["anthropic with jev", { provider: "anthropic", model: "jev" }, KEY],
  ["openrouter with no key", { provider: "openrouter" }, undefined],
  ["an unknown model", { provider: "anthropic", model: "gpt-9" }, undefined],
  ["an unknown provider", { provider: "acme" }, undefined],
])("%s can't be used", (_name, review, key) => {
  expect(() => chooseReviewer(review as never, key)).toThrow();
});

let server: ReturnType<typeof startMockApi>;
const saved = { ...process.env };

beforeAll(() => {
  server = startMockApi();
  process.env.ANTHROPIC_BASE_URL = process.env.OPENROUTER_BASE_URL = server.url.origin;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});
afterAll(() => {
  server.stop(true);
  for (const name of ["ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});
beforeEach(() => {
  resetReviewers();
  process.env.OPENROUTER_API_KEY = KEY;
});
afterEach(resetReviewers);

const review = (setting?: object, signal = new AbortController().signal) => reviewAction("shell", { command: "deploy" }, "ship it", setting as never, signal);

test("anthropic reviews with Haiku at low effort, and OpenRouter never hears of it", async () => {
  expect(await review({ provider: "anthropic" })).toEqual({ approved: true, reviewer: "haiku" });
  expect(reviewers.claudeCalls).toEqual([{ model: "claude-haiku-5-5", effort: "low" }]);
  expect(reviewers.jevCalls).toEqual([]);
});

test("openrouter reviews with Jev", async () => {
  expect(await review({ provider: "openrouter" })).toEqual({ approved: true, reviewer: "jev" });
  expect(reviewers.jevCalls).toEqual([{ model: "typesafe/jev-1.14" }]);
  expect(reviewers.claudeCalls).toEqual([]);
});

test("the chosen Claude model does the review", async () => {
  await review({ provider: "anthropic", model: "sonnet" });
  expect(reviewers.claudeCalls.map((call) => call.model)).toEqual(["claude-sonnet-5-5"]);
});

test("a flag is a decision, so it stands and nothing else is asked", async () => {
  reviewers.jev = "caution";
  const result = await review({ provider: "openrouter" });
  expect(result.approved).toBe(false);
  expect(result.reviewer).toBe("jev");
  expect(reviewers.claudeCalls).toEqual([]);
});

test("a Claude reviewer's flag keeps its reason", async () => {
  reviewers.decision = "caution";
  expect(await review({ provider: "anthropic" })).toEqual({ approved: false, reviewer: "haiku", reason: "the reviewer's reason" });
});

test("when Jev breaks, Haiku at low effort reviews instead, and the label says so", async () => {
  reviewers.jev = "error";
  expect(await review({ provider: "openrouter" })).toEqual({ approved: true, reviewer: "haiku (jev failed)" });
  expect(reviewers.claudeCalls).toEqual([{ model: "claude-haiku-5-5", effort: "low" }]);
});

test("Jev's answer that is neither clear nor caution counts as broken", async () => {
  reviewers.jev = "banana";
  expect((await review({ provider: "openrouter" })).reviewer).toBe("haiku (jev failed)");
});

test("when another Claude model breaks, Haiku reviews instead", async () => {
  reviewers.failing.add("claude-sonnet-5-5");
  expect(await review({ provider: "anthropic", model: "sonnet" })).toEqual({ approved: true, reviewer: "haiku (sonnet failed)" });
});

test("a setting that can't work falls back to Haiku", async () => {
  expect((await review({ provider: "openrouter", model: "haiku" })).approved).toBe(true);
  expect(reviewers.claudeCalls.map((call) => call.model)).toEqual(["claude-haiku-5-5"]);
  expect(reviewers.jevCalls).toEqual([]);
});

test("a fallback's flag still holds the action", async () => {
  reviewers.jev = "error";
  reviewers.decision = "caution";
  const result = await review({ provider: "openrouter" });
  expect(result.approved).toBe(false);
  expect(result.reason).toBe("the reviewer's reason");
});

test("when the fallback breaks too, the action is held and says why", async () => {
  reviewers.jev = "error";
  reviewers.failing.add("claude-haiku-5-5");
  const result = await review({ provider: "openrouter" });
  expect(result.approved).toBe(false);
  expect(result.reason).toContain("the review could not finish");
  expect(result.reason).toContain("limit reached");
});

test("when Haiku is the choice and breaks, it isn't asked twice", async () => {
  reviewers.failing.add("claude-haiku-5-5");
  const result = await review({ provider: "anthropic" });
  expect(result.approved).toBe(false);
  expect(reviewers.claudeCalls).toHaveLength(1);
});

test("an interrupt stops the review, with no fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await review({ provider: "openrouter" }, controller.signal);
  expect(result.approved).toBe(false);
  expect(reviewers.claudeCalls).toEqual([]);
});

test("clue reads the review setting from settings.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "clue-review-home-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ review: { provider: "anthropic", model: "sonnet" } }));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "ask", "please push"], {
    cwd: mkdtempSync(join(tmpdir(), "clue-review-")),
    env: { ...process.env, SHELL: "/bin/sh", CLUE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  expect(reviewers.claudeCalls.map((call) => call.model)).toEqual(["claude-sonnet-5-5"]);
  expect(reviewers.jevCalls).toEqual([]);
}, 20_000);

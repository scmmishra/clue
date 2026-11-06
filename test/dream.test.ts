import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/config";
import { keepGuidance } from "../src/dream/filter";
import { collectMoments, repoRoot, type Moment } from "../src/dream/moments";
import { decide, loadDream, saveDream, type Dream } from "../src/dream/store";
import { propose } from "../src/dream/synthesize";
import { projectKey } from "../src/session";

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });

const repo = realpathSync(mkdtempSync(join(tmpdir(), "clue-dream-repo-")));
git(repo, "init", "-q");
git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
const worktree = `${repo}-wt`;
git(repo, "worktree", "add", "-q", worktree);
const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "clue-dream-elsewhere-")));
const claudeHome = mkdtempSync(join(tmpdir(), "clue-dream-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeHome;

const user = (text: string) => ({ t: "message", message: { role: "user", content: text } });
const agent = (text: string) => ({ t: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

function clueSession(cwd: string, id: string, records: object[]) {
  const dir = join(paths.sessions, projectKey(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const lines = [{ t: "session", id, cwd, created: 0, version: "test" }, ...records];
  writeFileSync(file, `${lines.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

function claudeCodeSession(cwd: string, id: string, records: object[]) {
  const dir = join(claudeHome, "projects", projectKey(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `${records.map((record) => JSON.stringify({ cwd, ...record })).join("\n")}\n`);
  return file;
}

// Only this file's session folders go. The sessions folder also holds the index, which other
// tests keep open.
beforeEach(() => {
  for (const cwd of [repo, worktree, elsewhere, join(repo, "gone")])
    rmSync(join(paths.sessions, projectKey(cwd)), { recursive: true, force: true });
  rmSync(paths.dreams, { recursive: true, force: true });
  rmSync(join(claudeHome, "projects"), { recursive: true, force: true });
});

test("a worktree belongs to the repo of its main worktree", () => {
  expect(repoRoot(worktree)).toBe(repo);
  expect(repoRoot(join(repo))).toBe(repo);
  expect(repoRoot(elsewhere)).toBeNull();
});

test("moments are the follow-up messages of the repo's sessions, without short replies", () => {
  const file = clueSession(worktree, "a", [
    user("fix the flaky spec"),
    agent("I'll add a retry around the spec."),
    user("don't add retries, freeze time instead"),
    agent("Done."),
    user("commit it"),
  ]);
  clueSession(elsewhere, "b", [user("first"), agent("ok"), user("never use tabs in this file")]);
  const { sessions, typed, moments, latest } = collectMoments(repo, {}, false);
  expect(sessions).toBe(1);
  expect(typed).toBe(2);
  expect(moments.map((moment) => [moment.text, moment.before])).toEqual([
    ["don't add retries, freeze time instead", "I'll add a retry around the spec."],
  ]);
  expect(latest).toEqual({ [file]: 3 });
});

test("a removed folder inside the repo still counts", () => {
  clueSession(join(repo, "gone"), "a", [user("start"), agent("ok"), user("keep the change in one file")]);
  expect(collectMoments(repo, {}, false).moments).toHaveLength(1);
});

test("a later dream starts after the messages an earlier one read", () => {
  const file = clueSession(repo, "a", [
    user("start"),
    agent("ok"),
    user("prefer one data structure"),
    agent("ok"),
    user("don't touch the mailer"),
  ]);
  expect(collectMoments(repo, { [file]: 2 }, false).moments.map((moment) => moment.text)).toEqual([
    "don't touch the mailer",
  ]);
});

test("Claude Code transcripts are read only with the flag, without tool results and reminders", () => {
  claudeCodeSession(repo, "s1", [
    { type: "user", message: { content: "add the endpoint" }, timestamp: "2026-10-21T10:00:00Z" },
    { type: "assistant", message: { content: [{ type: "text", text: "I created a new branch." }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "user", isSidechain: true, message: { content: "a subagent's prompt, long enough" } },
    {
      type: "user",
      message: { content: "No new branch unless I ask <system-reminder>noise</system-reminder>" },
      timestamp: "2026-10-21T10:05:00Z",
    },
  ]);
  expect(collectMoments(repo, {}, false).moments).toHaveLength(0);
  const [moment] = collectMoments(repo, {}, true).moments;
  expect(moment.text).toBe("No new branch unless I ask");
  expect(moment.before).toBe("I created a new branch.");
  expect(moment.at).toBe(Date.parse("2026-10-21T10:05:00Z"));
});

test("approving a proposal replaces the memory it names, and rejecting one remembers it", () => {
  const dream: Dream = {
    repo,
    memories: [{ text: "Commit only when asked.", evidence: [], approvedAt: 0 }],
    pending: [
      { text: "Commit or push only when the user asks.", evidence: [], replaces: "Commit only when asked." },
      { text: "Keep abstractions clean.", evidence: [], replaces: null },
      { text: "Stay on the current branch.", evidence: [], replaces: null },
    ],
    rejected: [],
    read: {},
  };
  decide(dream, "approve");
  decide(dream, "reject");
  decide(dream, "skip");
  expect(dream.memories.map((memory) => memory.text)).toEqual(["Commit or push only when the user asks."]);
  expect(dream.rejected).toEqual(["Keep abstractions clean."]);
  expect(dream.pending.map((proposal) => proposal.text)).toEqual(["Stay on the current branch."]);
  const markdown = saveDream(dream);
  expect(readFileSync(markdown, "utf8")).toBe(`# Dream for ${repo}\n\n- Commit or push only when the user asks.\n`);
  expect(loadDream(repo)).toEqual(dream);
});

// A stand-in for OpenRouter's decisions endpoint and Claude's API.
const api = {
  guidance: new Set<string>(),
  failing: new Set<string>(),
  proposals: [] as object[],
  claudeBody: null as unknown,
};
let server: ReturnType<typeof Bun.serve>;
const saved = { ...process.env };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request.json()) as { state?: string };
      if (url.pathname.endsWith("/api/alpha/decisions")) {
        const said = (JSON.parse(body.state ?? "{}") as { user_said: string }).user_said;
        if (api.failing.has(said)) return Response.json({ error: { message: "limit reached" } }, { status: 500 });
        return Response.json({ answers: { kind: { choice: api.guidance.has(said) ? "guidance" : "other" } } });
      }
      api.claudeBody = body;
      return Response.json({
        id: "msg_dream",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: JSON.stringify({ proposals: api.proposals }) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 100 },
      });
    },
  });
  process.env.ANTHROPIC_BASE_URL = process.env.OPENROUTER_BASE_URL = server.url.origin;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.OPENROUTER_API_KEY = "sk-or-test";
});
afterAll(() => {
  server.stop(true);
  for (const name of ["ANTHROPIC_BASE_URL", "OPENROUTER_BASE_URL", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(worktree, { recursive: true, force: true });
});

const moment = (index: number, text: string): Moment => ({
  id: `clue:/s.jsonl#${index}`,
  source: "clue",
  file: "/s.jsonl",
  index,
  at: Date.parse("2026-11-01T00:00:00Z"),
  before: "I added a guard for a locally edited file.",
  text,
});

test("Jev keeps guidance and reports the moments it couldn't judge", async () => {
  api.guidance = new Set(["don't handle cases nobody raised"]);
  api.failing = new Set(["this one hits a limit"]);
  const moments = [
    moment(2, "don't handle cases nobody raised"),
    moment(3, "now add the endpoint"),
    moment(4, "this one hits a limit"),
  ];
  const { kept, failed } = await keepGuidance(moments, "typesafe/jev-1.14", new AbortController().signal, () => {});
  expect(kept.map((item) => item.index)).toEqual([2]);
  expect(failed.map((item) => item.index)).toEqual([4]);
});

test("proposals carry the evidence they name and replace only approved memories", async () => {
  const moments = [
    moment(2, "don't handle cases nobody raised"),
    moment(3, "the chances are small, don't overoptimize"),
  ];
  api.proposals = [
    {
      memory: "Don't add handling for cases the user didn't raise.",
      replaces: "",
      evidence: [moments[1].id, "unknown", moments[0].id],
    },
    { memory: "Stay on the branch.", replaces: "A memory that was never approved", evidence: [moments[0].id] },
    { memory: "  ", replaces: "", evidence: [moments[0].id] },
    { memory: "Prefer one data structure.", replaces: "", evidence: ["unknown"] },
  ];
  const dream = loadDream(repo);
  dream.rejected = ["Keep abstractions clean."];
  const { proposals, cost } = await propose(moments, dream, new AbortController().signal);
  expect(proposals).toEqual([
    {
      text: "Don't add handling for cases the user didn't raise.",
      replaces: null,
      evidence: [
        { at: moments[1].at, text: moments[1].text },
        { at: moments[0].at, text: moments[0].text },
      ],
    },
    { text: "Stay on the branch.", replaces: null, evidence: [{ at: moments[0].at, text: moments[0].text }] },
  ]);
  expect(cost).toBeGreaterThan(0);
  const sent = JSON.parse((api.claudeBody as { messages: { content: string }[] }).messages[0].content);
  expect(sent.rejected).toEqual(["Keep abstractions clean."]);
  expect(sent.moments[0]).toEqual({
    id: moments[0].id,
    date: "2026-11-01",
    agent_said: moments[0].before,
    user_said: moments[0].text,
  });
  expect(existsSync(paths.dreams)).toBe(false);
});

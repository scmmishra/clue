import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseCopy, lastReply, splitBlocks } from "../src/copy";
import type { MessageParam } from "../src/session";
import { writeClipboard } from "../src/ui/clipboard";

const F = "```";

const REPLY = `Generate the migration first:

${F}sh
bin/rails g migration AddArchivedAt
${F}

Then add the index. Without it, the filter scans the whole table.

${F}ruby
add_index :conversations, :archived_at
${F}

- Run it locally.
- Push after the tests pass.`;

test("a reply splits into code blocks, paragraphs and list items", () => {
  const blocks = splitBlocks(REPLY);
  expect(blocks.map((block) => [block.id, block.kind, block.language])).toEqual([
    ["b1", "code", "sh"],
    ["b2", "paragraph", undefined],
    ["b3", "code", "ruby"],
    ["b4", "list item", undefined],
    ["b5", "list item", undefined],
  ]);
  expect(blocks[0].copy).toBe("bin/rails g migration AddArchivedAt");
  expect(blocks[0].text).toStartWith(`${F}sh\n`);
});

test("a lead-in line and a heading label the block after them", () => {
  const blocks = splitBlocks(`## Before\n\n${F}ts\nold()\n${F}\n\n${REPLY}`);
  expect(blocks[0]).toMatchObject({ kind: "code", label: "## Before", copy: "old()" });
  expect(blocks[1]).toMatchObject({ kind: "code", label: "Generate the migration first:" });
  expect(blocks.some((block) => block.kind === "heading")).toBe(false);
});

test("a long paragraph that ends in a colon stays a block", () => {
  const long = `${"word ".repeat(30)}:`;
  expect(splitBlocks(`${long}\n\n${F}\nx\n${F}`).map((block) => block.kind)).toEqual(["paragraph", "code"]);
});

test("a fence inside a list item loses the item's indent", () => {
  const blocks = splitBlocks(`- Run this:\n\n  ${F}sh\n  bun test\n    --watch\n  ${F}`);
  expect(blocks[1]).toMatchObject({ kind: "code", copy: "bun test\n  --watch" });
});

test("a longer fence holds a shorter one, and an open fence runs to the end", () => {
  const nested = splitBlocks(`${F}\`md\n${F}sh\nls\n${F}\n${F}\`\n\nafter`);
  expect(nested.map((block) => block.kind)).toEqual(["code", "paragraph"]);
  expect(nested[0].copy).toBe(`${F}sh\nls\n${F}`);
  expect(splitBlocks(`${F}sh\nls\npwd`)[0].copy).toBe("ls\npwd");
});

test("an indented line continues the list item above it", () => {
  const blocks = splitBlocks("- first\n  more of the first\n- second");
  expect(blocks.map((block) => block.copy)).toEqual(["- first\n  more of the first", "- second"]);
});

const text = (value: string) => ({ type: "text" as const, text: value });

test("the last reply is the assistant text since the last prompt", () => {
  const messages: MessageParam[] = [
    { role: "user", content: "first prompt" },
    { role: "assistant", content: [text("an old answer")] },
    { role: "user", content: [text("<context>clue's own</context>"), text("second prompt")] },
    {
      role: "assistant",
      content: [text("Let me look."), { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
    { role: "assistant", content: [text("Here is the fix.")] },
  ];
  expect(lastReply(messages)).toBe("Let me look.\n\nHere is the fix.");
  expect(lastReply([])).toBe("");
});

test("a bare /copy takes the whole reply", async () => {
  expect(await chooseCopy(REPLY, "")).toEqual({ text: REPLY, summary: "Copied the last reply, 14 lines." });
  expect(await chooseCopy("", "")).toEqual({ problem: "There's no reply to copy yet." });
});

test("the clipboard writer can be pointed at a file", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "clue-copy-")), "clip.txt");
  process.env.CLUE_TEST_CLIPBOARD_OUT = file;
  try {
    expect(await writeClipboard("héllo")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("héllo");
  } finally {
    delete process.env.CLUE_TEST_CLIPBOARD_OUT;
  }
});

// A stand-in for OpenRouter and Claude. Decider answers each block with the probability set for it.
const api = {
  yes: {} as Record<string, number>,
  deciderFails: false,
  deciderRequests: [] as { model?: string; questions: Record<string, unknown> }[],
  claudePicks: [] as string[],
  claudeRequests: 0,
  claudeModels: [] as string[],
};
let server: ReturnType<typeof Bun.serve>;
const saved = { ...process.env };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request.json()) as { model?: string; questions?: Record<string, unknown> };
      if (url.pathname.endsWith("/api/alpha/decisions")) {
        api.deciderRequests.push({ model: body.model, questions: body.questions ?? {} });
        if (api.deciderFails) return Response.json({ error: { message: "limit reached" } }, { status: 500 });
        const answers = Object.fromEntries(
          Object.keys(body.questions ?? {}).map((id) => {
            const yes = api.yes[id] ?? 0;
            return [id, { choice: yes >= 0.5 ? "yes" : "no", probabilities: { yes, no: 1 - yes } }];
          }),
        );
        return Response.json({ answers });
      }
      api.claudeRequests++;
      api.claudeModels.push((body as { model?: string }).model ?? "");
      return Response.json({
        id: "msg_copy",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [text(JSON.stringify({ blocks: api.claudePicks }))],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  });
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
  api.yes = {};
  api.deciderFails = false;
  api.deciderRequests.length = 0;
  api.claudePicks = [];
  api.claudeRequests = 0;
  api.claudeModels.length = 0;
  process.env.OPENROUTER_API_KEY = "sk-or-test";
});

test("Decider picks code at a lower cutoff than prose", async () => {
  api.yes = { b1: 0.65, b2: 0.8, b3: 0.55, b4: 0.9 };
  const choice = await chooseCopy(REPLY, "the commands");
  expect(choice).toEqual({
    text: "bin/rails g migration AddArchivedAt\n\n- Run it locally.",
    summary: "Copied 1 code block (sh) and 1 list item, 3 lines.",
    note: undefined,
  });
  expect(api.claudeRequests).toBe(0);
  expect(api.deciderRequests[0].model).toBe("perplexity/pplx-decider-v1.2");
  const question = api.deciderRequests[0].questions.b1 as { instructions: string };
  expect(question.instructions).toBe('The user typed "/copy the commands". Should block b1 go on the clipboard?');
});

test("a reply with more than 16 blocks takes more than one Decider request", async () => {
  const many = Array.from({ length: 20 }, (_, n) => `- item ${n + 1}`).join("\n");
  api.yes = { b20: 0.99 };
  expect(await chooseCopy(many, "the last item")).toMatchObject({ text: "- item 20" });
  expect(api.deciderRequests.map((request) => Object.keys(request.questions).length)).toEqual([16, 4]);
});

test("nothing that matches is a notice, and the clipboard stays as it was", async () => {
  expect(await chooseCopy(REPLY, "the python code")).toEqual({
    problem: 'Nothing in the last reply matches "the python code".',
  });
});

test("Haiku picks when there's no OpenRouter key", async () => {
  delete process.env.OPENROUTER_API_KEY;
  api.claudePicks = ["b3", "b1", "b9"];
  const choice = await chooseCopy(REPLY, "the code");
  expect(choice).toMatchObject({
    text: "bin/rails g migration AddArchivedAt\n\nadd_index :conversations, :archived_at",
    summary: "Copied 2 code blocks (sh, ruby), 3 lines.",
  });
  expect(api.deciderRequests).toHaveLength(0);
});

test("Haiku takes over when the decision model fails, and says so", async () => {
  api.deciderFails = true;
  api.claudePicks = ["b3"];
  expect(await chooseCopy(REPLY, "the index")).toEqual({
    text: "add_index :conversations, :archived_at",
    summary: "Copied 1 code block (ruby), 1 line.",
    note: "decider failed, so haiku picked: limit reached",
  });
});

test("list items next to each other stay one list", async () => {
  api.yes = { b1: 0.9, b4: 0.9, b5: 0.9 };
  expect(await chooseCopy(REPLY, "the command and the steps")).toMatchObject({
    text: "bin/rails g migration AddArchivedAt\n\n- Run it locally.\n- Push after the tests pass.",
  });
});

test("the copy setting picks the model", async () => {
  api.yes = { b3: 0.9 };
  await chooseCopy(REPLY, "the index", { model: "jev" });
  expect(api.deciderRequests[0].model).toBe("typesafe/jev-1.14");
  api.claudePicks = ["b3"];
  expect(await chooseCopy(REPLY, "the index", { provider: "anthropic", model: "sonnet" })).toMatchObject({
    text: "add_index :conversations, :archived_at",
  });
  expect(api.claudeModels).toEqual(["claude-sonnet-5-5"]);
});

test("a copy setting that can't work falls back to Haiku", async () => {
  delete process.env.OPENROUTER_API_KEY;
  api.claudePicks = ["b3"];
  expect(await chooseCopy(REPLY, "the index", { provider: "openrouter" })).toMatchObject({
    note: "The copy setting failed, so haiku picked: OPENROUTER_API_KEY isn't set",
  });
  expect(api.claudeModels).toEqual(["claude-haiku-5-5"]);
});

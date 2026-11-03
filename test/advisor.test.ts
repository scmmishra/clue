import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiModel, cost, fastEnabled, modelLabel, pairEffort, resolveModel, responseCost } from "../src/agent/models";
import { COMPACT_PROMPT } from "../src/agent/prompt";
import { buildRequest, withSummaryRequest } from "../src/agent/provider";
import { chooseReviewer } from "../src/permissions";
import type { TurnRecord } from "../src/session";
import { OptionPicker } from "../src/ui/option-picker";
import { startMockApi } from "./mock-api";

const PAIR = "claude-sonnet-5-5+opus-5-5";
const pairRequest = (extra: object = {}) =>
  buildRequest({ model: PAIR, effort: "medium", messages: [], ...extra }) as any;
const advisorTool = (request: any) => request.tools.find((tool: { name: string }) => tool.name === "advisor");
const advice = [
  { role: "user", content: "fix it" },
  {
    role: "assistant",
    content: [
      { type: "server_tool_use", id: "a1", name: "advisor", input: {} },
      {
        type: "advisor_tool_result",
        tool_use_id: "a1",
        content: { type: "advisor_redacted_result", encrypted_content: "x" },
      },
      { type: "text", text: "Done." },
    ],
  },
  { role: "user", content: "thanks" },
] as never[];

test("the pair has a short name, a label, and Sonnet's prices", () => {
  expect(resolveModel("sonnet+opus")).toBe(PAIR);
  expect(resolveModel(PAIR)).toBe(PAIR);
  expect(resolveModel("opus+fable")).toBe("claude-opus-5-5+fable-5-1");
  expect(resolveModel("haiku+sonnet")).toBe("claude-haiku-5-5+sonnet-5-5");
  expect(modelLabel("claude-opus-5-5+fable-5-1")).toBe("opus 5.5 + fable");
  expect(apiModel("claude-haiku-5-5+sonnet-5-5")).toBe("claude-haiku-5-5");
  expect(modelLabel(PAIR)).toBe("sonnet 5.5 + opus");
  expect(apiModel(PAIR)).toBe("claude-sonnet-5-5");
  expect(apiModel("claude-opus-5-5")).toBe("claude-opus-5-5");
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, webSearches: 0 };
  expect(cost(PAIR, usage)).toBe(cost("claude-sonnet-5-5", usage));
  expect(fastEnabled({ model: PAIR, fast: true })).toBe(false);
  expect(fastEnabled({ model: "claude-opus-5-5+fable-5-1", fast: true })).toBe(false);
});

test("the pair runs at medium effort or above", () => {
  expect(pairEffort(PAIR, "low")).toBe("medium");
  expect(pairEffort(PAIR, "high")).toBe("high");
  expect(pairEffort("claude-opus-5-5", "low")).toBe("low");
  expect(pairRequest({ effort: "low" }).output_config.effort).toBe("medium");
});

test("a pair's request sends the executor, the advisor tool, its guidance and its beta", () => {
  const request = pairRequest();
  expect(request.model).toBe("claude-sonnet-5-5");
  expect(advisorTool(request)).toMatchObject({
    type: "advisor_20260301",
    model: "claude-opus-5-5",
    caching: { type: "ephemeral", ttl: "5m" },
  });
  expect(request.system).toHaveLength(2);
  expect(request.betas).toContain("advisor-tool-2026-03-01");
});

test("a single model's request has no advisor", () => {
  const request = buildRequest({ model: "claude-opus-5-5", effort: "medium", messages: [] }) as any;
  expect(advisorTool(request)).toBeUndefined();
  expect(request.system).toHaveLength(1);
  expect(request.betas).not.toContain("advisor-tool-2026-03-01");
});

test("subagents go without the advisor", () => {
  const request = pairRequest({ subagent: true });
  expect(advisorTool(request)).toBeUndefined();
  expect(request.system).toHaveLength(1);
});

test("a summary request starts like the turns, so it reads their cache", () => {
  const turn = pairRequest({ messages: advice });
  const summary = pairRequest({ messages: withSummaryRequest(advice, COMPACT_PROMPT) });
  expect(JSON.stringify(summary.tools)).toBe(JSON.stringify(turn.tools));
  expect(JSON.stringify(summary.system)).toBe(JSON.stringify(turn.system));
  expect(summary.messages.slice(0, 2)).toEqual(turn.messages.slice(0, 2));
  expect(summary.betas).toEqual(turn.betas);
});

test("the guidance names each pair's advisor, and the cache breakpoint sits after it", () => {
  for (const [model, advisor] of [
    [PAIR, "Opus 5.5"],
    ["claude-opus-5-5+fable-5-1", "Fable 5.1"],
    ["claude-haiku-5-5+sonnet-5-5", "Sonnet 5.5"],
  ]) {
    const system = pairRequest({ model }).system;
    expect(system[1].text).toContain(`It asks ${advisor}, a stronger model than you`);
    expect(system[1].text).toContain(`When the user asks you to consult ${advisor}`);
    expect(system[1].text).not.toContain("{{");
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].cache_control).toEqual({ type: "ephemeral" });
  }
  // The same pair always sends the same text, so its prefix stays cached across sessions.
  expect(JSON.stringify(pairRequest().system)).toBe(JSON.stringify(pairRequest({ effort: "high" }).system));
});

test("after switching away from the pair, its answers in the history still get the beta", () => {
  const request = buildRequest({ model: "claude-opus-5-5", effort: "medium", messages: advice }) as any;
  expect(advisorTool(request)).toBeUndefined();
  expect(request.betas).toContain("advisor-tool-2026-03-01");
});

// Usage from a live sonnet+opus response with one advisor call.
const live = {
  input_tokens: 6,
  output_tokens: 60,
  cache_read_input_tokens: 11233,
  cache_creation_input_tokens: 11428,
  server_tool_use: { web_search_requests: 0 },
  iterations: [
    {
      type: "message",
      model: null,
      input_tokens: 4,
      output_tokens: 26,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 11233,
    },
    {
      type: "advisor_message",
      model: "claude-opus-5-5",
      input_tokens: 177,
      output_tokens: 195,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 12635,
    },
    {
      type: "message",
      model: null,
      input_tokens: 2,
      output_tokens: 34,
      cache_read_input_tokens: 11233,
      cache_creation_input_tokens: 195,
    },
  ],
};

test("each iteration is priced at its own model's rates, the advisor's included", () => {
  // Sonnet: 6 in, 60 out, 11,233 read, 11,428 written. Opus: 177 in, 195 out, 12,635 written.
  const sonnet = 6 * 2 + 60 * 10 + 11233 * 0.1 + 11428 * 2.5;
  const opus = 177 * 4 + 195 * 20 + 12635 * 5;
  expect(responseCost(PAIR, live)).toBeCloseTo((sonnet + opus) / 1_000_000, 10);
});

test("without iterations, the top-level usage is the whole response", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0, server_tool_use: { web_search_requests: 2 } };
  expect(responseCost("claude-opus-5-5", usage)).toBeCloseTo(4.02);
});

test("web searches count once, from the top level", () => {
  const usage = {
    input_tokens: 0,
    server_tool_use: { web_search_requests: 1 },
    iterations: [{ type: "message", input_tokens: 0, server_tool_use: { web_search_requests: 1 } }],
  };
  expect(responseCost("claude-opus-5-5", usage)).toBeCloseTo(0.01);
});

test("an iteration whose model clue doesn't know leaves the cost unknown", () => {
  const unknown = { iterations: [{ type: "advisor_message", model: "claude-unknown", input_tokens: 1 }] };
  expect(responseCost(PAIR, unknown)).toBeNull();
});

test("Haiku bills a prompt over 100K tokens on its higher rate card, per request", () => {
  const short = { input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 100_000 };
  const long = { input_tokens: 1, output_tokens: 1_000_000, cache_read_input_tokens: 100_000 };
  expect(responseCost("claude-haiku-5-5", short)).toBeCloseTo(0.5 + 0.001);
  expect(responseCost("claude-haiku-5-5", long)).toBeCloseTo((0.5 + 0.001) * 5, 5);
  // Two requests of 60K each stay on the lower card, though together they pass 100K.
  const split = {
    iterations: [
      { type: "message", cache_read_input_tokens: 60_000 },
      { type: "message", cache_read_input_tokens: 60_000 },
    ],
  };
  expect(responseCost("claude-haiku-5-5+sonnet-5-5", split)).toBeCloseTo((120_000 * 0.01) / 1_000_000, 10);
});

test("a pair can't review actions", () => {
  expect(() => chooseReviewer({ provider: "anthropic", model: "sonnet+opus" })).toThrow();
});

const models = [
  { value: "opus", label: "opus 5.5", detail: "claude-opus-5-5", levels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "pair", label: "sonnet 5.5 + opus", levels: ["medium", "high", "xhigh", "max"] },
];
const shown = (picker: OptionPicker) => picker.frame().map((line) => Bun.stripANSI(line));

test("one effort line under the list follows the highlighted row", () => {
  const picker = new OptionPicker("Model:", models, "opus", { name: "Effort", level: "medium" });
  expect(shown(picker)).toEqual([
    "  Model:",
    "› opus 5.5           claude-opus-5-5",
    "  sonnet 5.5 + opus",
    "",
    "  Effort    low   [ medium ]   high     xhigh     max  ",
    "",
    "  ←→ effort · enter select · esc cancel",
  ]);
  picker.handle({ name: "right" });
  picker.handle({ name: "right" });
  expect(picker.chosenLevel).toBe("xhigh");
  for (let step = 0; step < 4; step++) picker.handle({ name: "left" });
  expect(picker.chosenLevel).toBe("low");
});

test("on a row that doesn't allow the level, the line shows the row's lowest, and ← stops there", () => {
  const picker = new OptionPicker("Model:", models, "opus", { name: "Effort", level: "low" });
  picker.handle({ name: "down" });
  expect(picker.chosenLevel).toBe("medium");
  expect(shown(picker)[4]).toBe("  Effort    low   [ medium ]   high     xhigh     max  ");
  picker.handle({ name: "left" });
  expect(picker.chosenLevel).toBe("medium");
  expect(picker.handle({ name: "enter" })).toBe("pair");
});

test("a list without a dial ignores ← and →", () => {
  const picker = new OptionPicker("Pick", [{ value: "a", label: "a" }], "a");
  expect(picker.handle({ name: "left" })).toBeNull();
  expect(shown(picker).at(-1)).toBe("  enter select · esc cancel");
});

let server: ReturnType<typeof startMockApi>;
beforeAll(() => {
  server = startMockApi();
});
afterAll(() => server.stop(true));

async function advisorTurn(prompt: string, mode = "") {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clue-advisor-")));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "agent-advisor.ts"), cwd, prompt, mode], {
    env: { ...process.env, ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "sk-ant-test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (!stdout.trim()) throw new Error(stderr);
  return JSON.parse(stdout) as { turn: TurnRecord; rows: { label: string; kind: string; isError: boolean }[] };
}

// The mock's base usage: 120 in, 40 out, 2,000 cache read, 300 cache write.
const sonnetBase = 120 * 2 + 2000 * 0.1 + 300 * 2.5;

test("an advisor call shows as a row, and its tokens are in the turn's cost", async () => {
  const { turn, rows } = await advisorTurn("consult the advisor please");
  expect(rows).toEqual([{ label: "Asked opus 5.5", kind: "advisor", isError: false }]);
  // Sonnet's two requests: the base prompt with 10 out, then 30 out. Opus: 1,000 in, 500 out.
  const sonnet = sonnetBase + 40 * 10;
  const opus = 1000 * 4 + 500 * 20;
  expect(turn.cost).toBeCloseTo((sonnet + opus) / 1_000_000, 10);
  expect(turn.costIsMinimum).toBeUndefined();
});

test("an interrupt during the advisor's pause still counts what the stream reported, as a minimum", async () => {
  const { turn } = await advisorTurn("consult the advisor and stall", "interrupt");
  expect(turn.stop).toBe("interrupted");
  // message_start reported the prompt and 40 out. The advisor's tokens never arrived.
  expect(turn.cost).toBeCloseTo((sonnetBase + 40 * 10) / 1_000_000, 10);
  expect(turn.costIsMinimum).toBe(true);
  expect(turn.usage.input).toBe(120);
});

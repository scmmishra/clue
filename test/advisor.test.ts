import { expect, test } from "bun:test";
import { advisorCost, apiModel, cost, fastEnabled, modelLabel, pairEffort, resolveModel } from "../src/agent/models";
import { buildRequest } from "../src/agent/provider";
import { chooseReviewer } from "../src/permissions";
import { OptionPicker } from "../src/ui/option-picker";

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
  expect(request.system[1].text).toContain("advisor");
  expect(request.betas).toContain("advisor-tool-2026-03-01");
});

test("a single model's request has no advisor", () => {
  const request = buildRequest({ model: "claude-opus-5-5", effort: "medium", messages: [] }) as any;
  expect(advisorTool(request)).toBeUndefined();
  expect(request.system).toHaveLength(1);
  expect(request.betas).not.toContain("advisor-tool-2026-03-01");
});

test("subagents and summaries go without the advisor, but keep its beta for its answers", () => {
  expect(advisorTool(pairRequest({ subagent: true }))).toBeUndefined();
  const summary = pairRequest({ summarize: true, messages: advice });
  expect(advisorTool(summary)).toBeUndefined();
  expect(summary.betas).toContain("advisor-tool-2026-03-01");
});

test("after switching away from the pair, its answers in the history still get the beta", () => {
  const request = buildRequest({ model: "claude-opus-5-5", effort: "medium", messages: advice }) as any;
  expect(advisorTool(request)).toBeUndefined();
  expect(request.betas).toContain("advisor-tool-2026-03-01");
});

test("advisor calls are priced at the advisor's rates, from usage.iterations", () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 10,
    iterations: [
      { type: "message", input_tokens: 100, output_tokens: 10 },
      { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 100_000 },
    ],
  };
  expect(advisorCost(usage)).toBeCloseTo(4 + 2);
  expect(advisorCost({ input_tokens: 5 })).toBe(0);
  const unknown = { iterations: [{ type: "advisor_message", model: "claude-unknown" }] };
  expect(advisorCost(unknown)).toBeNull();
});

test("a pair can't review actions", () => {
  expect(() => chooseReviewer({ provider: "anthropic", model: "sonnet+opus" })).toThrow();
});

const models = [
  { value: "opus", label: "opus 5.5", levels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "pair", label: "sonnet 5.5 + opus", levels: ["medium", "high", "xhigh", "max"] },
];
const shown = (picker: OptionPicker) => picker.frame().map((line) => Bun.stripANSI(line));

test("← and → move the effort on the highlighted row, within its levels", () => {
  const picker = new OptionPicker("Model:", models, "opus", "medium");
  expect(shown(picker)[1]).toBe("› opus 5.5           ●●○○○  medium");
  picker.handle({ name: "right" });
  picker.handle({ name: "right" });
  expect(picker.chosenLevel).toBe("xhigh");
  for (let step = 0; step < 4; step++) picker.handle({ name: "left" });
  expect(picker.chosenLevel).toBe("low");
  expect(shown(picker).at(-1)).toBe("  ←→ effort · enter select · esc cancel");
});

test("a row without the dial's level shows its own lowest, and enter returns both", () => {
  const picker = new OptionPicker("Model:", models, "opus", "low");
  picker.handle({ name: "down" });
  expect(picker.chosenLevel).toBe("medium");
  expect(shown(picker)[2]).toBe("› sonnet 5.5 + opus  ●○○○   medium");
  picker.handle({ name: "left" });
  expect(picker.chosenLevel).toBe("medium");
  expect(picker.handle({ name: "enter" })).toBe("pair");
});

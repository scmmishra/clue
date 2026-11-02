// What each Claude model supports, and what it costs per million tokens.

type ModelInfo = {
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // Progress notes between tool calls (thinking display "updates").
  progressNotes: boolean;
  // web_search_20260209 / web_fetch_20260209 with dynamic filtering.
  dynamicWebTools: boolean;
  // Server-side fallback on refusal.
  fallbacks: boolean;
  // speed: "fast", at FAST_PRICE_MULTIPLIER times the token prices.
  fastMode: boolean;
  // A pair: this model does the work, and the advisor tool asks the stronger one on hard steps.
  executor?: string;
  advisor?: string;
};

const MODELS: Record<string, ModelInfo> = {
  "claude-fable-5-1": {
    label: "fable 5.1",
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    progressNotes: true,
    dynamicWebTools: true,
    fallbacks: true,
    fastMode: false,
  },
  "claude-fable-5": {
    label: "fable 5",
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    progressNotes: true,
    dynamicWebTools: true,
    fallbacks: false,
    fastMode: false,
  },
  "claude-opus-5-5": {
    label: "opus 5.5",
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite: 5,
    progressNotes: true,
    dynamicWebTools: true,
    fallbacks: true,
    fastMode: true,
  },
  "claude-opus-5": {
    label: "opus 5",
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    progressNotes: false,
    dynamicWebTools: true,
    fallbacks: true,
    fastMode: true,
  },
  "claude-sonnet-5-5": {
    label: "sonnet 5.5",
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    progressNotes: true,
    dynamicWebTools: true,
    fallbacks: true,
    fastMode: false,
  },
  "claude-sonnet-5": {
    label: "sonnet 5",
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    progressNotes: false,
    dynamicWebTools: true,
    fallbacks: false,
    fastMode: false,
  },
  "claude-haiku-5-5": {
    label: "haiku 5.5",
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    progressNotes: false,
    dynamicWebTools: false,
    fallbacks: false,
    fastMode: false,
  },
};

// Pairs take the executor's prices. The advisor's tokens are priced separately, by advisorCost.
const pair = (executor: string, advisor: string, label: string): ModelInfo => ({
  ...MODELS[executor],
  label,
  fastMode: false,
  executor,
  advisor,
});
// Each pair is one the advisor tool accepts: the advisor is at least as capable as the executor.
MODELS["claude-sonnet-5-5+opus-5-5"] = pair("claude-sonnet-5-5", "claude-opus-5-5", "sonnet 5.5 + opus");
MODELS["claude-opus-5-5+fable-5-1"] = pair("claude-opus-5-5", "claude-fable-5-1", "opus 5.5 + fable");
MODELS["claude-haiku-5-5+sonnet-5-5"] = pair("claude-haiku-5-5", "claude-sonnet-5-5", "haiku 5.5 + sonnet");

// Short names for pairs, such as --model sonnet+opus.
const PAIR_ALIASES: Record<string, string> = {
  "sonnet+opus": "claude-sonnet-5-5+opus-5-5",
  "opus+fable": "claude-opus-5-5+fable-5-1",
  "haiku+sonnet": "claude-haiku-5-5+sonnet-5-5",
};

export const KNOWN_MODELS = Object.keys(MODELS);

// The model id the API takes: the executor of a pair, or the model itself.
export const apiModel = (id: string) => MODELS[id]?.executor ?? id;

export const advisorOf = (id: string) => MODELS[id]?.advisor ?? null;

// Below medium, the executor of a pair rarely asks its advisor.
export const PAIR_EFFORTS = ["medium", "high", "xhigh", "max"] as const;
export const pairEffort = <E extends string>(model: string, effort: E): E | "medium" =>
  advisorOf(model) && effort === "low" ? "medium" : effort;

export const REVIEW_FALLBACK_MODEL = "claude-haiku-5-5";

// The context size where the API compacts a conversation by default.
export const COMPACTION_TRIGGER_TOKENS = 150_000;

// Cost of one web search, in dollars.
const WEB_SEARCH_COST = 0.01;

const FAST_PRICE_MULTIPLIER = 2;

export const modelInfo = (id: string): ModelInfo | null => MODELS[id] ?? null;

export const modelLabel = (id: string) => MODELS[id]?.label ?? id.replace(/^claude-/, "");

export const FAST_MODELS = KNOWN_MODELS.filter((id) => MODELS[id].fastMode).map(modelLabel);

// Fast mode is on and this model has it. The setting alone says nothing about a model without it.
export const fastEnabled = ({ model, fast }: { model: string; fast: boolean }) =>
  fast && MODELS[model]?.fastMode === true;

// Accepts short names like "opus" or "sonnet-5.5" as well as full model ids.
export function resolveModel(name: string) {
  const wanted = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/\./g, "-");
  if (MODELS[wanted]) return wanted;
  if (PAIR_ALIASES[wanted]) return PAIR_ALIASES[wanted];
  const prefixed = wanted.startsWith("claude-") ? wanted : `claude-${wanted}`;
  if (MODELS[prefixed]) return prefixed;
  const family = KNOWN_MODELS.find((id) => id.startsWith(prefixed));
  return family ?? name.trim();
}

export type UsageCounts = { input: number; output: number; cacheRead: number; cacheWrite: number; webSearches: number };

type ApiUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
  iterations?: ({ type: string } & ApiUsage)[] | null;
};

export const emptyUsage = (): UsageCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 });

export function addUsage(total: UsageCounts, usage: ApiUsage) {
  total.input += usage.input_tokens ?? 0;
  total.output += usage.output_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.webSearches += usage.server_tool_use?.web_search_requests ?? 0;
}

// What one response cost in tokens. A compaction the API ran is outside the top-level fields.
export function responseUsage(usage: ApiUsage) {
  const total = emptyUsage();
  addUsage(total, usage);
  for (const entry of usage.iterations ?? []) if (entry.type === "compaction") addUsage(total, entry);
  return total;
}

export function cost(model: string, usage: UsageCounts, fast = false): number | null {
  const info = MODELS[model];
  if (!info) return null;
  const tokens =
    usage.input * info.input +
    usage.output * info.output +
    usage.cacheRead * info.cacheRead +
    usage.cacheWrite * info.cacheWrite;
  return (tokens * (fast ? FAST_PRICE_MULTIPLIER : 1)) / 1_000_000 + usage.webSearches * WEB_SEARCH_COST;
}

// What the advisor calls in one response cost. The top-level usage counts only the executor's tokens,
// so these are only in usage.iterations, each with the advisor's own model.
export function advisorCost(usage: ApiUsage): number | null {
  let total = 0;
  for (const entry of usage.iterations ?? []) {
    if (entry.type !== "advisor_message") continue;
    const counts = emptyUsage();
    addUsage(counts, entry);
    const model = (entry as { model?: unknown }).model;
    const price = typeof model === "string" ? cost(model, counts) : null;
    if (price === null) return null;
    total += price;
  }
  return total;
}

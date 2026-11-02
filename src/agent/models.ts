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
  // A prompt over `over` tokens bills every token at `multiplier` times the rates above.
  longPrompt?: { over: number; multiplier: number };
  // The context window, in tokens.
  context: number;
  // Where clue compacts the conversation when the settings don't say, in tokens.
  compactAt: number;
  // A pair: this model does the work, and the advisor tool asks the stronger one on hard steps.
  executor?: string;
  advisor?: string;
};

// Where a model with a 1M window compacts by default. Each request reads the whole context, so a
// later point costs more per request, and long, noisy contexts lose accuracy.
const LONG_CONTEXT_COMPACT_AT = 300_000;

const MODELS: Record<string, ModelInfo> = {
  "claude-fable-5-1": {
    label: "fable 5.1",
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    context: 1_000_000,
    compactAt: LONG_CONTEXT_COMPACT_AT,
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
    context: 1_000_000,
    compactAt: LONG_CONTEXT_COMPACT_AT,
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
    context: 1_000_000,
    compactAt: LONG_CONTEXT_COMPACT_AT,
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
    context: 1_000_000,
    compactAt: LONG_CONTEXT_COMPACT_AT,
    progressNotes: false,
    dynamicWebTools: true,
    fallbacks: true,
    fastMode: true,
  },
  "claude-sonnet-5-5": {
    label: "sonnet 5.5",
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    context: 1_000_000,
    compactAt: LONG_CONTEXT_COMPACT_AT,
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
    context: 1_000_000,
    compactAt: LONG_CONTEXT_COMPACT_AT,
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
    // $0.50 / $2.50 for a prompt over 100K tokens.
    longPrompt: { over: 100_000, multiplier: 5 },
    context: 1_000_000,
    // Under the long-prompt price, with room for one step past it.
    compactAt: 80_000,
    progressNotes: false,
    dynamicWebTools: false,
    fallbacks: false,
    fastMode: false,
  },
};

// Pairs take the executor's prices. responseCost prices the advisor's tokens at its own.
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

// For a model clue doesn't know: the window it assumes, and where it compacts, which is the
// API's own default.
const UNKNOWN_CONTEXT = 200_000;
export const DEFAULT_COMPACT_AT = 150_000;
// The least a compaction setting can ask for. Below it, summaries would follow each other.
export const MIN_COMPACT_AT = 50_000;
// Room kept free under the window, for the reply and for one step past the trigger.
const reserveFor = (context: number) => Math.max(Math.floor(context * 0.15), 16_000);

// A `compact_at` setting: a token count, or a share of the context window such as "30%".
export type CompactAt = number | string;

const COMPACT_AT_PERCENT = /^(\d{1,2}(?:\.\d+)?)%$/;

// Where clue compacts a conversation on this model: the setting if it has one, or the model's
// default. Never under MIN_COMPACT_AT, and always with room left in the window.
export function compactAt(id: string, setting?: CompactAt | null) {
  const info = MODELS[id] ?? MODELS[apiModel(id)];
  const context = info?.context ?? UNKNOWN_CONTEXT;
  let tokens = info?.compactAt ?? DEFAULT_COMPACT_AT;
  if (typeof setting === "number" && Number.isFinite(setting)) tokens = setting;
  else if (typeof setting === "string" && COMPACT_AT_PERCENT.test(setting.trim()))
    tokens = (context * Number.parseFloat(setting)) / 100;
  return Math.round(Math.min(Math.max(tokens, MIN_COMPACT_AT), context - reserveFor(context)));
}

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

// The price of one request's tokens. A long prompt, counted with its cache tokens, takes the
// higher rate card on models that have one.
export function cost(model: string, usage: UsageCounts, fast = false): number | null {
  const info = MODELS[model];
  if (!info) return null;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const card = info.longPrompt && prompt > info.longPrompt.over ? info.longPrompt.multiplier : 1;
  const tokens =
    usage.input * info.input +
    usage.output * info.output +
    usage.cacheRead * info.cacheRead +
    usage.cacheWrite * info.cacheWrite;
  return (tokens * card * (fast ? FAST_PRICE_MULTIPLIER : 1)) / 1_000_000 + usage.webSearches * WEB_SEARCH_COST;
}

// What one response cost. Each request in it is priced on its own rate card, at its own model's
// rates. The top-level usage is the sum of the executor's requests. When the iterations list
// those, each is priced alone, since a long-prompt card applies per request. Compactions and
// advisor calls are only in the iterations, never in the top-level usage.
export function responseCost(model: string, usage: ApiUsage, fast = false): number | null {
  const iterations = usage.iterations ?? [];
  const requests = iterations.some((entry) => entry.type === "message")
    ? iterations.filter((entry) => entry.type === "message")
    : [usage];
  const extra = iterations.filter((entry) => entry.type === "compaction" || entry.type === "advisor_message");
  let total = (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_COST;
  for (const entry of [...requests, ...extra]) {
    const counts = emptyUsage();
    addUsage(counts, entry);
    // Web searches are counted once, from the top level.
    counts.webSearches = 0;
    const own = (entry as { model?: unknown }).model;
    // Fast mode belongs to the executor's requests, which name no model.
    const price = typeof own === "string" ? cost(own, counts) : cost(model, counts, fast);
    if (price === null) return null;
    total += price;
  }
  return total;
}

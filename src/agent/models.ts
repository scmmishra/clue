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
  },
};

export const KNOWN_MODELS = Object.keys(MODELS);

export const REVIEW_FALLBACK_MODEL = "claude-haiku-5-5";

// The context size where the API compacts a conversation by default.
export const COMPACTION_TRIGGER_TOKENS = 150_000;

// Cost of one web search, in dollars.
const WEB_SEARCH_COST = 0.01;

export const modelInfo = (id: string): ModelInfo | null => MODELS[id] ?? null;

export const modelLabel = (id: string) => MODELS[id]?.label ?? id.replace(/^claude-/, "");

// Accepts short names like "opus" or "sonnet-5.5" as well as full model ids.
export function resolveModel(name: string) {
  const wanted = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/\./g, "-");
  if (MODELS[wanted]) return wanted;
  const prefixed = wanted.startsWith("claude-") ? wanted : `claude-${wanted}`;
  if (MODELS[prefixed]) return prefixed;
  const family = KNOWN_MODELS.find((id) => id.startsWith(prefixed));
  return family ?? name.trim();
}

export type UsageCounts = { input: number; output: number; cacheRead: number; cacheWrite: number; webSearches: number };

export function cost(model: string, usage: UsageCounts): number | null {
  const info = MODELS[model];
  if (!info) return null;
  return (
    (usage.input * info.input +
      usage.output * info.output +
      usage.cacheRead * info.cacheRead +
      usage.cacheWrite * info.cacheWrite) /
      1_000_000 +
    usage.webSearches * WEB_SEARCH_COST
  );
}

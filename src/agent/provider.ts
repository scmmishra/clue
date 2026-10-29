import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config";
import { resolveAuth } from "../auth";
import type { MessageParam } from "../session";
import { toolDefinitions } from "../tools";
import { modelInfo } from "./models";
import { SYSTEM_PROMPT } from "./prompt";

// Every model call goes through this file. Other providers, such as
// OpenRouter or Codex, would be a sibling of this module.

const API_ORIGIN = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const MAX_OUTPUT_TOKENS = 64_000;

let clientPromise: Promise<Anthropic> | null = null;

// Opens the TLS connection while the user types, so the first request skips the handshake.
export function preconnect() {
  try {
    fetch.preconnect(API_ORIGIN);
  } catch {}
}

export class MissingCredentials extends Error {
  constructor() {
    super("No Claude credentials. Run `clue login`, or set ANTHROPIC_API_KEY.");
  }
}

export function getClient(): Promise<Anthropic> {
  clientPromise ??= (async () => {
    const [{ default: AnthropicClient }, auth] = await Promise.all([import("@anthropic-ai/sdk"), resolveAuth()]);
    if (auth.source === "none") throw new MissingCredentials();
    return new AnthropicClient({ apiKey: auth.apiKey, maxRetries: 3 });
  })();
  clientPromise.catch(() => (clientPromise = null));
  return clientPromise;
}

// Optional features that some accounts, models or proxies reject. When the API
// refuses one, clue drops it for the rest of the process and retries.
const features = {
  compaction: true,
  progressNotes: true,
  fallbacks: true,
};

export type RequestOptions = {
  model: string;
  effort: Effort;
  messages: MessageParam[];
  subagent?: boolean;
};

export function buildRequest(options: RequestOptions) {
  const info = modelInfo(options.model);
  const betas: string[] = [];
  const request: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
    model: options.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    // The system prompt and tool list are identical in every session, so the
    // start of every request is already in Claude's cache.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: toolDefinitions(options.model, { subagent: options.subagent }),
    messages: options.messages,
    // Caches the conversation tail, so each turn reads the turns before it.
    cache_control: { type: "ephemeral" },
    output_config: { effort: options.effort },
  };
  if (features.progressNotes && info?.progressNotes) {
    request.thinking = { type: "adaptive", display: "updates" };
    betas.push("thinking-display-updates-2026-08-18");
  } else {
    request.thinking = { type: "adaptive", display: "summarized" };
  }
  if (features.compaction) {
    request.context_management = { edits: [{ type: "compact_20260112" }] };
    betas.push("compact-2026-01-12");
  }
  if (features.fallbacks && info?.fallbacks) {
    (request as { fallbacks?: unknown }).fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  if (betas.length) request.betas = betas;
  return request;
}

// Drops the optional feature a 400 complains about. Returns false when nothing was left to drop.
export function dropRejectedFeature(error: unknown) {
  const message = String((error as Error)?.message ?? "").toLowerCase();
  if (features.fallbacks && message.includes("fallback")) return !(features.fallbacks = false);
  if (features.progressNotes && (message.includes("display") || message.includes("updates"))) return !(features.progressNotes = false);
  if (features.compaction && (message.includes("context_management") || message.includes("compact"))) return !(features.compaction = false);
  // Unclear which feature: drop them all once.
  if (features.fallbacks || features.progressNotes || features.compaction) {
    features.fallbacks = features.progressNotes = features.compaction = false;
    return true;
  }
  return false;
}

export async function stream(options: RequestOptions, signal: AbortSignal) {
  const client = await getClient();
  return client.beta.messages.stream(buildRequest(options), { signal });
}

// Caches a resumed conversation while the user types. max_tokens 0 runs the
// prefill and writes the cache without generating a reply.
export async function warmCache(options: RequestOptions, signal: AbortSignal) {
  if (options.messages.length === 0) return null;
  const client = await getClient();
  const request = buildRequest(options) as unknown as Record<string, unknown>;
  delete request.stream;
  delete request.cache_control;
  delete request.fallbacks;
  const messages = structuredClone(options.messages);
  // Breakpoint on the last block shared with the real request.
  const last = messages[messages.length - 1];
  if (Array.isArray(last.content) && last.content.length) {
    (last.content[last.content.length - 1] as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
  } else if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
  }
  messages.push({ role: "user", content: "warmup" });
  const response = await client.beta.messages.create({ ...(request as object), messages, max_tokens: 0 } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, { signal });
  return response.usage;
}

import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config";
import { resolveAuth } from "../auth";
import { startsWithSummary, type MessageParam } from "../session";
import { toolDefinitions } from "../tools";
import { advisorOf, apiModel, modelInfo, modelLabel, pairEffort } from "./models";
import { advisorGuidance, COMPACT_INSTRUCTIONS, SYSTEM_PROMPT } from "./prompt";

// Every model call goes through this file. Other providers, such as
// OpenRouter or Codex, would be a sibling of this module.

const API_ORIGIN = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const MAX_OUTPUT_TOKENS = 64_000;

// The advisor's output per call, thinking included, and its calls per request.
const ADVISOR_MAX_TOKENS = 4096;
const ADVISOR_MAX_USES = 5;

let clientPromise: Promise<Anthropic> | null = null;
let clientOrigin: string | undefined;

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
  // Test files each point ANTHROPIC_BASE_URL at their own mock server, so a new one gets a new client.
  if (clientOrigin !== process.env.ANTHROPIC_BASE_URL) clientPromise = null;
  clientOrigin = process.env.ANTHROPIC_BASE_URL;
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
  progressNotes: true,
  fallbacks: true,
};

export type RequestOptions = {
  summarize?: boolean;
  model: string;
  effort: Effort;
  messages: MessageParam[];
  subagent?: boolean;
  fast?: boolean;
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// An advisor's answer in the history. The API accepts one only with the advisor beta.
const holdsAdvice = (messages: MessageParam[]) =>
  messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((block) => block.type === "advisor_tool_result"),
  );

// A compaction block the API added inside a reply, in a session from before clue chose when to
// compact. The API reads such a block only with automatic compaction on.
const holdsServerCompaction = (messages: MessageParam[]) =>
  messages.some(
    (message, index) =>
      Array.isArray(message.content) &&
      message.content.some((block, position) => block.type === "compaction" && (index > 0 || position > 0)),
  );

export function buildRequest(options: RequestOptions) {
  const model = apiModel(options.model);
  const info = modelInfo(model);
  const betas: string[] = [];
  // Subagents work without the advisor. A summary keeps it, so its tools and system prompt match
  // the turns it summarizes and it reads their cache.
  const advisor = options.subagent ? null : advisorOf(options.model);
  // The system prompt and tool list are identical in every session on a model, so the start of
  // every request is already in Claude's cache. The breakpoint goes on the last system block.
  const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [{ type: "text", text: SYSTEM_PROMPT }];
  if (advisor) system.push({ type: "text", text: advisorGuidance(capitalize(modelLabel(advisor))) });
  system.at(-1)!.cache_control = { type: "ephemeral" };
  const request: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    system,
    tools: toolDefinitions(model, { subagent: options.subagent }),
    messages: options.messages,
    // Caches the conversation tail, so each turn reads the turns before it.
    cache_control: { type: "ephemeral" },
    output_config: { effort: pairEffort(options.model, options.effort) },
  };
  if (advisor) {
    request.tools!.push({
      type: "advisor_20260301",
      name: "advisor",
      model: advisor,
      max_tokens: ADVISOR_MAX_TOKENS,
      max_uses: ADVISOR_MAX_USES,
      // Each call sends the whole conversation, so its prefix is worth caching.
      caching: { type: "ephemeral", ttl: "5m" },
    } as unknown as Anthropic.Beta.Messages.BetaToolUnion);
  }
  if (advisor || holdsAdvice(options.messages)) betas.push("advisor-tool-2026-03-01");
  if (features.progressNotes && info?.progressNotes) {
    request.thinking = { type: "adaptive", display: "updates" };
    betas.push("thinking-display-updates-2026-08-18");
  } else {
    request.thinking = { type: "adaptive", display: "summarized" };
  }
  // The /compact and automatic summary request. clue decides when to compact, between requests
  // (see Agent.compactIfFull).
  if (options.summarize) request.compaction = { type: "summarize", instructions: COMPACT_INSTRUCTIONS };
  if (options.summarize || startsWithSummary(options.messages)) betas.push("compact-2026-09-04");
  // Ordinary requests leave compaction to clue. Only a history with a compaction block the API
  // inserted keeps the API's own, because the API reads such a block only with it on.
  else if (holdsServerCompaction(options.messages)) {
    request.context_management = { edits: [{ type: "compact_20260112" }] };
    betas.push("compact-2026-01-12");
  }
  if (features.fallbacks && info?.fallbacks && !options.summarize) {
    (request as { fallbacks?: unknown }).fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  if (options.fast) {
    request.speed = "fast";
    betas.push("fast-mode-2026-02-01");
  }
  if (betas.length) request.betas = betas;
  return request;
}

// Drops the optional feature a 400 names. Returns false when it names none: most 400s
// are about the request itself.
export function dropRejectedFeature(error: unknown) {
  const message = String((error as Error)?.message ?? "").toLowerCase();
  if (features.fallbacks && message.includes("fallback")) return !(features.fallbacks = false);
  if (features.progressNotes && (message.includes("display") || message.includes("updates")))
    return !(features.progressNotes = false);
  return false;
}

// A 400 about fast mode, such as from an account without access. Unlike the features above, the
// user chose this one and the status line shows it, so the loop turns the setting off instead.
export const fastRejected = (error: unknown) => /\bspeed\b|fast.mode/i.test(String((error as Error)?.message ?? ""));

export async function stream(options: RequestOptions, signal: AbortSignal) {
  const client = await getClient();
  return client.beta.messages.stream(buildRequest(options), { signal });
}

// Asks for a summary of the conversation. The response holds a compaction block and no reply.
export async function summarize(options: RequestOptions, signal: AbortSignal) {
  const client = await getClient();
  return client.beta.messages.stream(buildRequest({ ...options, summarize: true }), { signal }).finalMessage();
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
  const response = await client.beta.messages.create(
    { ...(request as object), messages, max_tokens: 0 } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
    { signal },
  );
  return response.usage;
}

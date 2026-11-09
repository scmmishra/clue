import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config";
import { resolveAuth } from "../auth";
import type { MessageParam } from "../session";
import { toolDefinitions } from "../tools";
import { advisorOf, apiModel, MAX_OUTPUT_TOKENS, modelInfo, modelLabel, pairEffort } from "./models";
import { advisorGuidance, SYSTEM_PROMPT } from "./prompt";
import type { MessageThread } from "./thread";

// Every model call goes through this file. Other providers, such as
// OpenRouter or Codex, would be a sibling of this module.

const API_ORIGIN = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";

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
  if (features.fallbacks && info?.fallbacks) {
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
// are about the request itself, and retrying those without a feature would only fail again.
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

// A tool input that isn't valid JSON, such as one with a raw tab inside a string. Strict tools
// should not produce one, but `mcp_call` isn't strict. The SDK parses each input when its block
// ends, and wraps the SyntaxError in an error that only names it in text.
export const toolInputBroken = (error: unknown) =>
  String((error as Error)?.message ?? "").startsWith("Unable to parse tool parameter JSON");

export async function stream(options: RequestOptions, signal: AbortSignal, thread?: MessageThread) {
  const client = await getClient();
  const request = buildRequest(options);
  const response = client.beta.messages.stream(thread ? thread.prepare(request) : request, { signal });
  if (thread) response.on("finalMessage", (message) => thread.record(message));
  return response;
}

// The conversation with a request at its end. A last user message, such as tool results, takes it
// as one more block, so the roles still alternate.
export function withSummaryRequest(messages: MessageParam[], prompt: string): MessageParam[] {
  const request = { type: "text" as const, text: prompt };
  const last = messages.at(-1);
  if (last?.role !== "user") return [...messages, { role: "user", content: [request] }];
  const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
  return [...messages.slice(0, -1), { ...last, content: [...content, request] }];
}

// Asks Claude to summarize the conversation. The request is a turn's with the prompt at its end, so
// it reads the cache the turns before it wrote.
export async function summarize(options: RequestOptions, prompt: string, signal: AbortSignal) {
  const client = await getClient();
  const request = buildRequest({ ...options, messages: withSummaryRequest(options.messages, prompt) });
  return client.beta.messages.stream(request, { signal }).finalMessage();
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

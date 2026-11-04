import type Anthropic from "@anthropic-ai/sdk";

// The layer between the loop and the SDK for message threads.
// https://platform.claude.com/docs/en/build-with-claude/message-threads
//
// The session stays the source of truth. The thread is a copy the API holds for a few minutes, so
// a request continues it only when clue is sure the copy matches. Otherwise the request sends the
// whole conversation and creates a new thread. A request the API refuses for a thread reason is
// sent again the same way.

type Request = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

export const THREADS_BETA = "message-threads-2026-08-12";

// The API drops a thread 5 minutes after it stores the last reply. A request after this long
// creates a new thread instead of sending a continue the API would refuse.
export const THREAD_IDLE_MS = 270_000;

// The fields the API checks on every continue. A change to one needs a new thread. `system` and
// `tools` are not sent on a continue, so the API can't check them, and clue checks them here.
// `betas` and `fallbacks` are added separately.
const FIXED_FIELDS = [
  "model",
  "output_config",
  "thinking",
  "tool_choice",
  "cache_control",
  "context_management",
  "mcp_servers",
  "container",
  "system",
  "tools",
] as const;

// Refusals a create request recovers from. The API returns them before the model runs, so they
// cost a round trip and no tokens.
const REPLAY_CODES = new Set([
  "thread_not_found",
  "thread_already_continued",
  "thread_continue_in_flight",
  "thread_fingerprint_mismatch",
]);

export function fingerprint(request: Request) {
  const fixed: Record<string, unknown> = {};
  for (const field of FIXED_FIELDS) fixed[field] = request[field as keyof Request];
  // The API compares the set of betas, not their order.
  fixed.betas = [...(request.betas ?? [])].sort();
  // Its value can change between requests. Only sending it or not must stay the same.
  fixed.fallbacks = "fallbacks" in request;
  return Bun.hash(JSON.stringify(fixed)).toString(36);
}

// The `error_code` the API gives a refused thread request, if it is one.
export function threadErrorCode(error: unknown): string | null {
  const body = (error as { error?: { error?: { details?: { error_code?: unknown } } } })?.error;
  const code = body?.error?.details?.error_code;
  return typeof code === "string" && code.startsWith("thread_") ? code : null;
}

// Whether the API kept the turn, so the next request can continue from its reply. It keeps no
// turn a fallback model wrote, nor one that ends in a tool call cut off by the output limit. A
// refused turn may be kept, and it must not be continued.
function continuable(message: Message) {
  if (message.stop_reason === "refusal") return false;
  if (message.usage.iterations?.some((entry) => entry.type === "fallback_message")) return false;
  const last = message.content.at(-1)?.type;
  if (message.stop_reason === "max_tokens" && (last === "tool_use" || last === "server_tool_use")) return false;
  return true;
}

// Thread refusals in a row, without a recorded reply between them, before threads turn off. A
// refused continue is sent again as a create, and the API refuses a create only when it can't
// thread the request at all, so two refusals in a row mean something clue doesn't expect.
const MAX_REFUSALS = 2;

// The statuses of a refusal that may be about the thread even without a thread error code, for
// example from a proxy that doesn't know the beta.
const UNCODED_STATUSES = new Set([400, 403, 404]);

type Sent = {
  count: number;
  revision: number;
  fingerprint: string;
  continued: boolean;
  // Sent without a thread to learn whether the thread caused an uncoded refusal.
  probe: boolean;
};

export class MessageThread {
  // The last reply the API stored, and how many messages the thread holds with it.
  private held: { id: string; count: number; revision: number; fingerprint: string; at: number } | null = null;
  // The request in flight, until its reply is recorded or it fails.
  private sent: Sent | null = null;
  // Set when the API can't thread this conversation. Every later request goes out whole.
  private off = false;
  // Set when the API lost a continued thread, until a reply to a continue is recorded. A thread
  // lost while it is set was lost right after its replay.
  private lost = false;
  // Thread refusals since the last recorded reply.
  private refusals = 0;
  // Set when the next request goes out without a thread, to test an uncoded refusal.
  private probing = false;

  // `revision` goes up when the conversation changes other than by an addition at its end.
  constructor(
    private revision: () => number = () => 0,
    private now: () => number = Date.now,
  ) {}

  // The request as it should be sent: the whole conversation to create a thread, and only the
  // messages after the last reply, without system and tools, to continue it.
  prepare(request: Request): Request {
    // A reply can be continued once. A request that never reaches `record()`, because it failed
    // or was stopped, leaves no reply to continue: the API may hold one clue never received.
    const held = this.held;
    this.held = null;
    this.sent = null;
    if (this.off) return request;
    const sent: Sent = {
      count: request.messages.length,
      revision: this.revision(),
      fingerprint: fingerprint(request),
      continued: false,
      probe: this.probing,
    };
    this.sent = sent;
    this.probing = false;
    if (sent.probe) return request;
    const betas = [...(request.betas ?? []), THREADS_BETA];
    const canContinue =
      held !== null &&
      held.revision === sent.revision &&
      held.fingerprint === sent.fingerprint &&
      held.count <= sent.count &&
      this.now() - held.at < THREAD_IDLE_MS;
    if (!canContinue) return { ...request, betas, thread: { type: "create" } };
    sent.continued = true;
    const { system: _system, tools: _tools, ...rest } = request;
    return {
      ...rest,
      betas,
      messages: request.messages.slice(held.count),
      thread: { type: "continue", previous_message_id: held.id },
    };
  }

  // Keeps the reply for the next request to continue from. The loop adds the reply to the
  // conversation, so the thread holds one more message than the request carried.
  record(message: Message) {
    const sent = this.sent;
    this.sent = null;
    if (!sent) return;
    this.refusals = 0;
    // The request went through without a thread after the threaded one was refused.
    if (sent.probe) {
      this.off = true;
      return;
    }
    if (sent.continued) this.lost = false;
    if (!continuable(message)) return;
    this.held = {
      id: message.id,
      count: sent.count + 1,
      revision: sent.revision,
      fingerprint: sent.fingerprint,
      at: this.now(),
    };
  }

  // Whether the loop should send a request the API refused with a thread error again.
  // `prepare()` already dropped the reply, so the request goes out again as a create, or
  // without a thread once threads are off. Once off, no request can be refused for its thread.
  recover(error: unknown) {
    const sent = this.sent;
    this.sent = null;
    const code = threadErrorCode(error);
    if (!sent || !code) return false;
    this.refusals += 1;
    const lostAgain = code === "thread_not_found" && sent.continued && this.lost;
    if (code === "thread_not_found" && sent.continued) this.lost = true;
    // The API can't thread this conversation, or refuses it in a way clue doesn't know. Creating
    // the thread again would only fail again.
    if (code === "thread_unsupported_request" || lostAgain || !REPLAY_CODES.has(code) || this.refusals > MAX_REFUSALS)
      this.off = true;
    return true;
  }

  // Whether the loop should send a refused request again without a thread. A refusal without a
  // thread error code may still be about the thread, so the next request tests it once. If that
  // request goes through, threads turn off. If it fails too, the thread wasn't the cause.
  retryUnthreaded(error: unknown) {
    const sent = this.sent;
    this.sent = null;
    if (!sent || sent.probe) return false;
    const status = (error as { status?: unknown })?.status;
    if (typeof status !== "number" || !UNCODED_STATUSES.has(status)) return false;
    this.probing = true;
    return true;
  }
}

import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "../session";

// Message threads: the API keeps the conversation for a few minutes, so a request sends only the
// messages since the last reply. Each request then uploads, validates and tokenizes less, and
// the first token comes sooner in a long conversation. Billing doesn't change.
// https://platform.claude.com/docs/en/build-with-claude/message-threads
//
// The session stays the source of truth. The loop builds every request in full, and this layer
// works out what the API already holds. Anything it can't vouch for starts a new thread with the
// full conversation, which is always safe.

type Request = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;
type Stream = ReturnType<Anthropic["beta"]["messages"]["stream"]>;

export const THREADS_BETA = "message-threads-2026-08-12";

// A thread expires 5 minutes after its last request. Past this, a new thread is sure to be needed,
// so clue sends one without first asking for the old.
export const THREAD_FRESH_MS = 4.5 * 60_000;

// Rejections that a new thread with the full conversation recovers from.
const REPLAY_CODES = ["thread_not_found", "thread_already_continued", "thread_continue_in_flight"];

// What the API holds for the current thread.
type Held = {
  id: string;
  // Every message of the thread, Claude's last reply included.
  messages: MessageParam[];
  // The fields a thread fixes when it starts. A change needs a new thread.
  fingerprint: string;
  // When the last reply finished, which restarts the thread's 5 minutes.
  at: number;
  // The last reply stopped with pause_turn, so the next request may add nothing.
  paused: boolean;
};

export type ThreadKind = "create" | "continue" | "none";

export class MessageThread {
  private held: Held | null = null;
  // Set when the API refuses threads for this account or request. The rest of the session
  // goes without them.
  private off = false;
  // How the last request went out. Tests read it.
  lastKind: ThreadKind = "none";

  constructor(private now: () => number = Date.now) {}

  get enabled() {
    return !this.off;
  }

  // Sends a request through the thread, or without one when it can't use one. A rejection that a
  // new thread recovers from sends the full conversation again, once.
  async stream(client: Anthropic, request: Request, signal: AbortSignal): Promise<Stream> {
    const planned = this.plan(request);
    try {
      return await this.open(client, planned, request, signal);
    } catch (error) {
      const code = errorCode(error);
      if (code === "thread_unsupported_request") {
        this.off = true;
        this.held = null;
        return this.open(client, this.plan(request), request, signal);
      }
      if (
        planned.kind === "continue" &&
        code &&
        (REPLAY_CODES.includes(code) || code === "thread_fingerprint_mismatch")
      ) {
        this.held = null;
        return this.open(client, this.plan(request), request, signal);
      }
      throw error;
    }
  }

  // The request as it goes out: unchanged, the start of a new thread, or the messages the API
  // doesn't have yet.
  plan(request: Request): { kind: ThreadKind; body: Request } {
    if (this.off || !threadable(request)) return { kind: "none", body: request };
    const fingerprint = fingerprintOf(request);
    const held = this.held;
    const fresh = held && this.now() - held.at < THREAD_FRESH_MS;
    if (held && fresh && held.fingerprint === fingerprint && continuesHeld(request.messages, held)) {
      const { system: _system, tools: _tools, ...rest } = request;
      return {
        kind: "continue",
        body: {
          ...rest,
          messages: request.messages.slice(held.messages.length),
          thread: { type: "continue", previous_message_id: held.id },
          betas: withBeta(request.betas),
        },
      };
    }
    return {
      kind: "create",
      body: { ...request, thread: { type: "create" }, betas: withBeta(request.betas) },
    };
  }

  // Waits for the response headers, so a rejection arrives here rather than mid-stream.
  private async open(
    client: Anthropic,
    planned: { kind: ThreadKind; body: Request },
    full: Request,
    signal: AbortSignal,
  ) {
    this.lastKind = planned.kind;
    // A response id can be continued once. Until this reply finishes, there is nothing to continue.
    this.held = null;
    const stream = client.beta.messages.stream(planned.body, { signal });
    if (planned.kind !== "none") {
      const fingerprint = fingerprintOf(full);
      stream.on("finalMessage", (message) => this.record(full.messages, message, fingerprint));
    }
    await stream.withResponse();
    return stream;
  }

  // Keeps what the API now holds, after a reply that reached message_stop. The API keeps no turn
  // that a fallback model wrote or that Claude refused, and those need a new thread.
  private record(sent: MessageParam[], message: Message, fingerprint: string) {
    const fellBack = message.usage.iterations?.some((entry) => (entry.type as string) === "fallback_message");
    if (message.stop_reason === "refusal" || fellBack) return;
    this.held = {
      id: message.id,
      messages: [
        ...sent,
        { role: "assistant", content: message.content as Anthropic.Beta.Messages.BetaContentBlockParam[] },
      ],
      fingerprint,
      at: this.now(),
      paused: message.stop_reason === "pause_turn",
    };
  }

  // Forgets the thread, such as after the conversation was cut back.
  reset() {
    this.held = null;
  }
}

// A thread can't hold a compaction: a request with automatic compaction or a summary block goes
// without one.
function threadable(request: Request) {
  if (request.context_management || request.compaction) return false;
  return !request.messages.some(
    (message) => Array.isArray(message.content) && message.content.some((block) => block.type === "compaction"),
  );
}

// Whether `messages` starts with everything the API holds, and adds something after it. After
// pause_turn, adding nothing resumes the paused reply.
function continuesHeld(messages: MessageParam[], held: Held) {
  if (messages.length < held.messages.length) return false;
  if (messages.length === held.messages.length && !held.paused) return false;
  return held.messages.every((message, index) => sameMessage(message, messages[index]));
}

const sameMessage = (a: MessageParam, b: MessageParam) =>
  a === b ||
  (a.role === b.role && (a.content === b.content || JSON.stringify(a.content) === JSON.stringify(b.content)));

// The fields a thread fixes, plus `system` and `tools`, which only its first request sends.
function fingerprintOf(request: Request) {
  const fields = {
    model: request.model,
    thinking: request.thinking,
    output_config: request.output_config,
    tool_choice: request.tool_choice,
    cache_control: request.cache_control,
    betas: [...(request.betas ?? [])].sort(),
    fallbacks: "fallbacks" in request,
    system: request.system,
    tools: request.tools,
  };
  return JSON.stringify(fields);
}

const withBeta = (betas: Request["betas"]) => [...(betas ?? []), THREADS_BETA];

// The `error_code` of an API error's details, if it has one.
export function errorCode(error: unknown): string | null {
  const body = (error as { error?: { error?: { details?: { error_code?: unknown } } } })?.error;
  const code = body?.error?.details?.error_code;
  return typeof code === "string" ? code : null;
}

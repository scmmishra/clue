import type Anthropic from "@anthropic-ai/sdk";

// The layer between the loop and the SDK for message threads.
// https://platform.claude.com/docs/en/build-with-claude/message-threads
//
// Naive for now: the first request creates a thread and every later one continues it. A new
// thread starts only when the conversation was replaced or cut back. Nothing yet handles an
// expired thread, a changed field or an error.

type Request = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

export const THREADS_BETA = "message-threads-2026-08-12";

export class MessageThread {
  // The last reply the API stored, and how many messages the thread holds with it.
  private held: { id: string; count: number; revision: number } | null = null;
  // How many messages the last request carried in full, before Claude's reply, and the
  // conversation's revision then.
  private sent = 0;
  private sentRevision = 0;

  // `revision` tells when the conversation changed other than by an addition at its end.
  constructor(private revision: () => number = () => 0) {}

  // The request as it should be sent: the whole conversation to create a thread, and only the
  // messages after the last reply, without system and tools, to continue it.
  prepare(request: Request): Request {
    this.sent = request.messages.length;
    this.sentRevision = this.revision();
    const betas = [...(request.betas ?? []), THREADS_BETA];
    if (!this.held || this.held.revision !== this.sentRevision)
      return { ...request, betas, thread: { type: "create" } };
    const { system: _system, tools: _tools, ...rest } = request;
    return {
      ...rest,
      betas,
      messages: request.messages.slice(this.held.count),
      thread: { type: "continue", previous_message_id: this.held.id },
    };
  }

  // Keeps what the API now holds. The loop adds Claude's reply to the conversation, so it is one
  // more message than the request carried.
  record(message: Message) {
    this.held = { id: message.id, count: this.sent + 1, revision: this.sentRevision };
  }
}

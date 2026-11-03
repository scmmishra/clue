import type Anthropic from "@anthropic-ai/sdk";

// The layer between the loop and the SDK for message threads.
// https://platform.claude.com/docs/en/build-with-claude/message-threads
//
// For now it only hashes the request and passes it on unchanged. The thread logic comes later.

type Request = Anthropic.Beta.Messages.MessageCreateParamsStreaming;

export class MessageThread {
  // The sha256 of the last request that went through, or null before the first.
  lastHash: string | null = null;

  // The request as it should be sent.
  prepare(request: Request): Request {
    const body = JSON.stringify(request);
    this.lastHash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    return request;
  }
}

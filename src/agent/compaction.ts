import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "../session";

// clue compacts a conversation itself. A summary replaces the older messages, and the latest ones
// stay word for word, so Claude still has the exact state of the work it was doing.

// About how much of the latest conversation a compaction keeps, in tokens.
export const KEEP_RECENT_TOKENS = 20_000;
// What an image or a document counts for. Its size in a request has little to do with its bytes.
const IMAGE_TOKENS = 1600;

type Block = Anthropic.Beta.Messages.BetaContentBlockParam;

// A rough count, at about four characters to a token. It only has to pick where the kept part starts.
function blockTokens(block: Block): number {
  switch (block.type) {
    // The kept messages go without their thinking.
    case "thinking":
    case "redacted_thinking":
      return 0;
    case "image":
    case "document":
      return IMAGE_TOKENS;
    case "text":
      return block.text.length / 4;
    case "tool_result":
      if (typeof block.content === "string") return block.content.length / 4;
      return ((block.content ?? []) as Block[]).reduce((sum, part) => sum + blockTokens(part), 0);
    default:
      return JSON.stringify(block).length / 4;
  }
}

export function messageTokens(message: MessageParam) {
  // clue sends no system messages.
  if (message.role === "system") return 0;
  if (typeof message.content === "string") return message.content.length / 4;
  return message.content.reduce((sum, block) => sum + blockTokens(block), 0);
}

// Where the kept part can start: a prompt, or a reply to a user message. Tool results answer the
// calls in the reply before them, so they can't go without it.
function startsTurn(messages: MessageParam[], index: number) {
  const message = messages[index];
  if (message.role === "user")
    return typeof message.content === "string" || !message.content.some((block) => block.type === "tool_result");
  return message.role === "assistant" && messages[index - 1]?.role === "user";
}

// How many of the latest messages a compaction keeps: about `budget` tokens of them, from the
// nearest place a turn or a reply starts. None when the whole conversation is smaller, since the
// summary would then replace nothing.
export function keptCount(messages: MessageParam[], budget = KEEP_RECENT_TOKENS) {
  let tokens = 0;
  let start = messages.length;
  while (start > 0 && tokens < budget) tokens += messageTokens(messages[--start]);
  if (tokens < budget) return 0;
  for (let index = Math.max(start, 1); index < messages.length; index++) {
    if (startsTurn(messages, index)) return messages.length - index;
  }
  return 0;
}

import { startsWithSummary, type MessageParam } from "../session";

// How much of the latest conversation an automatic compaction keeps word for word, in tokens.
// The summary covers what came before it.
export const KEEP_RECENT_TOKENS = 20_000;

// Rough sizes, enough to choose where to cut.
const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1_600;
const DOCUMENT_TOKENS = 2_000;

// Only the fields the estimate reads.
type Block = { type: string; text?: string; thinking?: string; content?: string | Block[] | null };

function blockTokens(block: Block): number {
  switch (block.type) {
    case "text":
      return (block.text ?? "").length / CHARS_PER_TOKEN;
    case "image":
      return IMAGE_TOKENS;
    case "document":
      return DOCUMENT_TOKENS;
    case "thinking":
      return (block.thinking ?? "").length / CHARS_PER_TOKEN;
    case "tool_result":
      return typeof block.content === "string"
        ? block.content.length / CHARS_PER_TOKEN
        : (block.content ?? []).reduce((sum, part) => sum + blockTokens(part), 0);
    default:
      return JSON.stringify(block).length / CHARS_PER_TOKEN;
  }
}

export const estimateTokens = (message: MessageParam) =>
  typeof message.content === "string"
    ? message.content.length / CHARS_PER_TOKEN
    : ((message.content ?? []) as Block[]).reduce((sum, block) => sum + blockTokens(block), 0);

const holdsToolResults = (message: MessageParam) =>
  Array.isArray(message.content) && (message.content as Block[]).some((block) => block.type === "tool_result");

// Where the kept messages can start. Every tool call stays on the same side as its result, so
// the kept part can't open with tool results. The first kept message must differ in role from
// the last summarized one, or the API merges them. That keeps Claude's thinking in the kept turns
// valid. A message right after a summary can't start them either: there would be nothing new to
// summarize.
function canKeepFrom(messages: MessageParam[], index: number) {
  const first = startsWithSummary(messages) ? 2 : 1;
  if (index < first) return false;
  const message = messages[index];
  if (message.role === messages[index - 1].role) return false;
  return message.role === "assistant" || !holdsToolResults(message);
}

// The index of the first message to keep after the summary: the longest stretch of the latest
// messages that fits in `budget` tokens. The length of `messages` keeps nothing.
export function keepFrom(messages: MessageParam[], budget = KEEP_RECENT_TOKENS) {
  let cut = messages.length;
  let size = 0;
  for (let index = messages.length - 1; index > 0; index--) {
    size += estimateTokens(messages[index]);
    if (size > budget) break;
    if (canKeepFrom(messages, index)) cut = index;
  }
  return cut;
}

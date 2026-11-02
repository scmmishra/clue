import copyPrompt from "../prompts/copy.yaml";
import { askDecisions, type DecisionAnswer, type DecisionQuestion } from "./agent/decisions";
import { chooseHelper, DEFAULT_DECISION_MODELS, FALLBACK_MODEL, helperName, type Helper } from "./agent/helpers";
import { getClient } from "./agent/provider";
import type { HelperSetting } from "./config";
import { promptText, type MessageParam } from "./session";

// /copy puts the raw Markdown of the last reply on the clipboard, so the gutters and
// line wraps on screen never reach it. /copy <request> copies only the blocks the
// request describes. A helper picks them, chosen by the `copy` setting (see agent/helpers.ts).

const {
  rules,
  question,
  yes: YES,
  no: NO,
} = copyPrompt as Record<"question" | "yes" | "no", string> & {
  rules: string[];
};
const RULES = rules.join("\n");

// A decision model picks a block when its p(yes) reaches the block kind's cutoff. Code
// gets the lower one, because people copy code far more often than prose. The cutoffs
// come from a benchmark of two decision models, so another model may need its own.
const CODE_CUTOFF = 0.6;
const PROSE_CUTOFF = 0.85;
// A heading, or a one-line paragraph that ends in a colon, labels the block after it.
// It goes to the model as that block's label and is never copied on its own.
const LABEL_MAX_CHARS = 120;
// The model only needs enough of a long block to tell what it is.
const BLOCK_CHARS = 2000;
const QUESTIONS_PER_REQUEST = 16;
const PICK_TIMEOUT_MS = 10_000;

type Kind = "code" | "paragraph" | "heading" | "list item";
export type Block = {
  id: string;
  kind: Kind;
  language?: string;
  label?: string;
  // The Markdown as written, fences included.
  text: string;
  // What lands on the clipboard. A code block's lines without the fences.
  copy: string;
};

// The text of every assistant message since the last prompt the user typed.
export function lastReply(messages: readonly MessageParam[]) {
  const start = messages.findLastIndex((message) => promptText(message) !== null);
  return messages
    .slice(start + 1)
    .flatMap((message) =>
      message.role !== "assistant"
        ? []
        : typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    )
    .join("\n\n")
    .trim();
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;

const closesFence = (line: string, marker: string) => {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && trimmed === trimmed[0].repeat(trimmed.length) && trimmed[0] === marker[0];
};

const isLabel = (block: Omit<Block, "id">) =>
  block.kind === "heading" ||
  (block.kind === "paragraph" &&
    !block.text.includes("\n") &&
    block.text.length <= LABEL_MAX_CHARS &&
    block.text.trimEnd().endsWith(":"));

// Splits Markdown into code blocks, paragraphs and list items. Labels attach to the next block.
export function splitBlocks(markdown: string): Block[] {
  const blocks: Omit<Block, "id">[] = [];
  const lines = markdown.split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n"), copy: paragraph.join("\n") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const [, indent, marker, language] = fence;
      const body: string[] = [];
      while (++i < lines.length && !closesFence(lines[i], marker)) body.push(lines[i]);
      const text = [line, ...body, ...(i < lines.length ? [lines[i]] : [])].join("\n");
      // A fence inside a list item is indented, and so is every line in it.
      const copy = body.map((row) => row.replace(new RegExp(`^ {0,${indent.length}}`), "")).join("\n");
      blocks.push({ kind: "code", language: language || undefined, text, copy });
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      blocks.push({ kind: "heading", text: line, copy: line });
    } else if (LIST_ITEM.test(line)) {
      flush();
      blocks.push({ kind: "list item", text: line, copy: line });
    } else if (/^\s{2,}\S/.test(line) && blocks.at(-1)?.kind === "list item" && !paragraph.length) {
      const item = blocks.at(-1)!;
      item.text = item.copy = `${item.text}\n${line}`;
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  const kept: Omit<Block, "id">[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const next = blocks[i + 1];
    if (isLabel(blocks[i]) && next && !isLabel(next)) next.label = blocks[i].text;
    else kept.push(blocks[i]);
  }
  return kept.map((block, index) => ({ id: `b${index + 1}`, ...block }));
}

// What the model sees: the rules, the request, and each block with its order among its kind.
export function pickState(request: string, blocks: Block[]) {
  const counts = new Map<Kind, number>();
  for (const block of blocks) counts.set(block.kind, (counts.get(block.kind) ?? 0) + 1);
  const seen = new Map<Kind, number>();
  return {
    rules: RULES,
    request,
    blocks: blocks.map((block) => {
      const n = (seen.get(block.kind) ?? 0) + 1;
      seen.set(block.kind, n);
      return {
        id: block.id,
        kind: block.kind,
        ...(block.language ? { language: block.language } : {}),
        ...(block.label ? { label: block.label } : {}),
        position: `${block.kind} ${n} of ${counts.get(block.kind)}`,
        text: block.text.length > BLOCK_CHARS ? `${block.text.slice(0, BLOCK_CHARS)}…` : block.text,
      };
    }),
  };
}

async function pickWithDecisionModel(model: string, request: string, blocks: Block[], signal: AbortSignal) {
  const state = pickState(request, blocks);
  const chunks: Block[][] = [];
  for (let i = 0; i < blocks.length; i += QUESTIONS_PER_REQUEST)
    chunks.push(blocks.slice(i, i + QUESTIONS_PER_REQUEST));
  const replies = await Promise.all(
    chunks.map((chunk) => {
      const questions: Record<string, DecisionQuestion> = Object.fromEntries(
        chunk.map((block) => [
          block.id,
          {
            type: "choice",
            instructions: question.replace("{request}", request).replace("{id}", block.id),
            criteria: { yes: YES, no: NO },
          },
        ]),
      );
      return askDecisions(model, state, questions, signal);
    }),
  );
  const answers: Record<string, DecisionAnswer> = Object.assign({}, ...replies);
  return blocks
    .filter((block) => {
      const yes = answers[block.id]?.probabilities?.yes;
      if (typeof yes !== "number") throw new Error(`${model} didn't answer for block ${block.id}`);
      return yes >= (block.kind === "code" ? CODE_CUTOFF : PROSE_CUTOFF);
    })
    .map((block) => block.id);
}

async function pickWithClaude(model: string, request: string, blocks: Block[], signal: AbortSignal) {
  const client = await getClient();
  const ids = blocks.map((block) => block.id);
  const response = await client.messages.create(
    {
      model,
      max_tokens: 1024,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { blocks: { type: "array", items: { type: "string", enum: ids } } },
            required: ["blocks"],
            additionalProperties: false,
          },
        },
      },
      system: `${RULES}\nList the ids of the blocks the request asks for. Reply with JSON only.`,
      messages: [{ role: "user", content: JSON.stringify(pickState(request, blocks)) }],
    },
    { signal },
  );
  const text = response.content.find((block) => block.type === "text")?.text ?? "{}";
  const picked = (JSON.parse(text) as { blocks?: unknown }).blocks;
  if (!Array.isArray(picked)) throw new Error(`${model} didn't list any blocks`);
  return ids.filter((id) => picked.includes(id));
}

const pickWith = ({ provider, model }: Helper, request: string, blocks: Block[]) => {
  const signal = AbortSignal.timeout(PICK_TIMEOUT_MS);
  return provider === "openrouter"
    ? pickWithDecisionModel(model, request, blocks, signal)
    : pickWithClaude(model, request, blocks, signal);
};

// The chosen helper picks the blocks. Haiku takes over when it fails or the setting can't work.
export async function pickBlocks(request: string, blocks: Block[], setting?: HelperSetting) {
  const fallback: Helper = { provider: "anthropic", model: FALLBACK_MODEL };
  let chosen: Helper | null = null;
  let failure: Error;
  try {
    chosen = chooseHelper(setting, DEFAULT_DECISION_MODELS.copy, process.env.OPENROUTER_API_KEY);
    return { ids: await pickWith(chosen, request, blocks) };
  } catch (error) {
    failure = error as Error;
  }
  if (chosen?.model === fallback.model) throw failure;
  const failed = `${chosen ? helperName(chosen) : "The copy setting"} failed, so ${helperName(fallback)} picked: ${failure.message}`;
  try {
    return { ids: await pickWith(fallback, request, blocks), note: failed };
  } catch (error) {
    throw new Error(`${failure.message}. ${(error as Error).message}`);
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const lineCount = (text: string) => plural(text.split("\n").length, "line");

// Such as "2 code blocks (sql, sh) and 1 paragraph".
function describe(blocks: Block[]) {
  const parts: string[] = [];
  const code = blocks.filter((block) => block.kind === "code");
  if (code.length) {
    const languages = [...new Set(code.flatMap((block) => (block.language ? [block.language] : [])))];
    parts.push(`${plural(code.length, "code block")}${languages.length ? ` (${languages.join(", ")})` : ""}`);
  }
  for (const kind of ["paragraph", "list item", "heading"] as const) {
    const count = blocks.filter((block) => block.kind === kind).length;
    if (count) parts.push(plural(count, kind));
  }
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
}

// Blocks are joined with a blank line. List items that sat next to each other stay one list.
function joinBlocks(all: Block[], chosen: Block[]) {
  const position = (block: Block) => all.indexOf(block);
  return chosen
    .map((block, index) => {
      const before = chosen[index - 1];
      if (!before) return block.copy;
      const sameList =
        before.kind === "list item" && block.kind === "list item" && position(block) === position(before) + 1;
      return `${sameList ? "\n" : "\n\n"}${block.copy}`;
    })
    .join("");
}

export type CopyChoice = { text: string; summary: string; note?: string } | { problem: string };

// What /copy puts on the clipboard. With no request, the whole reply.
export async function chooseCopy(reply: string, request: string, setting?: HelperSetting): Promise<CopyChoice> {
  if (!reply) return { problem: "There's no reply to copy yet." };
  if (!request) return { text: reply, summary: `Copied the last reply, ${lineCount(reply)}.` };
  const blocks = splitBlocks(reply);
  let picked: Awaited<ReturnType<typeof pickBlocks>>;
  try {
    picked = await pickBlocks(request, blocks, setting);
  } catch (error) {
    return { problem: `Couldn't pick what to copy: ${(error as Error).message}` };
  }
  const chosen = blocks.filter((block) => picked.ids.includes(block.id));
  if (!chosen.length) return { problem: `Nothing in the last reply matches "${request}".` };
  const text = joinBlocks(blocks, chosen);
  return {
    text,
    summary: `Copied ${describe(chosen)}, ${lineCount(text)}.`,
    note: picked.note,
  };
}

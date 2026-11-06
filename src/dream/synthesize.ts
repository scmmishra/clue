import { responseCost } from "../agent/models";
import { getClient } from "../agent/provider";
import dreamPrompt from "../../prompts/dream.md" with { type: "text" };
import type { Moment } from "./moments";
import type { Dream, Proposal } from "./store";

// The second pass of a dream. Sonnet reads the moments the first pass kept, with the repo's
// approved and rejected memories, and proposes memories for the user to review.

export const SYNTHESIS_MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 16_000;
const MAX_EVIDENCE = 5;

const SCHEMA = {
  type: "object",
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          memory: { type: "string" },
          replaces: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["memory", "replaces", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["proposals"],
  additionalProperties: false,
};

type Reply = { proposals: { memory: string; replaces: string; evidence: string[] }[] };

const dateOf = (at: number | null) => (at === null ? null : new Date(at).toISOString().slice(0, 10));

export async function propose(
  moments: Moment[],
  dream: Dream,
  signal: AbortSignal,
): Promise<{ proposals: Proposal[]; cost: number | null }> {
  const client = await getClient();
  const input = {
    moments: moments.map((moment) => ({
      id: moment.id,
      date: dateOf(moment.at),
      agent_said: moment.before,
      user_said: moment.text,
    })),
    memories: dream.memories.map((memory) => memory.text),
    rejected: dream.rejected,
  };
  const response = await client.messages.create(
    {
      model: SYNTHESIS_MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: dreamPrompt.trimEnd(),
      messages: [{ role: "user", content: JSON.stringify(input) }],
    },
    { signal },
  );
  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  if (response.stop_reason !== "end_turn") throw new Error(`The proposals didn't finish (${response.stop_reason}).`);
  const reply = JSON.parse(text) as Reply;
  const byId = new Map(moments.map((moment) => [moment.id, moment]));
  const existing = new Set(dream.memories.map((memory) => memory.text));
  const proposals = reply.proposals
    .map((proposal) => ({
      text: proposal.memory.trim(),
      // A memory that isn't approved can't be replaced.
      replaces: existing.has(proposal.replaces) ? proposal.replaces : null,
      evidence: proposal.evidence
        .flatMap((id) => {
          const moment = byId.get(id);
          return moment ? [{ at: moment.at, text: moment.text }] : [];
        })
        .slice(0, MAX_EVIDENCE),
    }))
    // Sonnet sometimes returns an empty memory, or one whose evidence names no moment it was sent.
    .filter((proposal) => proposal.text && proposal.evidence.length);
  return { proposals, cost: responseCost(SYNTHESIS_MODEL, response.usage) };
}

import type { ReviewSetting } from "../config";
import reviewPrompt from "../../prompts/review.yaml";
import { KNOWN_MODELS, modelLabel, resolveModel, REVIEW_FALLBACK_MODEL } from "./models";
import { getClient } from "./provider";

// Reviewer: the `review` setting picks one. Without it, Claude Haiku. Jev through
// OpenRouter only when the setting asks for it. Whichever it is, Haiku at low effort
// takes over if it breaks. Anthropic sees the conversation anyway, so that never leaks
// anything, and nothing falls back the other way.

// The reviewer's wording lives in prompts/review.yaml, embedded at build time.
const {
  instructions: REVIEW_INSTRUCTIONS,
  clear: CLEAR,
  caution: CAUTION,
  policy: POLICY,
} = reviewPrompt as Record<"instructions" | "clear" | "caution" | "policy", string>;

// `unreviewed` marks a hold that happened without any model reading the action.
export type Review = { approved: boolean; reviewer: string; reason?: string; unreviewed?: true };
export type Reviewer = { provider: "anthropic" | "openrouter"; model: string };
type Verdict = Pick<Review, "approved" | "reason">;

const JEV = /^(?:typesafe\/)?(jev(?:-[\d.]+)?)$/;
const LATEST_JEV = "typesafe/jev-1.14";
const REVIEW_TIMEOUT_MS = 20_000;
const MAX_REVIEWED_ACTION_CHARS = 8000;

// Throws when the setting can't work, which counts as a broken reviewer.
export function chooseReviewer(review: ReviewSetting = {}, openrouterKey?: string): Reviewer {
  const { model } = review;
  const jev = model?.match(JEV);
  const provider = review.provider ?? (jev ? "openrouter" : "anthropic");
  if (provider === "openrouter") {
    if (!openrouterKey) throw new Error("OPENROUTER_API_KEY isn't set");
    if (model && !jev) throw new Error(`OpenRouter can't run ${model}`);
    return { provider, model: !jev || jev[1] === "jev" ? LATEST_JEV : `typesafe/${jev[1]}` };
  }
  if (provider !== "anthropic") throw new Error(`${provider} isn't a review provider`);
  const id = resolveModel(model ?? "haiku");
  if (!KNOWN_MODELS.includes(id)) throw new Error(`${model} isn't a Claude model`);
  return { provider, model: id };
}

const reviewerName = ({ provider, model }: Reviewer) =>
  provider === "openrouter" ? "jev" : modelLabel(model).split(" ")[0];

// What OpenRouter's decisions endpoint sends back. Every field is checked before use.
type JevReply = { error?: { message?: string }; answers?: { decision?: { choice?: unknown } } };

async function askJev(model: string, state: object, signal: AbortSignal): Promise<Verdict> {
  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai"}/api/alpha/decisions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "clue",
    },
    body: JSON.stringify({
      model,
      state: JSON.stringify(state),
      questions: {
        decision: { type: "choice", instructions: REVIEW_INSTRUCTIONS, criteria: { clear: CLEAR, caution: CAUTION } },
      },
    }),
  });
  const body = (await response.json().catch(() => null)) as JevReply | null;
  if (!response.ok || body?.error) throw new Error(body?.error?.message ?? `Jev returned ${response.status}`);
  const choice = body?.answers?.decision?.choice;
  if (choice !== "clear" && choice !== "caution") throw new Error(`Jev answered ${choice}`);
  return {
    approved: choice === "clear",
    reason: choice === "clear" ? undefined : "found possible prompt injection or harmful activity",
  };
}

async function askClaude(model: string, state: object, signal: AbortSignal): Promise<Verdict> {
  const client = await getClient();
  const response = await client.messages.create(
    {
      model,
      max_tokens: 2048,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { decision: { type: "string", enum: ["clear", "caution"] }, reason: { type: "string" } },
            required: ["decision", "reason"],
            additionalProperties: false,
          },
        },
      },
      system: `${REVIEW_INSTRUCTIONS}\nclear: ${CLEAR}\ncaution: ${CAUTION}\nReply with JSON only.`,
      messages: [{ role: "user", content: JSON.stringify(state) }],
    },
    { signal },
  );
  const text = response.content.find((block) => block.type === "text")?.text ?? "{}";
  const { decision, reason } = JSON.parse(text) as { decision?: string; reason?: string };
  if (decision !== "clear" && decision !== "caution") throw new Error(`the reviewer answered ${decision}`);
  return { approved: decision === "clear", reason: decision === "clear" ? undefined : reason };
}

export async function reviewAction(
  toolName: string,
  input: unknown,
  userRequest: string,
  review: ReviewSetting | undefined,
  signal: AbortSignal,
  // For input to a running shell process: the command that started it.
  processCommand?: string,
): Promise<Review> {
  const action = JSON.stringify(input);
  // Approval covers the whole action, so the reviewer must be able to read all of it.
  if (action.length > MAX_REVIEWED_ACTION_CHARS) {
    return {
      approved: false,
      reviewer: "clue",
      reason: "the action is too long for a reviewer to read in full",
      unreviewed: true,
    };
  }
  const state = {
    review_policy: POLICY,
    user_request: userRequest.slice(0, 4000),
    pending_action_tool: toolName,
    pending_action_arguments: action,
    ...(processCommand === undefined ? {} : { process_command: processCommand.slice(0, 2000) }),
  };
  const ask = ({ provider, model }: Reviewer) => {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]);
    return provider === "openrouter" ? askJev(model, state, timeout) : askClaude(model, state, timeout);
  };
  const fallback: Reviewer = { provider: "anthropic", model: REVIEW_FALLBACK_MODEL };
  const held = (reviewer: string, ...errors: unknown[]): Review => ({
    approved: false,
    reviewer,
    reason: `the review could not finish: ${errors.map((error) => (error as Error).message).join(". ")}`,
  });

  let chosen: Reviewer | null = null;
  let failure: unknown;
  try {
    chosen = chooseReviewer(review, process.env.OPENROUTER_API_KEY);
    return { ...(await ask(chosen)), reviewer: reviewerName(chosen) };
  } catch (error) {
    failure = error;
  }
  // An interrupt isn't a broken reviewer, and Haiku shouldn't be asked the same thing twice.
  if (signal.aborted || chosen?.model === fallback.model) return held(chosen ? reviewerName(chosen) : "haiku", failure);
  try {
    return {
      ...(await ask(fallback)),
      reviewer: `haiku (${chosen ? reviewerName(chosen) : "the review setting"} failed)`,
    };
  } catch (error) {
    return held("haiku", failure, error);
  }
}

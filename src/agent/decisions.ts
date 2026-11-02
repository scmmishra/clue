// OpenRouter's decisions endpoint. A decision model answers multiple-choice questions
// about a state and doesn't write text. Helpers in helpers.ts use it.

export type DecisionQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type DecisionAnswer = { choice?: unknown; probabilities?: Record<string, number> };

// What the endpoint sends back. Every field is checked before use.
type DecisionReply = { error?: { message?: string }; answers?: Record<string, DecisionAnswer> };

export async function askDecisions(
  model: string,
  state: object,
  questions: Record<string, DecisionQuestion>,
  signal: AbortSignal,
): Promise<Record<string, DecisionAnswer>> {
  const response = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai"}/api/alpha/decisions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "clue",
    },
    body: JSON.stringify({ model, state: JSON.stringify(state), questions }),
  });
  const body = (await response.json().catch(() => null)) as DecisionReply | null;
  if (!response.ok || body?.error) throw new Error(body?.error?.message ?? `${model} returned ${response.status}`);
  return body?.answers ?? {};
}

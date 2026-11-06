import { askDecisions, type DecisionQuestion } from "../agent/decisions";
import type { Moment } from "./moments";

// The first pass of a dream. A decision model reads each moment and keeps the ones where the
// user guided the agent. Most typed messages are new tasks, questions or approvals.

const CONCURRENCY = 8;

const QUESTION: Record<string, DecisionQuestion> = {
  kind: {
    type: "choice",
    instructions:
      "A user typed `user_said` to a coding agent, right after the agent said `agent_said`. Does the message guide how the agent should work or write code?",
    criteria: {
      guidance:
        "The user corrects, rejects or pushes back on something the agent did, wrote, proposed or claimed. Or the user states a preference that applies beyond this one task, such as a rule for commits, branches, scope, abstractions, checks, tests or naming.",
      other:
        "A new task, a question, an approval, a status update, information the agent asked for, or an instruction only for this one task. Changing their own mind about requirements is not guidance.",
    },
  },
};

export type Filtered = { kept: Moment[]; failed: Moment[] };

export async function keepGuidance(
  moments: Moment[],
  model: string,
  signal: AbortSignal,
  progress: (done: number) => void,
): Promise<Filtered> {
  const kept: Moment[] = [];
  const failed: Moment[] = [];
  let next = 0;
  let done = 0;
  const work = async () => {
    while (next < moments.length && !signal.aborted) {
      const moment = moments[next++];
      try {
        const answers = await askDecisions(
          model,
          { agent_said: moment.before, user_said: moment.text },
          QUESTION,
          signal,
        );
        if (answers.kind?.choice === "guidance") kept.push(moment);
        else if (answers.kind?.choice !== "other") failed.push(moment);
      } catch {
        failed.push(moment);
      }
      progress(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, moments.length) }, work));
  return { kept, failed };
}

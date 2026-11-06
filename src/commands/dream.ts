import { DECISION_ALIASES } from "../agent/helpers";
import { MissingCredentials } from "../agent/provider";
import { keepGuidance } from "../dream/filter";
import { collectMoments, repoRoot, type Moment } from "../dream/moments";
import { loadDream, saveDream, type Dream } from "../dream/store";
import { propose, SYNTHESIS_MODEL } from "../dream/synthesize";
import { homePath, money, style } from "../ui/ansi";
import { reviewProposals } from "../ui/dream-review";

// `clue dream`: reads this repo's past sessions, keeps the messages where the user guided the
// agent, and proposes memories for the user to approve one by one. An experiment: nothing
// loads the approved memories into a session yet.

const FILTER_MODEL = DECISION_ALIASES.jev;

const say = (line: string) => process.stdout.write(`${line}\n`);

function stop(message: string): never {
  process.stderr.write(`clue: ${message}\n`);
  process.exit(1);
}

// Where the next dream starts in each session. A session with a moment the filter couldn't
// judge starts again just before it, so a later dream retries it.
function readUpTo(dream: Dream, latest: Record<string, number>, failed: Moment[]) {
  const read = { ...dream.read, ...latest };
  for (const moment of failed) read[moment.file] = Math.min(read[moment.file], moment.index - 1);
  return read;
}

const count = (number: number, one: string, many = `${one}s`) => `${number} ${number === 1 ? one : many}`;

async function review(dream: Dream) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    say(`Run clue dream in a terminal to review ${count(dream.pending.length, "proposal")}.`);
    return;
  }
  const result = await reviewProposals(dream);
  const file = homePath(saveDream(dream));
  say("");
  say(`Approved ${result.approve}, rejected ${result.reject}, skipped ${result.skip}.`);
  say(style.muted(`The dream holds ${count(dream.memories.length, "memory", "memories")}: ${file}`));
  if (dream.pending.length) say(style.muted(`Left for the next review: ${count(dream.pending.length, "proposal")}.`));
}

export async function runDream(cwd: string, { includeClaudeCode }: { includeClaudeCode: boolean }) {
  const root = repoRoot(cwd);
  if (!root) stop("clue dream works inside a git repository.");
  const dream = loadDream(root);

  // Proposals from an earlier dream come first, so no paid work is lost.
  if (dream.pending.length) {
    say(`Reviewing ${count(dream.pending.length, "proposal")} from an earlier dream.`);
    return review(dream);
  }

  const collected = collectMoments(root, dream.read, includeClaudeCode);
  const sources = includeClaudeCode ? "clue and Claude Code" : "clue";
  say(`Read ${collected.sessions} ${sources} sessions in ${homePath(root)}.`);
  say(style.muted(`${collected.typed} new messages, ${collected.moments.length} long enough to judge.`));
  if (collected.moments.length === 0) {
    dream.read = { ...dream.read, ...collected.latest };
    saveDream(dream);
    return say("Nothing new to dream about.");
  }
  if (!process.env.OPENROUTER_API_KEY) stop(`clue dream needs OPENROUTER_API_KEY, for ${FILTER_MODEL}.`);

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const total = collected.moments.length;
  const progress = (done: number) =>
    process.stdout.isTTY && process.stdout.write(`\r${style.muted(`Judging with Jev: ${done} of ${total}`)}`);
  const { kept, failed } = await keepGuidance(collected.moments, FILTER_MODEL, controller.signal, progress);
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
  if (controller.signal.aborted) stop("Interrupted. Nothing was saved.");
  say(
    `Jev kept ${kept.length} of ${total} as guidance.${failed.length ? ` ${failed.length} failed and wait for the next dream.` : ""}`,
  );

  if (kept.length === 0) {
    dream.read = readUpTo(dream, collected.latest, failed);
    saveDream(dream);
    return say("No guidance found.");
  }

  say(style.muted(`Proposing memories with ${SYNTHESIS_MODEL}…`));
  let result: Awaited<ReturnType<typeof propose>>;
  try {
    result = await propose(kept, dream, controller.signal);
  } catch (error) {
    if (error instanceof MissingCredentials) stop(error.message);
    stop(`Proposing memories failed. Nothing was saved. ${(error as Error).message}`);
  }
  // Read marks move only once the proposals are saved, so a failed run reads the same sessions again.
  dream.pending = result.proposals;
  dream.read = readUpTo(dream, collected.latest, failed);
  saveDream(dream);
  say(`${count(result.proposals.length, "proposal")} for ${money(result.cost)}.`);
  if (result.proposals.length) await review(dream);
}

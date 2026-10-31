import { COMPACTION_TRIGGER_TOKENS, modelLabel } from "../agent/models";
import type { CompactionRecord, TurnRecord } from "../session";
import { money, style, tokens } from "./ansi";

const LABEL_WIDTH = 10;
const BAR_WIDTH = 24;

const row = (label: string, value: string) => `  ${style.muted(label.padEnd(LABEL_WIDTH))}${value}`;

function contextRows(turns: TurnRecord[], compactions: CompactionRecord[]) {
  const last = turns.at(-1);
  const compactedSince = last && (compactions.at(-1)?.at ?? 0) > last.startedAt + last.ms;
  const used = compactedSince ? undefined : turns.findLast((turn) => turn.context !== undefined)?.context;
  if (used === undefined) return [row("Context", style.muted("Shows after the next reply."))];
  const share = used / COMPACTION_TRIGGER_TOKENS;
  const filled = Math.min(BAR_WIDTH, Math.round(share * BAR_WIDTH));
  const bar = style.brand("█".repeat(filled)) + style.faint("░".repeat(BAR_WIDTH - filled));
  return [
    row(
      "Context",
      `${style.accent(tokens(used))} ${style.muted(`of ${tokens(COMPACTION_TRIGGER_TOKENS)} before compaction (${Math.round(share * 100)}%)`)}`,
    ),
    row("", bar),
  ];
}

// Lines for /usage: how full the context is, what the session cost, and where the tokens went.
export function usageReport(turns: TurnRecord[], compactions: CompactionRecord[] = []) {
  if (!turns.length) return [row("Context", style.muted("No prompts yet.")), ""];
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 };
  const models = new Map<string, number>();
  let cost = 0;
  let unpriced = 0;
  for (const { usage, model, cost: turnCost } of [...turns, ...compactions]) {
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += usage[key];
    cost += turnCost ?? 0;
    if (turnCost === null) unpriced += 1;
    models.set(model, (models.get(model) ?? 0) + (turnCost ?? 0));
  }
  const prompts = `${turns.length} ${turns.length === 1 ? "prompt" : "prompts"}`;
  const allInput = total.input + total.cacheRead + total.cacheWrite;
  return [
    ...contextRows(turns, compactions),
    row(
      "Cost",
      `${style.accent(money(cost))} ${style.muted(`across ${prompts}`)}${unpriced ? style.orange(`, ${unpriced} with no known price`) : ""}`,
    ),
    row(
      "Tokens",
      style.muted(
        `${tokens(total.input)} in · ${tokens(total.cacheRead)} cache read · ${tokens(total.cacheWrite)} cache write · ${tokens(total.output)} out`,
      ),
    ),
    row(
      "Cache",
      style.muted(`${allInput ? Math.round((total.cacheRead / allInput) * 100) : 0}% of input came from the cache`),
    ),
    ...(total.webSearches
      ? [row("Web", style.muted(`${total.webSearches} ${total.webSearches === 1 ? "search" : "searches"}`))]
      : []),
    ...(models.size > 1
      ? [
          row(
            "Models",
            style.muted([...models].map(([model, spent]) => `${modelLabel(model)} ${money(spent)}`).join(" · ")),
          ),
        ]
      : []),
    "",
  ];
}

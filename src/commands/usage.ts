import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cost, modelLabel } from "../agent/models";
import { paths } from "../config";
import { projectKey, readRecords, type TurnRecord, type Usage } from "../session";
import { homePath, money, style, tokens as formatTokens, truncate } from "../ui/ansi";

// `clue usage`: what clue cost across sessions, how much input came from the cache, and where
// the money went. It reads the session files, so it sees every session, indexed or not.

// The prompt cache's default lifetime. A longer gap between prompts means the next one writes
// the conversation to the cache again.
const CACHE_LIFETIME_MS = 5 * 60_000;
const LABEL_WIDTH = 20;
const TOP_SESSIONS = 5;
const TITLE_CHARS = 48;
const DURATION = /^(\d+)([hdw])$/;
const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

const EMPTY: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 };

type Paid = { cost: number | null; model: string; usage: Usage };

export type SessionUsage = {
  id: string;
  cwd: string;
  title: string;
  cost: number;
  minimum: boolean;
  prompts: TurnRecord[];
  compactions: Paid[];
  warmUps: Paid[];
  advisorCalls: number;
};

// The milliseconds in a duration such as 30d, 12h or 2w, or null if it isn't one.
export function parseDuration(text: string) {
  const match = DURATION.exec(text);
  return match ? Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS] : null;
}

// Every session file, or only this folder's.
export function sessionFiles(cwd?: string) {
  if (!existsSync(paths.sessions)) return [];
  const folders = cwd ? [projectKey(cwd)] : readdirSync(paths.sessions);
  return folders.flatMap((folder) => {
    const dir = join(paths.sessions, folder);
    try {
      return readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(dir, name));
    } catch {
      return [];
    }
  });
}

// What one session paid for since `since`. Null when it paid for nothing in that time.
export function readSession(file: string, since = 0): SessionUsage | null {
  const session: SessionUsage = {
    id: "",
    cwd: "",
    title: "",
    cost: 0,
    minimum: false,
    prompts: [],
    compactions: [],
    warmUps: [],
    advisorCalls: 0,
  };
  let name = "";
  for (const record of readRecords(file)) {
    if (record.t === "session") {
      session.id = record.id;
      session.cwd = record.cwd;
    } else if (record.t === "name") name = record.name;
    else if (record.t === "turn" && record.turn.startedAt >= since) {
      const turn = record.turn;
      session.prompts.push(turn);
      session.title ||= turn.prompt;
      session.minimum ||= turn.costIsMinimum ?? false;
    } else if (record.t === "compacted" && record.at >= since) session.compactions.push(record);
    else if (record.t === "spend" && record.at >= since) session.warmUps.push(record);
    else if (record.t === "tool" && record.tool.kind === "advisor" && record.tool.startedAt >= since)
      session.advisorCalls += 1;
  }
  const paid = [...session.prompts, ...session.compactions, ...session.warmUps];
  if (!paid.length) return null;
  session.cost = paid.reduce((sum, record) => sum + (record.cost ?? 0), 0);
  session.title = name || session.title.split("\n")[0] || "(no prompt)";
  session.prompts.sort((a, b) => a.startedAt - b.startedAt);
  return session;
}

// The value at `share` of the way through `values`, such as 0.9 for the p90.
function percentile(values: number[], share: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

const cacheWriteCost = (model: string, tokens: number, fast: boolean) =>
  cost(model, { ...EMPTY, cacheWrite: tokens }, fast) ?? 0;

const percent = (part: number, whole: number) => {
  const share = whole ? part / whole : 0;
  return share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
};
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const BAR_CELLS = 24;

// A bar of `part` out of `whole`, in eighths of a cell. A share too small to draw still shows a sliver.
function bar(part: number, whole: number) {
  const eighths = whole ? Math.round((part / whole) * BAR_CELLS * 8) : 0;
  const drawn = "█".repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8];
  return (drawn || (part > 0 ? "▏" : "")).padEnd(BAR_CELLS);
}

const heading = (title: string) => `  ${style.accent(title)}`;
const item = (label: string, value: string) => `    ${style.muted(label.padEnd(LABEL_WIDTH))}${value}`;

// Rows that split a whole, each with a bar, its figure and its share.
function shares(rows: { label: string; value: number; figure: string }[]) {
  const whole = rows.reduce((sum, row) => sum + row.value, 0);
  const figureWidth = Math.max(...rows.map((row) => row.figure.length));
  return rows.map(
    (row) =>
      `    ${style.muted(truncate(row.label, LABEL_WIDTH - 1).padEnd(LABEL_WIDTH))}${style.brand(bar(row.value, whole))}  ${row.figure.padStart(figureWidth)}  ${style.muted(percent(row.value, whole).padStart(4))}`,
  );
}

const median = (values: number[]) => money(percentile(values, 0.5));
const p90 = (values: number[]) => money(percentile(values, 0.9));

export function usageAcross(sessions: SessionUsage[], scope: string) {
  if (!sessions.length) return ["", `  ${style.muted(`No sessions ${scope}.`)}`, ""];
  const prompts = sessions.flatMap((session) => session.prompts);
  const compactions = sessions.flatMap((session) => session.compactions);
  const warmUps = sessions.flatMap((session) => session.warmUps);
  const paid = [...prompts, ...compactions, ...warmUps];
  const total = sessions.reduce((sum, session) => sum + session.cost, 0);
  const minimum = sessions.some((session) => session.minimum);
  const unpriced = paid.filter((record) => record.cost === null).length;

  const models = new Map<string, number>();
  for (const record of paid) models.set(record.model, (models.get(record.model) ?? 0) + (record.cost ?? 0));
  const fast = prompts.reduce((sum, turn) => sum + (turn.fast ? (turn.cost ?? 0) : 0), 0);

  const tokens = { ...EMPTY };
  for (const record of paid) for (const key of Object.keys(tokens) as (keyof Usage)[]) tokens[key] += record.usage[key];

  // A gap is the time from one prompt's end to the next one's start, within a session.
  let gaps = 0;
  let longGaps = 0;
  let writes = 0;
  let writesAfterLongGaps = 0;
  for (const session of sessions) {
    session.prompts.forEach((turn, index) => {
      const written = cacheWriteCost(turn.model, turn.usage.cacheWrite, turn.fast ?? false);
      writes += written;
      const previous = session.prompts[index - 1];
      if (!previous) return;
      gaps += 1;
      if (turn.startedAt - (previous.startedAt + previous.ms) <= CACHE_LIFETIME_MS) return;
      longGaps += 1;
      writesAfterLongGaps += written;
    });
  }

  const sum = (records: Paid[]) => records.reduce((total, record) => total + (record.cost ?? 0), 0);
  const compactionCost = sum(compactions);
  const warmUpCost = sum(warmUps);
  const advisorCalls = sessions.reduce((count, session) => count + session.advisorCalls, 0);
  const sessionCosts = sessions.map((session) => session.cost);
  const promptCosts = prompts.map((turn) => turn.cost ?? 0);
  const top = [...sessions].sort((a, b) => b.cost - a.cost).slice(0, TOP_SESSIONS);
  const topWidth = Math.max(...top.map((session) => money(session.cost, session.minimum).length));

  return [
    "",
    `  ${style.accent(plural(sessions.length, "session"))} ${style.muted(`· ${plural(prompts.length, "prompt")} · ${scope}`)}`,
    "",
    heading("Cost"),
    item(
      "Total",
      `${style.accent(money(total, minimum))}${unpriced ? style.orange(`  ${unpriced} with no known price`) : ""}`,
    ),
    item("Per session", `median ${median(sessionCosts)} ${style.muted("·")} p90 ${p90(sessionCosts)}`),
    item("Per prompt", `median ${median(promptCosts)} ${style.muted("·")} p90 ${p90(promptCosts)}`),
    ...(fast ? [item("Fast mode", `${money(fast)} ${style.muted("at the fast price")}`)] : []),
    "",
    heading("Models"),
    ...shares(
      [...models]
        .sort((a, b) => b[1] - a[1])
        .map(([model, spent]) => ({ label: modelLabel(model), value: spent, figure: money(spent) })),
    ),
    "",
    heading("Cache"),
    ...shares([
      { label: "Read", value: tokens.cacheRead, figure: formatTokens(tokens.cacheRead) },
      { label: "Written", value: tokens.cacheWrite, figure: formatTokens(tokens.cacheWrite) },
      { label: "Uncached", value: tokens.input, figure: formatTokens(tokens.input) },
    ]),
    ...(gaps
      ? [
          item(
            "Gaps over 5m",
            `${longGaps} of ${gaps} ${style.muted(`(${percent(longGaps, gaps)}). The cache expires after 5 minutes.`)}`,
          ),
          item(
            "",
            `${money(writesAfterLongGaps)} ${style.muted(`of cache writes came right after them, ${percent(writesAfterLongGaps, writes)} of all writes.`)}`,
          ),
        ]
      : [item("Gaps over 5m", style.muted("No session has two prompts yet."))]),
    "",
    heading("Overhead"),
    item("Compaction", `${money(compactionCost)} ${style.muted(percent(compactionCost, total))}`),
    item("Resume warm-ups", `${money(warmUpCost)} ${style.muted(percent(warmUpCost, total))}`),
    ...(advisorCalls ? [item("Advisor calls", `${advisorCalls}${style.muted(", priced inside their prompts")}`)] : []),
    "",
    heading("Top sessions"),
    ...top.map(
      (session) =>
        `    ${money(session.cost, session.minimum).padStart(topWidth)}  ${truncate(session.title, TITLE_CHARS).padEnd(TITLE_CHARS)}  ${style.faint(homePath(session.cwd))}`,
    ),
    "",
  ];
}

export function runUsage(flags: Record<string, string | boolean>, cwd: string, now = Date.now()) {
  let since = 0;
  let scope = "all time";
  if (flags.since !== undefined) {
    const span = typeof flags.since === "string" ? parseDuration(flags.since) : null;
    if (span === null) return { error: "--since takes a duration such as 30d, 12h or 2w." };
    since = now - span;
    scope = `last ${flags.since}`;
  }
  const here = flags.here === true;
  if (here) scope += ` in ${homePath(cwd)}`;
  const sessions = sessionFiles(here ? cwd : undefined).flatMap((file) => readSession(file, since) ?? []);
  return { lines: usageAcross(sessions, scope) };
}

import type { TurnRecord } from "../session";

// Program Status Protocol (OSC 7501): tells the terminal whether clue is idle,
// working, waiting on the user, finished or failed. Terminals that don't know the
// sequence ignore it. https://www.superlogical.com/rex/docs/build/program-status

export type ProgramStatus = "idle" | "working" | "done" | "error" | "blocked-permission" | "blocked-question" | "clear";

const FIELDS: Record<Exclude<ProgramStatus, "clear">, string> = {
  idle: "state=idle",
  working: "state=working",
  done: "state=done",
  error: "state=error",
  "blocked-permission": "state=blocked:kind=permission",
  "blocked-question": "state=blocked:kind=question",
};

// Each report replaces the terminal's record, so every report repeats `app`.
export function statusReport(status: ProgramStatus) {
  return `\x1b]7501;${status === "clear" ? "state=clear" : `${FIELDS[status]}:app=clue`}\x1b\\`;
}

// null is a turn that ended in an error, with no record. The protocol reports an interrupt as idle.
export function turnStatus(turn: Pick<TurnRecord, "stop"> | null): ProgramStatus {
  if (!turn) return "error";
  return turn.stop === "interrupted" ? "idle" : "done";
}

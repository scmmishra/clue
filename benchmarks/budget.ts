// The longest clue may take, in milliseconds, from process start to a ready prompt.
// Compared with the p90 inside the process, so one slow run on a shared CI machine
// doesn't fail the build.
export const BUDGETS_MS = { launch: 10, resume: 15 };

// A problem for each wait that isn't under its budget.
export function overBudget(measured: Record<keyof typeof BUDGETS_MS, number | null>) {
  return (Object.keys(BUDGETS_MS) as (keyof typeof BUDGETS_MS)[]).flatMap((wait) => {
    const ms = measured[wait];
    if (ms === null) return [`${wait} was not measured`];
    return ms < BUDGETS_MS[wait] ? [] : [`${wait} took ${ms.toFixed(1)} ms, and its budget is under ${BUDGETS_MS[wait]} ms`];
  });
}

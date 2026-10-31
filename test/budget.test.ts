import { expect, test } from "bun:test";
import { BUDGETS_MS, overBudget } from "../benchmarks/budget";

test("times under budget pass", () => {
  expect(overBudget({ launch: BUDGETS_MS.launch - 0.1, resume: BUDGETS_MS.resume - 0.1 })).toEqual([]);
});

test("a time at the budget fails, because the budget is a strict limit", () => {
  expect(overBudget({ launch: BUDGETS_MS.launch, resume: 1 })).toEqual([
    `launch took ${BUDGETS_MS.launch.toFixed(1)} ms, and its budget is under ${BUDGETS_MS.launch} ms`,
  ]);
});

test("every wait over budget is reported", () => {
  expect(overBudget({ launch: 100, resume: 100 })).toHaveLength(2);
});

test("a wait that was not measured fails, so a broken benchmark can't pass", () => {
  expect(overBudget({ launch: null, resume: 1 })).toEqual(["launch was not measured"]);
});

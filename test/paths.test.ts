import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { absolute, isInside } from "../src/paths";

test("isInside is true for the root and for paths below it", () => {
  expect(isInside("/proj", "/proj")).toBe(true);
  expect(isInside("/proj", "/proj/src/a.ts")).toBe(true);
  expect(isInside("/proj", "/proj/..hidden")).toBe(true);
  expect(isInside("/proj", "/proj/src/../a.ts")).toBe(true);
});

test("isInside is false for siblings with the same prefix and for paths above the root", () => {
  expect(isInside("/proj", "/proj-other/a.ts")).toBe(false);
  expect(isInside("/proj", "/proj/../other")).toBe(false);
  expect(isInside("/proj", "/other")).toBe(false);
  expect(isInside("/proj/src", "/proj")).toBe(false);
});

test("absolute joins a relative path to the folder and expands a leading ~/", () => {
  expect(absolute("/proj", "src/a.ts")).toBe("/proj/src/a.ts");
  expect(absolute("/proj", "/etc/hosts")).toBe("/etc/hosts");
  expect(absolute("/proj", "~/notes.md")).toBe(`${homedir()}/notes.md`);
  expect(absolute("/proj", "a~/b")).toBe("/proj/a~/b");
});

// Prints the CHANGELOG.md section for a version, without its heading.
//   bun scripts/release-notes.ts            the version in package.json
//   bun scripts/release-notes.ts 0.2.0      another version
// Exits with an error when the section is missing or empty. The release workflow
// and CI both run it, so a version can't ship without its notes.

import { join } from "node:path";
import { version as current } from "../package.json" with { type: "json" };

const ROOT = join(import.meta.dir, "..");
const version = process.argv[2] ?? current;

const lines = (await Bun.file(join(ROOT, "CHANGELOG.md")).text()).split("\n");
// "## 0.2.0", optionally followed by a date or a link: "## [0.2.0] - 2026-11-02".
const heading = new RegExp(`^## \\[?${version.replaceAll(".", "\\.")}\\]?(\\s|$)`);
const start = lines.findIndex((line) => heading.test(line));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version}" section. Add one before releasing ${version}.`);
  process.exit(1);
}
const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
const notes = lines
  .slice(start + 1, end === -1 ? undefined : end)
  .join("\n")
  .trim();
if (!notes) {
  console.error(`The "## ${version}" section in CHANGELOG.md is empty.`);
  process.exit(1);
}
console.log(notes);

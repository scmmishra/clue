// Rebuilds dist/clue when the source changes, so `clue-dev` stays current.
//   bun run build:watch
// A running session keeps its old build. A new session starts the latest one.

import { watch } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WATCHED = ["src", "prompts"];
const SETTLE_MS = 200;

let timer: Timer | undefined;
let building = false;
let again = false;

async function build() {
  if (building) {
    again = true;
    return;
  }
  building = true;
  const start = Date.now();
  const proc = Bun.spawn([process.execPath, join(ROOT, "scripts/build.ts")], { cwd: ROOT, stdout: "ignore", stderr: "inherit" });
  const failed = (await proc.exited) !== 0;
  const time = new Date().toLocaleTimeString();
  console.log(failed ? `${time} build failed, keeping the last good build` : `${time} built dist/clue in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  building = false;
  if (again) {
    again = false;
    void build();
  }
}

for (const folder of WATCHED) {
  watch(join(ROOT, folder), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(build, SETTLE_MS);
  });
}

console.log(`watching ${WATCHED.join(", ")}`);
void build();

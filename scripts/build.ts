// Builds clue as one native executable per platform.
//   bun scripts/build.ts            this machine only
//   bun scripts/build.ts --all      macOS and Linux, arm64 and x64
// Startup flags: bytecode (no parsing at launch), a profile of which functions
// a launch uses (read first), and a lazy JIT until the first paint.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const PROFILE = join(DIST, "launch.order");
const ALL = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-arm64", "bun-linux-x64"];
const native = `bun-${process.platform}-${process.arch}`;
const targets = process.argv.includes("--all") ? ALL : [native];
// `clue upgrade` refuses anything but a release, so it never replaces a local build.
const channel = process.argv.includes("--all") ? "release" : "local";

mkdirSync(DIST, { recursive: true });

async function build(target: string, outfile: string, bytecodeOrder: string | false) {
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/main.ts")],
    minify: true,
    bytecode: true,
    define: { BUILD_CHANNEL: JSON.stringify(channel) },
    compile: {
      target: target as never,
      outfile,
      bytecodeOrder,
      jitPolicy: 8,
      // A project's .env or bunfig.toml must never configure clue itself.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

// Records which functions one launch uses, in a PTY, as a user would start clue.
async function recordProfile(binary: string) {
  const terminal = new Bun.Terminal({ cols: 100, rows: 30, data() {} });
  const proc = Bun.spawn([binary], {
    env: { ...process.env, CLUE_BENCH_READY: "1", BUN_BYTECODE_ORDER_OUT: PROFILE, CLUE_HOME: join(DIST, ".profile-home") },
    terminal,
  });
  await proc.exited;
  terminal.close();
}

const nativeOut = join(DIST, "clue");
await build(native, nativeOut, false);
await recordProfile(nativeOut);
const profile = existsSync(PROFILE) ? PROFILE : false;

for (const target of targets) {
  // Release builds are named by platform; a local build is just dist/clue.
  const outfile = targets.length === 1 ? nativeOut : join(DIST, `clue-${target.replace("bun-", "")}`);
  await build(target, outfile, profile);
  console.log(`built ${outfile}${profile ? " (with launch profile)" : ""}`);
}

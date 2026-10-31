import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { VERSION } from "../config";
import installer from "../../install.sh" with { type: "text" };

// Set by scripts/build.ts: "release" for published binaries, "local" for a build on this machine.
declare const BUILD_CHANNEL: string | undefined;

const RELEASES = "https://api.github.com/repos/scmmishra/clue/releases/latest";
const LOOKUP_TIMEOUT_MS = 10_000;

// The folder of the binary to replace. A symlink counts as the file it points at.
export function upgradeTarget(binary: string, channel: string): { dir: string } | { problem: string } {
  if (channel === "source") return { problem: "clue is running from source. Use git pull instead." };
  if (channel !== "release") return { problem: "This is a local build. Use git pull and bun run build instead." };
  return { dir: dirname(realpathSync(binary)) };
}

export const isNewer = (latest: string, current: string) => Bun.semver.order(latest.replace(/^v/, ""), current) > 0;

export async function latestTag() {
  const response = await fetch(RELEASES, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return ((await response.json()) as { tag_name: string }).tag_name;
}

function stop(message: string, code: number): never {
  process.stderr.write(`clue: ${message}\n`);
  process.exit(code);
}

// Runs the installer embedded in the binary, so there is one download path to keep correct.
export async function upgrade() {
  const target = upgradeTarget(process.execPath, typeof BUILD_CHANNEL === "string" ? BUILD_CHANNEL : "source");
  if ("problem" in target) stop(target.problem, 2);
  const env: Record<string, string | undefined> = { ...process.env, CLUE_INSTALL_DIR: target.dir };
  // CLUE_VERSION pins a tag, which may be older on purpose.
  if (!env.CLUE_VERSION && !env.CLUE_LOCAL_RELEASE) {
    console.log("Finding the latest release");
    const latest = await latestTag().catch((error) => stop(`Could not find the latest release: ${(error as Error).message}.`, 1));
    if (!isNewer(latest, VERSION)) return console.log(`clue ${VERSION} is up to date.`);
    env.CLUE_VERSION = latest;
  }
  const proc = Bun.spawn(["bash", "-c", installer], { env, stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}

import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { VERSION } from "../config";
import installer from "../../install.sh" with { type: "text" };

// The folder of the binary to replace. A symlink counts as the file it points at.
export function upgradeTarget(binary: string): { dir: string } | { problem: string } {
  const real = realpathSync(binary);
  if (basename(real) !== "clue") return { problem: "clue is running from source. Use git pull instead." };
  return { dir: dirname(real) };
}

// Runs the installer embedded in the binary, so there is one download path to keep correct.
export async function upgrade() {
  const target = upgradeTarget(process.execPath);
  if ("problem" in target) {
    process.stderr.write(`clue: ${target.problem}\n`);
    process.exit(2);
  }
  const env = { ...process.env, CLUE_INSTALL_DIR: target.dir, CLUE_CURRENT_VERSION: VERSION };
  const proc = Bun.spawn(["bash", "-c", installer], { env, stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}

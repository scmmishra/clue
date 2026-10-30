import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeTarget } from "../src/commands/upgrade";

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "clue-upgrade-")));

test("an installed binary upgrades in its own folder", () => {
  const dir = folder();
  writeFileSync(join(dir, "clue"), "");
  expect(upgradeTarget(join(dir, "clue"))).toEqual({ dir });
});

test("a symlink upgrades the real binary", () => {
  const [real, link] = [folder(), folder()];
  writeFileSync(join(real, "clue"), "");
  symlinkSync(join(real, "clue"), join(link, "clue"));
  expect(upgradeTarget(join(link, "clue"))).toEqual({ dir: real });
});

test("running from source can't upgrade", () => {
  expect(upgradeTarget(process.execPath)).toEqual({ problem: "clue is running from source. Use git pull instead." });
});

test("clue upgrade from source stops with that message", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "upgrade"], { stderr: "pipe", stdout: "ignore" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toContain("clue is running from source");
  expect(code).toBe(2);
});

const installer = join(import.meta.dir, "../install.sh");

test("the installer stops when the version is already installed, without downloading", async () => {
  const dir = folder();
  const proc = Bun.spawn(["bash", installer], { env: { ...process.env, CLUE_VERSION: "v0.1.0", CLUE_CURRENT_VERSION: "0.1.0", CLUE_INSTALL_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(stdout).toContain("clue v0.1.0 is already the latest version.");
  expect(code).toBe(0);
});

test("the installer says what it is doing, in order", async () => {
  const release = folder();
  const asset = `clue-${process.platform}-${process.arch}`;
  writeFileSync(join(release, asset), "#!/bin/sh\n");
  const hash = new Bun.CryptoHasher("sha256").update("#!/bin/sh\n").digest("hex");
  writeFileSync(join(release, "SHA256SUMS"), `${hash}  ${asset}\n`);
  const proc = Bun.spawn(["bash", installer], { env: { ...process.env, CLUE_LOCAL_RELEASE: release, CLUE_INSTALL_DIR: folder() }, stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  const steps = ["Downloading clue local", "Checking the download", "Installed clue local"].map((step) => stdout.indexOf(step));
  expect(steps.every((position) => position >= 0)).toBe(true);
  expect(steps).toEqual([...steps].sort((a, b) => a - b));
});

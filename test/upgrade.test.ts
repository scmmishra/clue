import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { isNewer, upgradeTarget } from "../src/commands/upgrade";

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "clue-upgrade-")));

test("a release build upgrades in its own folder", () => {
  const dir = folder();
  writeFileSync(join(dir, "clue"), "");
  expect(upgradeTarget(join(dir, "clue"), "release")).toEqual({ dir });
});

test("a symlink upgrades the real binary", () => {
  const [real, link] = [folder(), folder()];
  writeFileSync(join(real, "clue"), "");
  symlinkSync(join(real, "clue"), join(link, "clue"));
  expect(upgradeTarget(join(link, "clue"), "release")).toEqual({ dir: real });
});

test("running from source can't upgrade", () => {
  expect(upgradeTarget(process.execPath, "source")).toEqual({ problem: "clue is running from source. Use git pull instead." });
});

test("a local build can't upgrade, so a release never replaces it", () => {
  const dir = folder();
  writeFileSync(join(dir, "clue"), "");
  expect(upgradeTarget(join(dir, "clue"), "local")).toEqual({ problem: "This is a local build. Use git pull and bun run build instead." });
});

test.each([
  ["v0.3.0", "0.2.0", true],
  ["v0.10.0", "0.9.0", true],
  ["v1.0.0", "0.99.9", true],
  ["v0.3.0", "0.3.0", false],
  ["v0.2.0", "0.3.0", false],
])("%s is newer than %s: %p", (latest, current, expected) => {
  expect(isNewer(latest, current)).toBe(expected);
});

test("clue upgrade from source stops with that message", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "upgrade"], { stderr: "pipe", stdout: "ignore" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toContain("clue is running from source");
  expect(code).toBe(2);
});

const installer = join(import.meta.dir, "../install.sh");
const asset = `clue-${process.platform}-${process.arch}`;
const sha = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
const script = (version: string) => `#!/bin/sh\necho ${version}\n`;

// A release folder, named the way a release names its files.
function release(binary: string, options: { gzip?: boolean; plain?: boolean; badSum?: boolean } = {}) {
  const dir = folder();
  const sums: string[] = [];
  const add = (name: string, data: string | Uint8Array) => {
    writeFileSync(join(dir, name), data);
    sums.push(`${options.badSum ? "0".repeat(64) : sha(data)}  ${name}`);
  };
  if (options.plain ?? true) add(asset, binary);
  if (options.gzip) add(`${asset}.gz`, gzipSync(binary));
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return dir;
}

async function install(from: string, into = folder(), env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", installer], { env: { ...process.env, CLUE_LOCAL_RELEASE: from, CLUE_INSTALL_DIR: into, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code, target: join(into, "clue") };
}

test("the installer prefers the compressed file, and unpacks it", async () => {
  const dir = release(script("1.0.0"), { gzip: true, plain: false });
  const { code, target, stderr } = await install(dir);
  expect(code, stderr).toBe(0);
  expect(readFileSync(target, "utf8")).toBe(script("1.0.0"));
});

test("the installer uses the compressed file when a release has both", async () => {
  const dir = release(script("1.0.0"), { gzip: true });
  writeFileSync(join(dir, asset), "not this one");
  const { code, target, stderr } = await install(dir);
  expect(code, stderr).toBe(0);
  expect(readFileSync(target, "utf8")).toBe(script("1.0.0"));
});

test("the installer still reads a release with no compressed file", async () => {
  const { code, target, stderr } = await install(release(script("1.0.0")));
  expect(code, stderr).toBe(0);
  expect(readFileSync(target, "utf8")).toBe(script("1.0.0"));
});

test("a compressed file with a bad checksum installs nothing", async () => {
  const { code, target, stderr } = await install(release(script("1.0.0"), { gzip: true, plain: false, badSum: true }));
  expect(code).toBe(1);
  expect(stderr).toContain("does not match its checksum");
  expect(existsSync(target)).toBe(false);
});

test("a binary that doesn't start installs nothing, and the old one stays", async () => {
  const into = folder();
  writeFileSync(join(into, "clue"), "old");
  const { code, stderr, target } = await install(release("#!/bin/sh\nexit 3\n", { gzip: true }), into);
  expect(code).toBe(1);
  expect(stderr).toContain("does not start");
  expect(readFileSync(target, "utf8")).toBe("old");
});

test("a binary that reports another version installs nothing", async () => {
  const { code, stderr, target } = await install(release(script("1.0.0"), { gzip: true }), folder(), { CLUE_VERSION: "v2.0.0" });
  expect(code).toBe(1);
  expect(stderr).toContain("reports version 1.0.0, not 2.0.0");
  expect(existsSync(target)).toBe(false);
});

test("a binary that reports the wanted version installs", async () => {
  const { code, stderr } = await install(release(script("2.0.0"), { gzip: true }), folder(), { CLUE_VERSION: "v2.0.0" });
  expect(code, stderr).toBe(0);
});

test("the installer says what it is doing, in order", async () => {
  const { stdout, code } = await install(release(script("1.0.0"), { gzip: true }));
  expect(code).toBe(0);
  const steps = ["Downloading clue local", "Checking the download", "Installed clue local"].map((step) => stdout.indexOf(step));
  expect(steps.every((position) => position >= 0)).toBe(true);
  expect(steps).toEqual([...steps].sort((a, b) => a - b));
});

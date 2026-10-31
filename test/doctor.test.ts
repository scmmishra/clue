import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatChecks } from "../src/commands/doctor";
import { startMockApi } from "./mock-api";

let server: ReturnType<typeof startMockApi>;
beforeAll(() => {
  server = startMockApi();
});
afterAll(() => server.stop(true));

const main = join(import.meta.dir, "../src/main.ts");

async function run(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "clue-doctor-"));
  const proc = Bun.spawn(["bun", main, "doctor"], {
    cwd: home,
    env: { ...process.env, CLUE_HOME: home, ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "test", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return { stdout: Bun.stripANSI(stdout), code: await proc.exited, home };
}

test("a working setup passes and exits 0", async () => {
  const { stdout, code } = await run();
  expect(code).toBe(0);
  expect(stdout).toContain("credentials");
  expect(stdout).toMatch(/api +reached, and claude-[\w-]+ is available/);
  expect(stdout).toMatch(/mcp +no servers/);
}, 20_000);

test("an API that can't be reached fails and exits 1", async () => {
  const { stdout, code } = await run({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9" });
  expect(code).toBe(1);
  expect(stdout).toContain("✗ api");
}, 20_000);

test("broken settings are a warning, and clue doctor still exits 0", async () => {
  const home = mkdtempSync(join(tmpdir(), "clue-doctor-settings-"));
  writeFileSync(join(home, "settings.json"), "{ broken");
  const proc = Bun.spawn(["bun", main, "doctor"], {
    cwd: home,
    env: { ...process.env, CLUE_HOME: home, ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Bun.stripANSI(await new Response(proc.stdout).text());
  expect(await proc.exited).toBe(0);
  expect(stdout).toContain("! settings");
}, 20_000);

test("a terminal that answers the key query is reported", async () => {
  const home = mkdtempSync(join(tmpdir(), "clue-doctor-term-"));
  let output = "";
  const terminal = new Bun.Terminal({
    cols: 120,
    rows: 40,
    data(self, data) {
      const text = new TextDecoder().decode(data);
      output += text;
      if (text.includes("\x1b[?u")) self.write("\x1b[?1u\x1b[?62c");
    },
  });
  const proc = Bun.spawn(["bun", main, "doctor"], {
    cwd: home,
    env: {
      ...process.env,
      TMUX: "",
      CLUE_HOME: home,
      ANTHROPIC_BASE_URL: server.url.origin,
      ANTHROPIC_API_KEY: "test",
    },
    terminal,
  });
  await proc.exited;
  await Bun.sleep(50);
  terminal.close();
  expect(Bun.stripANSI(output)).toContain("reports modified keys");
}, 20_000);

test("the summary counts problems and warnings", () => {
  const lines = formatChecks([
    { status: "ok", name: "a", detail: "fine" },
    { status: "warn", name: "bb", detail: "soon" },
    { status: "fail", name: "c", detail: "broken" },
  ]).map((line) => Bun.stripANSI(line));
  expect(lines[0]).toBe("  ✓ a   fine");
  expect(lines[2]).toBe("  ✗ c   broken");
  expect(lines.at(-1)).toBe("1 problem, 1 warning.");
});

test("a clean run says so", () => {
  expect(formatChecks([{ status: "ok", name: "a", detail: "fine" }]).at(-1)).toBe("Everything looks fine.");
});

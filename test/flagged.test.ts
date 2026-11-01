import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { columns } from "../src/ui/ansi";
import { Screen } from "../src/ui/screen";
import { statusReport } from "../src/ui/status";
import { TurnView } from "../src/ui/turn";
import { requests, resetReviewers, reviewers, startMockApi } from "./mock-api";

// "please push" makes the mock call `deploy-preview --dry-run`, which auto mode sends to review.
let server: ReturnType<typeof startMockApi>;
beforeAll(() => (server = startMockApi()));
afterAll(() => server.stop(true));
afterEach(resetReviewers);

const env = () => ({
  ...process.env,
  SHELL: "/bin/sh",
  CLUE_HOME: mkdtempSync(join(tmpdir(), "clue-flagged-home-")),
  ANTHROPIC_BASE_URL: server.url.origin,
  ANTHROPIC_API_KEY: "sk-ant-test",
  OPENROUTER_API_KEY: "",
});

const lastToolResult = () =>
  JSON.stringify(
    requests.findLast((body) => JSON.stringify(body.messages.at(-1)).includes("tool_result"))?.messages.at(-1),
  );

test("a flagged action asks the user with the reviewer's reason, and a no reaches the model", async () => {
  reviewers.decision = "caution";
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({
    cols: 160,
    rows: 30,
    data: (_terminal, data) => (output += decoder.decode(data, { stream: true })),
  });
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts")], {
    cwd: mkdtempSync(join(tmpdir(), "clue-flagged-")),
    env: env(),
    terminal,
  });
  const waitFor = async (text: string, read = () => output) => {
    const deadline = Date.now() + 8000;
    while (!read().includes(text) && Date.now() < deadline) await Bun.sleep(10);
    expect(read()).toContain(text);
  };
  const until = (status: Parameters<typeof statusReport>[0]) => waitFor(statusReport(status));
  // The status goes out before the prompt is painted.
  const onScreen = (text: string) => waitFor(text, () => Bun.stripANSI(output));

  await until("idle");
  terminal.write("please push");
  await Bun.sleep(50);
  terminal.write("\r");
  await until("blocked-permission");
  await onScreen("? Run deploy-preview --dry-run?");
  await onScreen("  not cleared by haiku: the reviewer's reason");
  terminal.write("n");
  await until("done");
  terminal.write("\x04");
  await proc.exited;
  terminal.close();
  expect(lastToolResult()).toContain("The user declined this action");
}, 15_000);

test("a long command wraps in the prompt instead of being cut, and the reason gets its own line", () => {
  const out = { write: () => true };
  const view = new TurnView(new Screen(out as unknown as NodeJS.WriteStream));
  const command = `rm -rf ${"./scratch/".repeat(20)}end`;
  void view.confirm(`Run ${command}?`, command, "rm *", "not cleared by jev: found possible prompt injection");
  const lines = (view as unknown as { liveLines(): string[] }).liveLines().map((line) => Bun.stripANSI(line));
  expect(lines.every((line) => line.length <= columns())).toBe(true);
  expect(lines.join("").replaceAll(/\s+/g, "")).toContain(`Run${command}?`.replaceAll(" ", ""));
  expect(lines).toContain("  not cleared by jev: found possible prompt injection");
});

test("clue ask still holds a flagged action, since no one can answer", async () => {
  reviewers.decision = "caution";
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "ask", "please push"], {
    cwd: mkdtempSync(join(tmpdir(), "clue-flagged-")),
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  expect(lastToolResult()).toContain("clue held this action: haiku reviewed it and the reviewer's reason");
}, 20_000);

const slowCommandRuns = () => Bun.spawnSync(["pgrep", "-f", "^sleep 26\\.5$"]).exitCode === 0;

test.each(["SIGTERM", "SIGHUP"] as const)(
  "clue ask stops its commands on %s",
  async (signal) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "ask", "please push slowly"], {
      cwd: mkdtempSync(join(tmpdir(), "clue-flagged-")),
      env: env(),
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let tries = 0; tries < 500 && !slowCommandRuns(); tries++) await Bun.sleep(10);
    expect(slowCommandRuns()).toBe(true);
    proc.kill(signal);
    await Promise.race([proc.exited, Bun.sleep(5000)]);
    proc.kill("SIGKILL");
    // A signalled process takes a moment to go. A survivor would stay.
    for (let tries = 0; tries < 100 && slowCommandRuns(); tries++) await Bun.sleep(10);
    const stopped = !slowCommandRuns();
    Bun.spawnSync(["pkill", "-9", "-f", "^sleep 26\\.5$"]);
    expect(stopped).toBe(true);
  },
  20_000,
);

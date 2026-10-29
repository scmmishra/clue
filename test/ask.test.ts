import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requests, startMockApi } from "./mock-api";

let server: ReturnType<typeof startMockApi>;
const home = mkdtempSync(join(tmpdir(), "clue-test-"));

beforeAll(() => {
  server = startMockApi();
});
afterAll(() => server.stop(true));

const run = async (args: string[]) => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CLUE_HOME: home, ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
};

test("clue ask runs a tool and returns the final answer as JSON", async () => {
  const { stdout, stderr, code } = await run(["ask", "--json", "what is this package?"]);
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.final_output).toContain("The package is called **clue**");
  expect(result.tools).toBe(1);
  expect(result.cost_usd).toBeGreaterThan(0);

  // Two requests: the first asks, the second carries the tool result.
  const [first, second] = requests.slice(-2) as any[];
  expect(first.system[0].cache_control).toEqual({ type: "ephemeral" });
  expect(first.cache_control).toEqual({ type: "ephemeral" });
  expect(first.messages[0].content[0].text.startsWith("<context>")).toBe(true);
  const toolResult = second.messages.at(-1).content[0];
  expect(toolResult.type).toBe("tool_result");
  expect(toolResult.content).toContain('"name": "clue"');
  // History is append-only: the second request starts with the first request's messages, unchanged.
  expect(JSON.stringify(second.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
});

test("the system prompt and tools are byte-identical across sessions", async () => {
  await run(["ask", "first session"]);
  const a = requests.at(-1) as any;
  await run(["ask", "second session"]);
  const b = requests.at(-1) as any;
  expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
  expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
});

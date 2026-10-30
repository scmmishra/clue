import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequest, dropRejectedFeature } from "../src/agent/provider";
import { Session } from "../src/session";
import { requests, startMockApi } from "./mock-api";

let server: ReturnType<typeof startMockApi>;
const home = mkdtempSync(join(tmpdir(), "clue-test-"));

beforeAll(() => {
  server = startMockApi();
});
afterAll(() => server.stop(true));

const run = async (args: string[], options: { cwd?: string; home?: string } = {}) => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
    cwd: options.cwd ?? join(import.meta.dir, ".."),
    env: { ...process.env, CLUE_HOME: options.home ?? home, ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "" },
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

test("a session that crashed during a tool call continues, and a torn line loses nothing after it", async () => {
  const { stdout } = await run(["ask", "--json", "before the crash"]);
  const id = JSON.parse(stdout).session_id;
  const [file] = [...new Bun.Glob(`sessions/*/${id}.jsonl`).scanSync({ cwd: home, absolute: true })];
  // The crash: a tool call with no result, then a record cut off mid-line.
  const orphan = { role: "assistant", content: [{ type: "tool_use", id: "toolu_orphan", name: "shell", input: { command: "sleep 100" } }] };
  appendFileSync(file, `${JSON.stringify({ t: "message", message: orphan })}\n{"t":"tool","tool":{"id":"toolu_or`);

  const before = requests.length;
  const resumed = await run(["ask", "--resume", id, "after the crash"]);
  expect(resumed.code, resumed.stderr).toBe(0);
  const [tool, prompt] = (requests[before] as any).messages.slice(-2);
  expect(tool.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_orphan", is_error: true });
  expect(prompt.content).toBe("after the crash");

  // A third run reads the file back: the records written after the torn line are still there.
  const after = requests.length;
  await run(["ask", "--resume", id, "and again"]);
  const texts = (requests[after] as any).messages.map((message: any) => JSON.stringify(message.content));
  expect(texts.filter((text: string) => text.includes("toolu_orphan")).length).toBe(2);
  expect(texts).toContain(JSON.stringify("after the crash"));
});

test("a torn line followed by one record keeps that record", () => {
  const file = join(home, "torn.jsonl");
  const header = { t: "session", id: "torn", cwd: home, created: 1, version: "0" };
  const message = (text: string) => JSON.stringify({ t: "message", message: { role: "user", content: text } });
  writeFileSync(file, `${JSON.stringify(header)}\n${message("héllo 🎉")}\n{"t":"message",\n${message("kept")}\n`);
  expect(Session.load(file)!.messages.map((item) => item.content)).toEqual(["héllo 🎉", "kept"]);
  writeFileSync(file, `${JSON.stringify(header)}\n${message("first")}\n{"t":"mess`);
  expect(Session.load(file)!.messages.map((item) => item.content)).toEqual(["first"]);
});

test("a 400 turns off only a feature it names", () => {
  expect(dropRejectedFeature(new Error("messages.0: image exceeds the size limit"))).toBe(false);
  expect(buildRequest({ model: "claude-opus-5-5", effort: "medium", messages: [] }).context_management).toBeDefined();
});

test("clue mcp passes --, --project and --all through to the command", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clue-mcp-")));
  const mcpHome = mkdtempSync(join(tmpdir(), "clue-mcp-home-"));
  const project = join(cwd, ".mcp.json");

  await run(["mcp", "add", "local", "--", "true", "--flag"], { cwd, home: mcpHome });
  expect(JSON.parse(readFileSync(join(mcpHome, "mcp.json"), "utf8")).mcpServers.local).toEqual({ command: "true", args: ["--flag"] });

  await run(["mcp", "add", "--project", "web", "http://127.0.0.1:9/mcp"], { cwd, home: mcpHome });
  expect(JSON.parse(readFileSync(project, "utf8")).mcpServers.web.url).toBe("http://127.0.0.1:9/mcp");

  writeFileSync(project, JSON.stringify({ mcpServers: { web: { url: "http://127.0.0.1:9/mcp" }, other: { url: "http://127.0.0.1:9/mcp" } } }));
  const { stdout } = await run(["mcp", "approve", "--all"], { cwd, home: mcpHome });
  expect(stdout).toContain("Approved");
  expect(JSON.parse(readFileSync(join(mcpHome, "mcp-approvals.json"), "utf8"))[cwd].other).toBe("approved");
});

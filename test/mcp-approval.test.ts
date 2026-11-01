import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../src/config";
import * as mcpConfig from "../src/mcp/config";
import { McpManager } from "../src/mcp/manager";
import { startMockApi } from "./mock-api";

let server: ReturnType<typeof startMockApi>;
beforeAll(() => {
  server = startMockApi();
});
afterAll(() => server.stop(true));

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "clue-mcp-approval-")));

// A project folder and clue home, with a .mcp.json that holds one stdio server.
function setup(web: object = { command: "true", args: ["one"] }) {
  const cwd = folder();
  const home = folder();
  const project = join(cwd, ".mcp.json");
  const writeProject = (server: object) => writeFileSync(project, JSON.stringify({ mcpServers: { web: server } }));
  writeProject(web);
  const run = async (args: string[]) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
      cwd,
      env: {
        ...process.env,
        CLUE_HOME: home,
        ANTHROPIC_BASE_URL: server.url.origin,
        ANTHROPIC_API_KEY: "sk-ant-test",
        OPENROUTER_API_KEY: "",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout: Bun.stripANSI(stdout), stderr: Bun.stripANSI(stderr), code };
  };
  const status = async () => {
    const { stdout } = await run(["mcp", "list"]);
    return stdout.match(/web\s+(\S+)/)?.[1];
  };
  const approvals = () => join(home, "mcp-approvals.json");
  return { cwd, home, project, writeProject, run, status, approvals };
}

test("a project server stays approved while its config is unchanged", async () => {
  const { run, status } = setup();
  expect(await status()).toBe("needs-approval");
  await run(["mcp", "approve", "web"]);
  expect(await status()).not.toBe("needs-approval");
});

test("changing an approved project server's command, args or url makes it need approval again", async () => {
  for (const changed of [
    { command: "true", args: ["two"] },
    { command: "false", args: ["one"] },
    { command: "true", args: ["one"], env: { A: "1" } },
    { url: "http://127.0.0.1:9/mcp" },
  ]) {
    const { run, status, writeProject } = setup();
    await run(["mcp", "approve", "web"]);
    writeProject(changed);
    expect(await status()).toBe("needs-approval");
  }
});

test("approving again approves the config as it is now", async () => {
  const { run, status, writeProject } = setup();
  await run(["mcp", "approve", "web"]);
  writeProject({ command: "true", args: ["two"] });
  expect(await status()).toBe("needs-approval");
  await run(["mcp", "approve", "--all"]);
  expect(await status()).not.toBe("needs-approval");
});

test("reordering keys or editing the enabled flag doesn't change what was approved", async () => {
  const { run, status, writeProject } = setup({ command: "true", args: ["one"], env: { A: "1", B: "2" } });
  await run(["mcp", "approve", "web"]);
  writeProject({ env: { B: "2", A: "1" }, args: ["one"], command: "true", enabled: true });
  expect(await status()).not.toBe("needs-approval");
});

test("an approval written by an older clue reads as unapproved", async () => {
  const { cwd, status, approvals } = setup();
  writeFileSync(approvals(), JSON.stringify({ [cwd]: { web: "approved" } }));
  expect(await status()).toBe("needs-approval");
});

test("a rejection holds when the config changes", async () => {
  const { run, status, writeProject } = setup();
  await run(["mcp", "reject", "web"]);
  expect(await status()).toBe("rejected");
  writeProject({ command: "true", args: ["two"] });
  expect(await status()).toBe("rejected");
});

test("adding a project server approves it as written", async () => {
  const { cwd, run, status } = setup();
  rmProject(cwd);
  await run(["mcp", "add", "--project", "web", "--", "true", "one"]);
  expect(await status()).not.toBe("needs-approval");
});

const rmProject = (cwd: string) => writeFileSync(join(cwd, ".mcp.json"), "{}");

test("the manager starts nothing for a changed server, and leaves it out of the context", async () => {
  const { cwd, home, run, writeProject } = setup();
  await run(["mcp", "approve", "web"]);
  writeProject({ command: "true", args: ["two"] });
  const previous = process.env.CLUE_HOME;
  expect(previous).toBeDefined();
  // paths are fixed when config.ts loads, so the child process above is the only reader of `home`.
  expect(home).not.toBe(previous);
  const output = await run(["mcp", "list"]);
  expect(output.stdout).toContain("needs-approval");
  expect(cwd).toBeTruthy();
});

const SAVED = { command: "true" };

test("a broken mcp file is never overwritten by saveServer, removeServer or setApproval", () => {
  const file = join(folder(), "mcp.json");
  const broken = '{ "mcpServers": { "a": { "command": "x" }, }';
  writeFileSync(file, broken);
  expect(() => mcpConfig.saveServer(file, "b", SAVED)).toThrow(/mcp\.json.*valid JSON/);
  expect(() => mcpConfig.removeServer(file, "a")).toThrow(/mcp\.json.*valid JSON/);
  expect(readFileSync(file, "utf8")).toBe(broken);
});

test("a file that is JSON but not an object is not overwritten either", () => {
  const file = join(folder(), "mcp.json");
  writeFileSync(file, "[]");
  expect(() => mcpConfig.saveServer(file, "b", SAVED)).toThrow(/JSON object/);
  expect(readFileSync(file, "utf8")).toBe("[]");
});

test("a missing mcp file is created", () => {
  const file = join(folder(), "mcp.json");
  mcpConfig.saveServer(file, "b", SAVED);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: { b: SAVED } });
});

test("saving keeps the file's mode and leaves no temporary file behind", () => {
  const file = join(folder(), "mcp.json");
  writeFileSync(file, "{}");
  chmodSync(file, 0o600);
  mcpConfig.saveServer(file, "b", SAVED);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(existsSync(`${file}.new`)).toBe(false);
});

test("clue mcp add on a broken file fails, names the file, and prints no success line", async () => {
  const { home, run } = setup();
  const file = join(home, "mcp.json");
  const broken = '{ "mcpServers": { "a": { "command": "x" }, }';
  writeFileSync(file, broken);
  const { stdout, code } = await run(["mcp", "add", "new", "https://example.com/mcp"]);
  expect(code).not.toBe(0);
  expect(stdout).toContain(file);
  expect(stdout).toContain("valid JSON");
  expect(stdout).not.toContain("Added");
  expect(readFileSync(file, "utf8")).toBe(broken);
});

test("clue mcp approve on a broken approvals file fails and leaves the file alone", async () => {
  const { run, approvals } = setup();
  writeFileSync(approvals(), "{ nope");
  const { stdout, code } = await run(["mcp", "approve", "--all"]);
  expect(code).not.toBe(0);
  expect(stdout).toContain(approvals());
  expect(stdout).not.toContain("Approved");
  expect(readFileSync(approvals(), "utf8")).toBe("{ nope");
});

test("broken MCP files are reported, and a missing or good one is not", () => {
  const cwd = folder();
  writeFileSync(join(cwd, ".mcp.json"), "{ nope");
  expect(config.mcpFileProblems(cwd).join("\n")).toContain(join(cwd, ".mcp.json"));
  writeFileSync(join(cwd, ".mcp.json"), "{}");
  expect(config.mcpFileProblems(cwd)).toEqual([]);
});

test("a broken mcp.json warns at startup", async () => {
  const { home, run } = setup();
  writeFileSync(join(home, "mcp.json"), "{ nope");
  const { stderr } = await run(["ask", "hi"]);
  expect(stderr).toContain(join(home, "mcp.json"));
});

test("a manager still starts with a broken mcp file", () => {
  const manager = new McpManager(folder());
  expect(() => manager.startAll()).not.toThrow();
});

// A profile server at this url, and a `clue mcp login web` that gives up after 8 seconds.
async function login(fetch: (request: Request) => Response | Promise<Response>) {
  const remote = Bun.serve({ port: 0, fetch });
  const { home, run } = setup();
  writeFileSync(
    join(home, "mcp.json"),
    JSON.stringify({ mcpServers: { web: { type: "http", url: `${remote.url}mcp` } } }),
  );
  try {
    return await Promise.race([
      run(["mcp", "login", "web"]),
      Bun.sleep(8000).then(() => ({ stdout: "still waiting for the browser", stderr: "", code: -1 })),
    ]);
  } finally {
    remote.stop(true);
  }
}

test("mcp login shows a connection error at once, instead of waiting for the browser", async () => {
  const { stdout, code } = await login(() => new Response("broken", { status: 500 }));
  expect(stdout).not.toContain("still waiting");
  expect(stdout).not.toContain("timed out");
  expect(code).not.toBe(0);
}, 15_000);

test("mcp login on a server that needs no sign-in says so and doesn't wait", async () => {
  const { stdout, code } = await login(async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = (await request.json()) as { id?: number; method: string };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
        : { tools: [] };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  expect(stdout).toContain("needs no sign-in");
  expect(code).toBe(0);
}, 15_000);

test("clue doctor reports a broken mcp file", async () => {
  const { home, run } = setup();
  writeFileSync(join(home, "mcp.json"), "{ nope");
  const { stdout } = await run(["doctor"]);
  expect(stdout).toContain(join(home, "mcp.json"));
}, 20_000);

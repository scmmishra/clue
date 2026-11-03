import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/config";
import { McpManager } from "../src/mcp/manager";

// An HTTP MCP server that counts initialize calls. `failFirst` answers that many with a 500.
function httpServer(failFirst = 0) {
  let initializes = 0;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method !== "POST") return new Response(null, { status: 200 });
      const body = (await request.json()) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === "initialize" && ++initializes <= failFirst) return new Response("down", { status: 500 });
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: body.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            }
          : { tools: [] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "s" } });
    },
  });
  return { server, initializes: () => initializes };
}

const configure = (config: object) => {
  mkdirSync(join(paths.mcp, ".."), { recursive: true });
  writeFileSync(paths.mcp, JSON.stringify({ mcpServers: { test: config } }));
};

async function until(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
}

let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
  cleanup = async () => {};
  rmSync(paths.mcp, { force: true });
});

const manager = () => {
  const made = new McpManager(mkdtempSync(join(tmpdir(), "clue-mcp-life-")));
  const stop = cleanup;
  cleanup = async () => {
    await made.closeAll();
    await stop();
  };
  return made;
};

test("a closed manager's servers stay closed and don't reconnect", async () => {
  const running = httpServer();
  cleanup = async () => void running.server.stop(true);
  configure({ type: "http", url: `${running.server.url.origin}/mcp`, bearer_token_env: "NONE" });
  const mcp = manager();
  mcp.startAll();
  await until(() => mcp.servers.get("test")?.status === "ready");
  expect(mcp.servers.get("test")?.status).toBe("ready");
  await mcp.closeAll();
  await Bun.sleep(1500);
  expect(mcp.servers.get("test")?.status).toBe("closed");
  expect(running.initializes()).toBe(1);
});

test("a retry left over from a failure does nothing once a newer connect succeeded", async () => {
  const running = httpServer(1);
  cleanup = async () => void running.server.stop(true);
  configure({ type: "http", url: `${running.server.url.origin}/mcp`, bearer_token_env: "NONE" });
  const mcp = manager();
  mcp.retryMs = 200;
  mcp.startAll();
  const state = mcp.servers.get("test")!;
  await until(() => state.status === "failed");
  expect(state.status).toBe("failed");
  // What /mcp login does after the browser sign-in, while the retry timer is still pending.
  await (mcp as unknown as { connect: (s: typeof state) => Promise<void> }).connect(state);
  expect(state.status).toBe("ready");
  const client = state.client;
  await Bun.sleep(1500);
  expect(running.initializes()).toBe(2);
  expect(state.client).toBe(client);
  expect(state.status).toBe("ready");
});

test("connecting a ready server again closes the old client first", async () => {
  const running = httpServer();
  cleanup = async () => void running.server.stop(true);
  configure({ type: "http", url: `${running.server.url.origin}/mcp`, bearer_token_env: "NONE" });
  const mcp = manager();
  mcp.startAll();
  const state = mcp.servers.get("test")!;
  await until(() => state.status === "ready");
  const first = state.client!;
  let closed = false;
  const close = first.close.bind(first);
  first.close = async () => {
    closed = true;
    await close();
  };
  await (mcp as unknown as { connect: (s: typeof state) => Promise<void> }).connect(state);
  expect(closed).toBe(true);
  expect(state.client).not.toBe(first);
  expect(state.status).toBe("ready");
});

test("a server that accepts and then dies stops being retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clue-mcp-dies-"));
  const starts = join(dir, "starts");
  const script = join(dir, "server.ts");
  // Answers initialize and tools/list over stdio, then exits.
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(starts)}, "x");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id === undefined) continue;
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } }
      : { tools: [] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "tools/list") setTimeout(() => process.exit(0), 20);
  }
});
`,
  );
  appendFileSync(starts, "");
  configure({ command: process.execPath, args: [script] });
  const mcp = manager();
  mcp.retryMs = 5;
  mcp.startAll();
  const state = mcp.servers.get("test")!;
  await until(() => state.status === "failed", 15_000);
  expect(state.status).toBe("failed");
  const count = readFileSync(starts, "utf8").length;
  await Bun.sleep(500);
  expect(readFileSync(starts, "utf8").length).toBe(count);
  expect(count).toBeLessThanOrEqual(8);
}, 20_000);

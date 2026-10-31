import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/config";
import { McpManager, plainStreams } from "../src/mcp/manager";

const STREAM = "text/event-stream";
type Seen = { url: string; headers: Headers; method?: string };

function recording() {
  const seen: Seen[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: new Headers(init?.headers), method: init?.method });
    return new Response("ok");
  }) as typeof fetch;
  return { seen, wrapped: plainStreams(fetcher) };
}

test("an idle stream asks for no compression", async () => {
  const { seen, wrapped } = recording();
  await wrapped("https://x.example/mcp", { method: "GET", headers: { Accept: STREAM } });
  expect(seen[0].headers.get("accept-encoding")).toBe("identity");
  expect(seen[0].headers.get("accept")).toBe(STREAM);
});

test("a stream keeps its other headers, in any header form", async () => {
  const { seen, wrapped } = recording();
  await wrapped("https://x.example/mcp", { method: "GET", headers: new Headers({ Accept: STREAM, Authorization: "Bearer t" }) });
  expect(seen[0].headers.get("authorization")).toBe("Bearer t");
  expect(seen[0].headers.get("accept-encoding")).toBe("identity");
});

test("a tool call stays compressed", async () => {
  const { seen, wrapped } = recording();
  await wrapped("https://x.example/mcp", { method: "POST", headers: { Accept: `application/json, ${STREAM}` } });
  expect(seen[0].headers.get("accept-encoding")).toBeNull();
});

test("a plain GET, such as OAuth discovery, stays compressed", async () => {
  const { seen, wrapped } = recording();
  await wrapped("https://x.example/.well-known/oauth", { headers: { Accept: "application/json" } });
  await wrapped("https://x.example/other");
  expect(seen.map(({ headers }) => headers.get("accept-encoding"))).toEqual([null, null]);
});

const sse = (first = ": open\n\n") => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(first)) }), { headers: { "content-type": STREAM } });

// A small real MCP server, so these tests see what the SDK sends.
function mcpServer() {
  const requests: { method: string; path: string; encoding: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({ method: request.method, path, encoding: request.headers.get("accept-encoding") });
      if (path === "/sse") return sse("event: endpoint\ndata: /messages\n\n");
      if (request.method === "GET") return sse();
      if (request.method !== "POST") return new Response(null, { status: 200 });
      const body = (await request.json()) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize"
        ? { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
        : { tools: [] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "s" } });
    },
  });
  return { server, requests };
}

let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
  cleanup = async () => {};
  rmSync(paths.mcp, { force: true });
});

async function connect(config: object, ready: (requests: { method: string }[]) => boolean, running: ReturnType<typeof mcpServer>) {
  mkdirSync(join(paths.mcp, ".."), { recursive: true });
  writeFileSync(paths.mcp, JSON.stringify({ mcpServers: { test: config } }));
  const manager = new McpManager(mkdtempSync(join(tmpdir(), "clue-mcp-stream-")));
  cleanup = async () => {
    await manager.closeAll();
    running.server.stop(true);
  };
  manager.startAll();
  const deadline = Date.now() + 5000;
  while (!ready(running.requests) && Date.now() < deadline) await Bun.sleep(10);
}

test("the streamable HTTP transport opens its idle stream uncompressed, and keeps compression on calls", async () => {
  const running = mcpServer();
  await connect({ type: "http", url: `${running.server.url.origin}/mcp`, bearer_token_env: "CLUE_NO_TOKEN" }, (all) => all.some(({ method }) => method === "GET"), running);
  const gets = running.requests.filter(({ method }) => method === "GET");
  const posts = running.requests.filter(({ method }) => method === "POST");
  expect(gets.length).toBeGreaterThan(0);
  expect(gets.every(({ encoding }) => encoding === "identity")).toBe(true);
  expect(posts.length).toBeGreaterThan(0);
  expect(posts.every(({ encoding }) => encoding !== "identity")).toBe(true);
});

test("the SSE transport opens its stream uncompressed too", async () => {
  const running = mcpServer();
  await connect({ type: "sse", url: `${running.server.url.origin}/sse`, bearer_token_env: "CLUE_NO_TOKEN" }, (all) => all.some(({ method }) => method === "GET"), running);
  expect(running.requests.find(({ method }) => method === "GET")?.encoding).toBe("identity");
});

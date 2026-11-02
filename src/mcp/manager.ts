import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, paths, VERSION } from "../config";
import { approvalOf, loadServers, transportOf, type ServerEntry } from "./config";

// Connects MCP servers in the background. Their tools never enter the request's
// tool list: the model finds them with capability_search and calls them with
// mcp_call, so connecting a server doesn't change what Claude has cached.

const MAX_FAILURES = 8;
// A connection that drops sooner than this counts as a failure, so a server that accepts and
// then dies stops being retried instead of looping forever.
const STABLE_MS = 30_000;
const CALLBACK_PORT = 33418;
const CALLBACK_PATH = "/mcp/callback";

export type McpTool = { server: string; name: string; description: string; inputSchema: unknown };

export type ServerStatus =
  "starting" | "ready" | "failed" | "needs-approval" | "rejected" | "disabled" | "needs-login" | "closed";

// The moves a server can make. Anything else is a late event from a connection that no
// longer counts, such as a retry timer firing after the manager closed, and is ignored.
// "closed" is final: a closed server never reconnects.
const MOVES: Record<ServerStatus, readonly ServerStatus[]> = {
  starting: ["starting", "ready", "failed", "needs-login", "closed"],
  ready: ["starting", "failed", "closed"],
  failed: ["starting", "closed"],
  "needs-login": ["starting", "closed"],
  "needs-approval": ["closed"],
  rejected: ["closed"],
  disabled: ["closed"],
  closed: [],
};

export type ServerState = {
  entry: ServerEntry;
  status: ServerStatus;
  error?: string;
  tools: McpTool[];
  client?: Client;
  failures: number;
  // Counts connection attempts. Callbacks from an older attempt see a newer number and stop.
  generation: number;
};

const authFile = (name: string) => join(paths.mcpAuth, `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

type StoredAuth = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };

// Stores OAuth state for one server under ~/.clue/mcp-auth/.
class StoredAuthProvider implements OAuthClientProvider {
  constructor(
    private name: string,
    private onRedirect: (url: URL) => void,
  ) {}
  private read(): StoredAuth {
    try {
      return JSON.parse(readFileSync(authFile(this.name), "utf8")) as StoredAuth;
    } catch {
      return {};
    }
  }
  private write(update: Partial<StoredAuth>) {
    ensureDir(paths.mcpAuth);
    writeFileSync(authFile(this.name), JSON.stringify({ ...this.read(), ...update }), { mode: 0o600 });
  }
  get redirectUrl() {
    return `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "clue",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.read().client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.write({ client });
  }
  tokens() {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.write({ tokens });
  }
  redirectToAuthorization(url: URL) {
    this.onRedirect(url);
  }
  saveCodeVerifier(verifier: string) {
    this.write({ verifier });
  }
  codeVerifier() {
    return this.read().verifier ?? "";
  }
}

// The stream an MCP server keeps open while clue is idle carries a few small messages, so
// compressing it saves nothing. When a compressed stream breaks, Bun writes straight to the
// terminal, over the input. Everything else stays compressed.
export const plainStreams = (fetcher: typeof fetch = fetch) =>
  ((url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const isStream = (init?.method ?? "GET") === "GET" && headers.get("accept")?.includes("text/event-stream");
    if (!isStream) return fetcher(url, init);
    headers.set("Accept-Encoding", "identity");
    return fetcher(url, { ...init, headers });
  }) as typeof fetch;

export const hasLogin = (name: string) => existsSync(authFile(name));
export const forgetLogin = (name: string) => rmSync(authFile(name), { force: true });

async function openBrowser(url: string) {
  const command = process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

export class McpManager {
  servers = new Map<string, ServerState>();
  // The first retry's delay. Each failure doubles it, up to 30 seconds.
  retryMs = 500;

  constructor(private cwd: string) {}

  // Moves a server to `to` when the table allows it. False means the move was refused.
  private transition(state: ServerState, to: ServerStatus) {
    if (!MOVES[state.status].includes(to)) return false;
    state.status = to;
    return true;
  }

  configuredNames() {
    return loadServers(this.cwd)
      .filter(
        (entry) =>
          entry.config.enabled !== false && (entry.scope === "profile" || approvalOf(this.cwd, entry) === "approved"),
      )
      .map((entry) => entry.name);
  }

  // Starts every enabled, approved server. Returns at once; connections finish in the background.
  startAll() {
    for (const entry of loadServers(this.cwd)) {
      const old = this.servers.get(entry.name);
      if (old) void this.close(old);
      const approval = entry.scope === "project" ? approvalOf(this.cwd, entry) : "approved";
      const status: ServerStatus =
        entry.config.enabled === false
          ? "disabled"
          : approval === "rejected"
            ? "rejected"
            : approval !== "approved"
              ? "needs-approval"
              : "starting";
      const state: ServerState = { entry, status, tools: [], failures: 0, generation: 0 };
      this.servers.set(entry.name, state);
      if (status === "starting") void this.connect(state);
    }
  }

  async reload() {
    await this.closeAll();
    this.servers.clear();
    this.startAll();
  }

  // One attempt per server at a time: a new attempt closes the old client and bumps the
  // generation, so anything the old attempt does later is ignored.
  private async connect(state: ServerState, interactiveLogin = false): Promise<void> {
    if (!this.transition(state, "starting")) return;
    const generation = ++state.generation;
    this.dropClient(state);
    state.error = undefined;
    const current = () => state.generation === generation && state.status === "starting";
    try {
      const [{ Client }, transport] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        this.transport(state, interactiveLogin),
      ]);
      if (!current()) return;
      const client = new Client({ name: "clue", version: VERSION });
      // Set before connecting, so closeAll can stop a server that is still starting.
      state.client = client;
      await client.connect(transport);
      const listed = await client.listTools();
      if (!current()) return void client.close().catch(() => {});
      state.tools = listed.tools.map((tool) => ({
        server: state.entry.name,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      }));
      this.transition(state, "ready");
      const connectedAt = Date.now();
      client.onclose = () => {
        if (state.generation !== generation || state.status !== "ready") return;
        state.client = undefined;
        state.tools = [];
        // Only a connection that stayed up clears the count, so quick drops add up to MAX_FAILURES.
        state.failures = Date.now() - connectedAt < STABLE_MS ? state.failures + 1 : 0;
        if (state.failures >= MAX_FAILURES) {
          this.transition(state, "failed");
          state.error = "The server keeps disconnecting.";
          return;
        }
        this.transition(state, "starting");
        void this.retry(state, generation);
      };
    } catch (error) {
      if (!current()) return;
      this.dropClient(state);
      const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
      if (!current()) return;
      if (error instanceof UnauthorizedError) {
        this.transition(state, "needs-login");
        state.error = `Sign in with /mcp login ${state.entry.name}`;
      } else {
        state.failures += 1;
        this.transition(state, "failed");
        state.error = (error as Error).message;
        if (state.failures < MAX_FAILURES) void this.retry(state, generation);
      }
    }
  }

  // Reconnects after a failure or a drop, unless something else moved the server on meanwhile:
  // a newer attempt, a sign-in, or closeAll.
  private async retry(state: ServerState, generation: number) {
    const delay = Math.min(30_000, this.retryMs * 2 ** state.failures);
    await Bun.sleep(delay);
    if (state.generation !== generation || this.servers.get(state.entry.name) !== state) return;
    if (state.status !== "failed" && state.status !== "starting") return;
    await this.connect(state);
  }

  // Closes a client without letting its onclose start a reconnect.
  private dropClient(state: ServerState) {
    const client = state.client;
    state.client = undefined;
    state.tools = [];
    if (!client) return;
    client.onclose = undefined;
    return client.close().catch(() => {});
  }

  private close(state: ServerState) {
    this.transition(state, "closed");
    state.generation += 1;
    return this.dropClient(state);
  }

  private async transport(state: ServerState, interactiveLogin: boolean) {
    const { config, name } = state.entry;
    const kind = transportOf(config);
    if (kind === "stdio") {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      return new StdioClientTransport({
        command: config.command ?? "",
        args: config.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
        cwd: this.cwd,
        stderr: "ignore",
      });
    }
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    if (config.bearer_token_env && process.env[config.bearer_token_env])
      headers.Authorization = `Bearer ${process.env[config.bearer_token_env]}`;
    const authProvider = config.bearer_token_env
      ? undefined
      : new StoredAuthProvider(name, (url) => {
          if (interactiveLogin) void openBrowser(url.toString());
        });
    const url = new URL(config.url ?? "");
    if (kind === "sse") {
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      return new SSEClientTransport(url, { authProvider, requestInit: { headers }, fetch: plainStreams() });
    }
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    return new StreamableHTTPClientTransport(url, { authProvider, requestInit: { headers }, fetch: plainStreams() });
  }

  // Browser sign-in: opens the authorization page and waits for the redirect on a local port.
  async login(name: string, report: (text: string) => void): Promise<void> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`No server named ${name}.`);
    if (transportOf(state.entry.config) === "stdio") throw new Error(`${name} runs locally and has no sign-in.`);
    const code = new Promise<string>((resolve, reject) => {
      const server = Bun.serve({
        port: CALLBACK_PORT,
        hostname: "127.0.0.1",
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== CALLBACK_PATH) return new Response("Not found", { status: 404 });
          const value = url.searchParams.get("code");
          setTimeout(() => server.stop(), 100);
          if (!value) {
            reject(new Error(url.searchParams.get("error_description") ?? "Sign-in was cancelled."));
            return new Response("Sign-in failed. You can close this tab.");
          }
          resolve(value);
          return new Response("Signed in to clue. You can close this tab.");
        },
      });
      setTimeout(() => {
        server.stop();
        reject(new Error("Sign-in timed out after 5 minutes."));
      }, 300_000).unref();
    });
    report(`Opening the browser to sign in to ${name}…`);
    const transport = (await this.transport(state, true)) as { finishAuth?: (code: string) => Promise<void> };
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "clue", version: VERSION });
    try {
      await client.connect(transport as never);
      await client.close();
    } catch {
      // Expected: the first connection fails with UnauthorizedError and opens the browser.
    }
    const authorization = await code;
    await transport.finishAuth?.(authorization);
    await this.connect(state);
  }

  tools(): McpTool[] {
    return [...this.servers.values()].flatMap((state) => (state.status === "ready" ? state.tools : []));
  }

  // Waits briefly for servers still starting, so a search right after launch sees them.
  async settle(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while ([...this.servers.values()].some((state) => state.status === "starting") && Date.now() < deadline)
      await Bun.sleep(100);
  }

  async call(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal) {
    const state = this.servers.get(server);
    if (!state?.client || state.status !== "ready") {
      throw new Error(
        state
          ? `${server} is ${state.status}${state.error ? `: ${state.error}` : ""}.`
          : `No MCP server named ${server}.`,
      );
    }
    return state.client.callTool({ name: tool, arguments: args }, undefined, { signal });
  }

  // Every server is marked closed before its client closes, so the close can't trigger a reconnect.
  async closeAll() {
    await Promise.allSettled([...this.servers.values()].map((state) => this.close(state)));
  }
}

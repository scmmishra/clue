import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, paths, VERSION } from "../config";
import { approvalOf, loadServers, transportOf, type ServerEntry } from "./config";

// Connects MCP servers in the background. Their tools never enter the request's
// tool list: the model finds them with capability_search and calls them with
// mcp_call, so connecting a server doesn't change what Claude has cached.

const MAX_FAILURES = 8;
const CALLBACK_PORT = 33418;
const CALLBACK_PATH = "/mcp/callback";

export type McpTool = { server: string; name: string; description: string; inputSchema: unknown };

export type ServerState = {
  entry: ServerEntry;
  status: "starting" | "ready" | "failed" | "needs-approval" | "rejected" | "disabled" | "needs-login";
  error?: string;
  tools: McpTool[];
  client?: Client;
  failures: number;
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
      return JSON.parse(readFileSync(authFile(this.name), "utf8"));
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
  private listeners = new Set<() => void>();

  constructor(private cwd: string) {}

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  configuredNames() {
    return loadServers(this.cwd)
      .filter((entry) => entry.config.enabled !== false && (entry.scope === "profile" || approvalOf(this.cwd, entry.name) === "approved"))
      .map((entry) => entry.name);
  }

  // Starts every enabled, approved server. Returns at once; connections finish in the background.
  startAll() {
    for (const entry of loadServers(this.cwd)) {
      const state: ServerState = { entry, status: "starting", tools: [], failures: 0 };
      this.servers.set(entry.name, state);
      if (entry.config.enabled === false) state.status = "disabled";
      else if (entry.scope === "project" && approvalOf(this.cwd, entry.name) === "rejected") state.status = "rejected";
      else if (entry.scope === "project" && approvalOf(this.cwd, entry.name) !== "approved") state.status = "needs-approval";
      else void this.connect(state);
    }
    this.changed();
  }

  async reload() {
    await this.closeAll();
    this.servers.clear();
    this.startAll();
  }

  private async connect(state: ServerState, interactiveLogin = false): Promise<void> {
    state.status = "starting";
    state.error = undefined;
    this.changed();
    try {
      const [{ Client }, transport] = await Promise.all([import("@modelcontextprotocol/sdk/client/index.js"), this.transport(state, interactiveLogin)]);
      const client = new Client({ name: "clue", version: VERSION });
      await client.connect(transport);
      const listed = await client.listTools();
      state.client = client;
      state.tools = listed.tools.map((tool) => ({
        server: state.entry.name,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      }));
      state.status = "ready";
      state.failures = 0;
      client.onclose = () => {
        if (state.status !== "ready") return;
        state.status = "starting";
        void this.retry(state);
      };
    } catch (error) {
      const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
      if (error instanceof UnauthorizedError) {
        state.status = "needs-login";
        state.error = `Sign in with /mcp login ${state.entry.name}`;
      } else {
        state.failures += 1;
        state.status = "failed";
        state.error = (error as Error).message;
        if (state.failures < MAX_FAILURES) void this.retry(state);
      }
    }
    this.changed();
  }

  private async retry(state: ServerState) {
    const delay = Math.min(30_000, 500 * 2 ** state.failures);
    await Bun.sleep(delay);
    if (this.servers.get(state.entry.name) === state) await this.connect(state);
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
    if (config.bearer_token_env && process.env[config.bearer_token_env]) headers.Authorization = `Bearer ${process.env[config.bearer_token_env]}`;
    const authProvider = config.bearer_token_env ? undefined : new StoredAuthProvider(name, (url) => {
      if (interactiveLogin) void openBrowser(url.toString());
    });
    const url = new URL(config.url ?? "");
    if (kind === "sse") {
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      return new SSEClientTransport(url, { authProvider, requestInit: { headers } });
    }
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    return new StreamableHTTPClientTransport(url, { authProvider, requestInit: { headers } });
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

  approved(name: string) {
    const state = this.servers.get(name);
    if (state) void this.connect(state);
  }

  tools(): McpTool[] {
    return [...this.servers.values()].flatMap((state) => (state.status === "ready" ? state.tools : []));
  }

  // Waits briefly for servers still starting, so a search right after launch sees them.
  async settle(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while ([...this.servers.values()].some((state) => state.status === "starting") && Date.now() < deadline) await Bun.sleep(100);
  }

  async call(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal) {
    const state = this.servers.get(server);
    if (!state?.client || state.status !== "ready") {
      throw new Error(state ? `${server} is ${state.status}${state.error ? `: ${state.error}` : ""}.` : `No MCP server named ${server}.`);
    }
    return state.client.callTool({ name: tool, arguments: args }, undefined, { signal });
  }

  async closeAll() {
    await Promise.allSettled([...this.servers.values()].map((state) => state.client?.close()));
  }
}

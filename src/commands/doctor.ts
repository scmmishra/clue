import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getClient } from "../agent/provider";
import { resolveAuth, type AuthSource } from "../auth";
import { CLUE_HOME, loadSettings, paths, settingsWarnings, VERSION } from "../config";
import { resolveModel } from "../agent/models";
import { McpManager } from "../mcp/manager";
import { style, width } from "../ui/ansi";
import { isNewer, latestTag } from "./upgrade";

export type Check = { status: "ok" | "warn" | "fail"; name: string; detail: string };

const API_TIMEOUT_MS = 8_000;
const KEY_QUERY_TIMEOUT_MS = 300;
const MCP_TIMEOUT_MS = 5_000;
// Asks which kitty key modes are on, then for the device attributes that every terminal answers.
const KEY_QUERY = "\x1b[?u\x1b[c";
const ICONS = { ok: style.green("✓"), warn: style.orange("!"), fail: style.red("✗") };
const AUTH_LABELS: Record<AuthSource, string> = {
  env: "from the environment",
  "ant-profile": "from `ant auth login`",
  "clue-login": "from `clue login`",
  none: "",
};

const ok = (name: string, detail: string): Check => ({ status: "ok", name, detail });
const warn = (name: string, detail: string): Check => ({ status: "warn", name, detail });
const fail = (name: string, detail: string): Check => ({ status: "fail", name, detail });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function versionCheck() {
  try {
    const latest = await latestTag();
    if (isNewer(latest, VERSION)) return warn("version", `${VERSION}. ${latest} is available. Run \`clue upgrade\`.`);
    return ok("version", `${VERSION}, up to date`);
  } catch (error) {
    return warn("version", `${VERSION}. The latest release couldn't be checked: ${message(error)}`);
  }
}

async function credentialChecks() {
  const auth = await resolveAuth();
  if (auth.source === "none") return [fail("credentials", "None found. Run `clue login`, or set ANTHROPIC_API_KEY.")];
  const credentials = ok("credentials", AUTH_LABELS[auth.source]);
  const model = resolveModel(loadSettings({}).model);
  try {
    const client = await getClient();
    await client.models.retrieve(model, {}, { timeout: API_TIMEOUT_MS, maxRetries: 0 });
    return [credentials, ok("api", `reached, and ${model} is available`)];
  } catch (error) {
    return [credentials, fail("api", message(error))];
  }
}

function settingsCheck() {
  const warnings = settingsWarnings();
  return warnings.length ? warnings.map((text) => warn("settings", text)) : [ok("settings", paths.settings)];
}

function homeCheck() {
  const probe = join(CLUE_HOME, `.doctor-${process.pid}`);
  try {
    mkdirSync(CLUE_HOME, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe);
    return ok("home", CLUE_HOME);
  } catch (error) {
    return fail("home", `${CLUE_HOME} isn't writable: ${message(error)}`);
  }
}

function toolChecks() {
  return [
    Bun.which("git") ? ok("git", "installed") : warn("git", "Not found. The file picker and git context need it."),
    Bun.which("rg") ? ok("ripgrep", "installed") : warn("ripgrep", "Not found. Search uses its slower fallback."),
  ];
}

async function mcpChecks(cwd: string) {
  const manager = new McpManager(cwd);
  manager.startAll();
  await manager.settle(MCP_TIMEOUT_MS);
  const checks = [...manager.servers.values()].flatMap(({ entry, status, error, tools }) => {
    const name = `mcp ${entry.name}`;
    if (status === "ready") return [ok(name, `${tools.length} tools`)];
    if (status === "failed") return [fail(name, error ?? "failed to start")];
    if (status === "disabled" || status === "rejected") return [];
    return [warn(name, status)];
  });
  await manager.closeAll();
  return checks.length ? checks : [ok("mcp", "no servers")];
}

async function reportsKeys() {
  const { stdin, stdout } = process;
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  const reply = await new Promise<string>((resolve) => {
    let text = "";
    const done = () => {
      clearTimeout(timer);
      stdin.off("data", read);
      resolve(text);
    };
    const read = (chunk: string) => {
      text += chunk;
      if (/\x1b\[\?[\d;]*c/.test(text)) done();
    };
    const timer = setTimeout(done, KEY_QUERY_TIMEOUT_MS);
    stdin.on("data", read);
    stdout.write(KEY_QUERY);
  });
  stdin.setRawMode(false);
  stdin.pause();
  return /\x1b\[\?\d+u/.test(reply);
}

async function terminalChecks() {
  const name = process.env.TERM_PROGRAM ?? process.env.TERM ?? "unknown";
  if (!process.stdin.isTTY || !process.stdout.isTTY) return [ok("terminal", `${name}, not interactive`)];
  if (process.env.TMUX) return [warn("terminal", `${name} in tmux. shift+enter needs alt+enter here.`)];
  if (await reportsKeys()) return [ok("terminal", `${name}, reports modified keys`)];
  return [warn("terminal", `${name} doesn't report modified keys. Use alt+enter for a new line.`)];
}

export function formatChecks(checks: Check[]) {
  const size = Math.max(...checks.map((check) => width(check.name))) + 2;
  const lines = checks.map(
    ({ status, name, detail }) => `  ${ICONS[status]} ${name.padEnd(size)}${style.muted(detail)}`,
  );
  const count = (status: Check["status"]) => checks.filter((check) => check.status === status).length;
  const [failed, warned] = [count("fail"), count("warn")];
  const plural = (size: number, word: string) => `${size} ${word}${size === 1 ? "" : "s"}`;
  const summary =
    failed || warned ? `${plural(failed, "problem")}, ${plural(warned, "warning")}.` : "Everything looks fine.";
  return [...lines, "", summary];
}

export async function doctor() {
  const terminal = await terminalChecks();
  const groups = await Promise.all([versionCheck(), credentialChecks(), mcpChecks(process.cwd())]);
  const checks = [groups[0], ...groups[1], settingsCheck(), homeCheck(), toolChecks(), terminal, groups[2]].flat();
  console.log(formatChecks(checks).join("\n"));
  process.exit(checks.some((check) => check.status === "fail") ? 1 : 0);
}

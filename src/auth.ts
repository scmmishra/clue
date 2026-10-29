import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLUE_HOME, ensureDir, paths } from "./config";

// Credentials, in the order clue checks them:
// 1. ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment.
// 2. A profile saved by `ant auth login`, which the SDK reads by itself.
// 3. A key saved by `clue login`, in the OS keychain through Bun.secrets.

const SECRET_SERVICE = "clue";
const SECRET_NAME = "anthropic-api-key";

export type AuthSource = "env" | "ant-profile" | "clue-login" | "none";

function antProfileExists() {
  const configDir = process.env.ANTHROPIC_CONFIG_DIR ?? join(homedir(), ".config", "anthropic");
  const credentials = join(configDir, "credentials");
  try {
    return existsSync(credentials) && readdirSync(credentials).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

async function readStoredKey(): Promise<string | null> {
  try {
    const key = await Bun.secrets.get({ service: SECRET_SERVICE, name: SECRET_NAME });
    if (key) return key;
  } catch {
    // No keychain or secret service available. Fall back to the file.
  }
  try {
    return readFileSync(paths.credentials, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export async function resolveAuth(): Promise<{ source: AuthSource; apiKey?: string }> {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return { source: "env" };
  if (antProfileExists()) return { source: "ant-profile" };
  const key = await readStoredKey();
  if (key) return { source: "clue-login", apiKey: key };
  return { source: "none" };
}

// Saves the key in the OS keychain (macOS Keychain, libsecret on Linux), or a private file without one.
export async function storeKey(key: string) {
  try {
    await Bun.secrets.set({ service: SECRET_SERVICE, name: SECRET_NAME, value: key });
    return process.platform === "darwin" ? "the macOS Keychain" : "the system keyring";
  } catch {
    ensureDir(CLUE_HOME);
    writeFileSync(paths.credentials, `${key}\n`, { mode: 0o600 });
    return paths.credentials;
  }
}

export async function removeKey() {
  try {
    await Bun.secrets.delete({ service: SECRET_SERVICE, name: SECRET_NAME });
  } catch {}
  try {
    writeFileSync(paths.credentials, "", { mode: 0o600 });
  } catch {}
}

export const antInstalled = () => Bun.which("ant") !== null;

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptImage } from "../session";
import { encodeImage } from "../tools/files";

// A terminal passes on pasted text, not pictures, so an image comes from the system
// clipboard directly. macOS only: osascript writes the clipboard to a file as PNG.
export const clipboardSupported = process.platform === "darwin";

// The keyboard waits for this read, so it can't be allowed to hang.
const READ_TIMEOUT_MS = 5000;

// The clipboard's text, for ctrl+v and /paste when it holds no image. Empty when there's none.
export async function clipboardText(): Promise<string> {
  try {
    const proc = Bun.spawn(["pbpaste"], { stdout: "pipe", stderr: "ignore", timeout: READ_TIMEOUT_MS });
    const text = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? text : "";
  } catch {
    return "";
  }
}

export async function clipboardImage(): Promise<PromptImage | null> {
  const dir = mkdtempSync(join(tmpdir(), "clue-clipboard-"));
  const file = join(dir, "clipboard.png");
  const script = [
    `set outFile to POSIX file "${file}"`,
    "set pngData to the clipboard as «class PNGf»",
    "set fileRef to open for access outFile with write permission",
    "set eof fileRef to 0",
    "write pngData to fileRef",
    "close access fileRef",
  ].join("\n");
  try {
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: READ_TIMEOUT_MS,
    });
    if ((await proc.exited) !== 0) return null;
    return (await encodeImage(file, statSync(file).size)).block;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

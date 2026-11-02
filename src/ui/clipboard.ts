import { existsSync } from "node:fs";
import type { PromptImage } from "../session";
import { isLargeImage, MAX_IMAGE_BYTES, shrinkImage } from "../tools/files";

// A terminal passes on pasted text, not pictures, so an image comes from the system
// clipboard directly. macOS only, since text comes from pbpaste.
export const clipboardSupported = process.platform === "darwin";

// The keyboard waits for these reads and writes, so they can't be allowed to hang.
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

// Puts text on the clipboard. False when that didn't work. pbcopy reads its input in
// the locale's encoding, so LANG is set for anything outside ASCII.
// Tests set CLUE_TEST_CLIPBOARD_OUT to a file, which gets the text in its place.
export async function writeClipboard(text: string): Promise<boolean> {
  const fake = process.env.CLUE_TEST_CLIPBOARD_OUT;
  if (fake !== undefined) {
    await Bun.write(fake, text);
    return true;
  }
  try {
    const proc = Bun.spawn(["pbcopy"], {
      stdin: Buffer.from(text),
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, LANG: "en_US.UTF-8" },
      timeout: READ_TIMEOUT_MS,
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

// Tests point this at an image file, or at a missing one for an empty clipboard,
// so the test machine's clipboard stays out of it.
function readClipboard() {
  const fake = process.env.CLUE_TEST_CLIPBOARD_IMAGE;
  if (fake !== undefined) return existsSync(fake) ? new Bun.Image(fake) : null;
  return Bun.Image.fromClipboard();
}

// The clipboard can hold TIFF or HEIC, which Claude doesn't take, so the image is
// always re-encoded: PNG to keep it lossless, webp when it's large.
export async function clipboardImage(): Promise<PromptImage | null> {
  try {
    const image = readClipboard();
    if (!image) return null;
    const { width, height } = await image.metadata();
    let png = isLargeImage(width, height) ? "" : await image.png().toBase64();
    if ((png.length * 3) / 4 > MAX_IMAGE_BYTES) png = "";
    const data = png || (await shrinkImage(image));
    return { type: "image", source: { type: "base64", media_type: png ? "image/png" : "image/webp", data } };
  } catch {
    return null;
  }
}

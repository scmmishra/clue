import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipboardImage } from "../src/ui/clipboard";

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const onClipboard = async (width: number, height: number, format: "png" | "jpeg") => {
  const file = join(mkdtempSync(join(tmpdir(), "clue-clipboard-test-")), `clip.${format}`);
  const image = new Bun.Image(PNG).resize(width, height, { fit: "fill" });
  writeFileSync(file, await (format === "png" ? image.png() : image.jpeg()).bytes());
  process.env.CLUE_TEST_CLIPBOARD_IMAGE = file;
};

afterEach(() => {
  delete process.env.CLUE_TEST_CLIPBOARD_IMAGE;
});

test("a small clipboard image is sent as PNG at full size", async () => {
  await onClipboard(400, 300, "jpeg");
  const image = await clipboardImage();
  expect(image?.source.type === "base64" && image.source.media_type).toBe("image/png");
  const data = image?.source.type === "base64" ? image.source.data : "";
  expect(await new Bun.Image(Buffer.from(data, "base64")).metadata()).toMatchObject({ width: 400, height: 300 });
});

test("a large clipboard image is shrunk to webp", async () => {
  await onClipboard(2000, 500, "png");
  const image = await clipboardImage();
  expect(image?.source.type === "base64" && image.source.media_type).toBe("image/webp");
  const data = image?.source.type === "base64" ? image.source.data : "";
  expect(await new Bun.Image(Buffer.from(data, "base64")).metadata()).toMatchObject({ width: 1568, height: 392 });
});

test("an empty clipboard gives no image", async () => {
  process.env.CLUE_TEST_CLIPBOARD_IMAGE = join(tmpdir(), "clue-no-such-clipboard.png");
  expect(await clipboardImage()).toBeNull();
});

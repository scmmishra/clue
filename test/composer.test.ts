import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusReport, type ProgramStatus } from "../src/ui/status";
import { requests, startMockApi } from "./mock-api";

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ENTER = "\r";
const TAB = "\t";
const UP = "\x1b[A";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_V = "\x16";
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

let stop = async () => {};
afterEach(() => stop());

async function startClue(options: { delay?: number; env?: Record<string, string> } = {}) {
  requests.length = 0;
  const server = startMockApi(0, options.delay ?? 0);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clue-composer-")));
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 120, rows: 40, data: (_terminal, data) => (output += decoder.decode(data, { stream: true })) });
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts")], {
    cwd,
    env: { ...process.env, SHELL: "/bin/sh", CLUE_HOME: mkdtempSync(join(tmpdir(), "clue-composer-home-")), ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "", ...options.env },
    terminal,
  });
  stop = async () => {
    terminal.write(CTRL_D);
    await Promise.race([proc.exited, Bun.sleep(500)]);
    proc.kill();
    terminal.close();
    server.stop(true);
    stop = async () => {};
  };
  const waitFor = async (check: () => boolean, label: string) => {
    const deadline = Date.now() + 3000;
    while (!check() && Date.now() < deadline) await Bun.sleep(10);
    if (!check()) throw new Error(`timed out waiting for ${label}\n${Bun.stripANSI(output).slice(-600)}`);
  };
  const reports = (status: ProgramStatus) => output.split(statusReport(status)).length - 1;
  const clue = {
    cwd,
    screen: () => Bun.stripANSI(output),
    type: async (text: string) => {
      terminal.write(text);
      await Bun.sleep(40);
    },
    seen: (text: string) => waitFor(() => Bun.stripANSI(output).includes(text), `"${text}" on screen`),
    turns: (count: number) => waitFor(() => reports("done") >= count, `${count} finished turns`),
    working: () => waitFor(() => reports("working") >= 1, "a turn to start"),
    sent: (text: string) => waitFor(() => requests.some((request) => JSON.stringify(request.messages).includes(text)), `a request with "${text}"`),
    wasSent: (text: string) => requests.some((request) => JSON.stringify(request.messages).includes(text)),
  };
  await waitFor(() => reports("idle") >= 1, "the prompt");
  return clue;
}

// The user message that carries a prompt, as content blocks.
const promptBlocks = (text: string) => {
  for (const request of requests) {
    for (const message of request.messages as { role: string; content: any }[]) {
      if (message.role === "user" && Array.isArray(message.content) && message.content.some((block: any) => block.type === "text" && block.text.includes(text))) return message.content;
    }
  }
  return [];
};
const imagesIn = (blocks: any[]) => blocks.filter((block) => block.type === "image");

test("a pasted image path becomes a placeholder and is sent as an image", async () => {
  const clue = await startClue();
  const file = join(clue.cwd, "shot.png");
  writeFileSync(file, PNG);
  await clue.type(paste(file));
  await clue.seen("[Image #1]");
  await clue.type(" describe it");
  await clue.type(ENTER);
  await clue.turns(1);
  const blocks = promptBlocks("[Image #1] describe it");
  expect(imagesIn(blocks)).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } }]);
}, 15_000);

test("a path with escaped spaces, as a dragged file arrives, attaches", async () => {
  const clue = await startClue();
  writeFileSync(join(clue.cwd, "my shot.png"), PNG);
  await clue.type(paste(join(clue.cwd, "my\\ shot.png")));
  await clue.seen("[Image #1]");
}, 15_000);

test("a pasted path to a missing image stays as text", async () => {
  const clue = await startClue();
  await clue.type(paste("/tmp/clue-no-such-image.png"));
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent("/tmp/clue-no-such-image.png")).toBe(true);
  expect(clue.wasSent('"type":"image"')).toBe(false);
}, 15_000);

test("a pasted path to any other file stays as text", async () => {
  const clue = await startClue();
  const file = join(clue.cwd, "notes.txt");
  writeFileSync(file, "hello");
  await clue.type(paste(file));
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent(file)).toBe(true);
  expect(clue.wasSent('"type":"image"')).toBe(false);
}, 15_000);

test("a resumed-style prompt with no image keeps a plain string", async () => {
  const clue = await startClue();
  await clue.type("first");
  await clue.type(ENTER);
  await clue.turns(1);
  await clue.type("second");
  await clue.type(ENTER);
  await clue.turns(2);
  const last = requests.at(-1)!.messages.filter((message) => message.role === "user" && typeof message.content === "string");
  expect(last.map((message) => message.content)).toContain("second");
}, 15_000);

// A stand-in for osascript. It writes the PNG to the path in the script, like the real one.
function fakeOsascript(succeeds: boolean) {
  const bin = mkdtempSync(join(tmpdir(), "clue-fake-bin-"));
  const png = join(bin, "fixture.png");
  writeFileSync(png, PNG);
  const body = succeeds ? `path=$(printf '%s' "$2" | sed -n 's/.*POSIX file "\\(.*\\)".*/\\1/p' | head -n 1)\ncp "${png}" "$path"\n` : "exit 1\n";
  writeFileSync(join(bin, "osascript"), `#!/bin/sh\n${body}`);
  chmodSync(join(bin, "osascript"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}

const macOnly = test.if(process.platform === "darwin");

macOnly.each([
  ["ctrl+v", CTRL_V],
  ["an empty paste", paste("")],
  ["/paste", `/paste${ENTER}`],
])("%s attaches the image on the clipboard", async (_name, keys) => {
  const clue = await startClue({ env: fakeOsascript(true) });
  await clue.type(keys);
  await clue.seen("[Image #1]");
  await clue.type(" what is this");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(imagesIn(promptBlocks("what is this"))).toHaveLength(1);
}, 15_000);

macOnly("clue says so when the clipboard has no image", async () => {
  const clue = await startClue({ env: fakeOsascript(false) });
  await clue.type(CTRL_V);
  await clue.seen("No image on the clipboard.");
}, 15_000);

test("tab queues the typed message, and it sends when the turn ends", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("second message");
  await clue.type(TAB);
  await clue.seen("Queued: second message");
  expect(clue.wasSent("second message")).toBe(false);
  await clue.turns(2);
  expect(clue.wasSent("second message")).toBe(true);
}, 15_000);

test("enter also queues during a run", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("second message");
  await clue.type(ENTER);
  await clue.seen("Queued: second message");
  await clue.turns(2);
}, 15_000);

test("only one message can be queued", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("second");
  await clue.type(TAB);
  await clue.seen("Queued: second");
  await clue.type("third");
  await clue.type(TAB);
  await clue.seen("One message is already queued");
  await clue.turns(2);
  expect(clue.wasSent("second")).toBe(true);
  expect(clue.wasSent("third")).toBe(false);
  await clue.type(ENTER);
  await clue.turns(3);
  expect(clue.wasSent("third")).toBe(true);
}, 15_000);

test("up takes the queued message back to edit it, and it no longer sends by itself", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("second");
  await clue.type(TAB);
  await clue.seen("Queued: second");
  await clue.type(UP);
  await clue.type(" edited");
  await clue.seen("second edited");
  await clue.turns(1);
  await Bun.sleep(300);
  expect(clue.wasSent("second")).toBe(false);
  await clue.type(ENTER);
  await clue.turns(2);
  expect(clue.wasSent("second edited")).toBe(true);
}, 15_000);

test("up in front of a draft keeps both", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("second");
  await clue.type(TAB);
  await clue.seen("Queued: second");
  await clue.type("draft");
  await clue.type(UP);
  await clue.turns(1);
  await clue.type(ENTER);
  await clue.turns(2);
  expect(clue.wasSent("second\\ndraft")).toBe(true);
}, 15_000);

test("an interrupt returns the queued message to the editor instead of sending it", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("second");
  await clue.type(TAB);
  await clue.seen("Queued: second");
  await clue.type(CTRL_C);
  await Bun.sleep(400);
  expect(clue.wasSent("second")).toBe(false);
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent("second")).toBe(true);
}, 15_000);

test("a queued message keeps its image", async () => {
  const clue = await startClue({ delay: 30 });
  const file = join(clue.cwd, "shot.png");
  writeFileSync(file, PNG);
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type(paste(file));
  await clue.seen("[Image #1]");
  await clue.type(" later");
  await clue.type(TAB);
  await clue.seen("Queued: [Image #1] later");
  await clue.turns(2);
  expect(imagesIn(promptBlocks("[Image #1] later"))).toHaveLength(1);
}, 15_000);

test("nothing typed means tab queues nothing", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type(TAB);
  await clue.turns(1);
  await Bun.sleep(200);
  expect(clue.screen()).not.toContain("Queued:");
  expect(existsSync(clue.cwd)).toBe(true);
}, 15_000);

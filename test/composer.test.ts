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

async function startClue(options: { delay?: number; env?: Record<string, string>; args?: string[]; cwd?: string; home?: string } = {}) {
  requests.length = 0;
  const server = startMockApi(0, options.delay ?? 0);
  const cwd = options.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), "clue-composer-")));
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 120, rows: 40, data: (_terminal, data) => (output += decoder.decode(data, { stream: true })) });
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...(options.args ?? [])], {
    cwd,
    env: { ...process.env, SHELL: "/bin/sh", CLUE_HOME: options.home ?? mkdtempSync(join(tmpdir(), "clue-composer-home-")), ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "", ...options.env },
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
    const deadline = Date.now() + 8000;
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
}, 25_000);

test("a path with escaped spaces, as a dragged file arrives, attaches", async () => {
  const clue = await startClue();
  writeFileSync(join(clue.cwd, "my shot.png"), PNG);
  await clue.type(paste(join(clue.cwd, "my\\ shot.png")));
  await clue.seen("[Image #1]");
}, 25_000);

test("a pasted path to a missing image stays as text", async () => {
  const clue = await startClue();
  await clue.type(paste("/tmp/clue-no-such-image.png"));
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent("/tmp/clue-no-such-image.png")).toBe(true);
  expect(clue.wasSent('"type":"image"')).toBe(false);
}, 25_000);

test("a pasted path to any other file stays as text", async () => {
  const clue = await startClue();
  const file = join(clue.cwd, "notes.txt");
  writeFileSync(file, "hello");
  await clue.type(paste(file));
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent(file)).toBe(true);
  expect(clue.wasSent('"type":"image"')).toBe(false);
}, 25_000);

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
}, 25_000);

test("enter right after a paste sends the pasted text", async () => {
  const clue = await startClue();
  await clue.type(paste("/tmp/clue-no-such-image.png") + ENTER);
  await clue.turns(1);
  expect(clue.wasSent("/tmp/clue-no-such-image.png")).toBe(true);
}, 25_000);

test("enter right after pasting an image sends the image", async () => {
  const clue = await startClue();
  const file = join(clue.cwd, "shot.png");
  writeFileSync(file, PNG);
  await clue.type(paste(file) + ENTER);
  await clue.turns(1);
  expect(imagesIn(promptBlocks("[Image #1]"))).toHaveLength(1);
}, 25_000);

// A stand-in for osascript. It writes the PNG to the path in the script, like the real one.
function fakeOsascript(succeeds: boolean, delay = 0) {
  const bin = mkdtempSync(join(tmpdir(), "clue-fake-bin-"));
  const png = join(bin, "fixture.png");
  writeFileSync(png, PNG);
  const wait = delay ? `sleep ${delay}\n` : "";
  const body = wait + (succeeds ? `path=$(printf '%s' "$2" | sed -n 's/.*POSIX file "\\(.*\\)".*/\\1/p' | head -n 1)\ncp "${png}" "$path"\n` : "exit 1\n");
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
}, 25_000);

macOnly("keys typed while the clipboard is read stay in order, and enter waits for the image", async () => {
  const clue = await startClue({ env: fakeOsascript(true, 0.3) });
  await clue.type(`${CTRL_V}what is this${ENTER}`);
  await clue.turns(1);
  expect(imagesIn(promptBlocks("[Image #1]what is this"))).toHaveLength(1);
}, 25_000);

macOnly("clue says so when the clipboard has no image", async () => {
  const clue = await startClue({ env: fakeOsascript(false) });
  await clue.type(CTRL_V);
  await clue.seen("No image on the clipboard.");
}, 25_000);

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
}, 25_000);

test("a second message sent right after the first queues, and never starts a second turn", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type(`first${ENTER}second${ENTER}`);
  await clue.seen("Queued: second");
  await clue.turns(2);
  expect(clue.wasSent("second")).toBe(true);
}, 25_000);

test("enter also queues during a run", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("second message");
  await clue.type(ENTER);
  await clue.seen("Queued: second message");
  await clue.turns(2);
}, 25_000);

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
}, 25_000);

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
}, 25_000);

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
}, 25_000);

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
}, 25_000);

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
}, 25_000);

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
}, 25_000);

test("/rename names the session, and the exit hint uses the name", async () => {
  const clue = await startClue();
  await clue.type(`/rename auth-fix${ENTER}`);
  await clue.seen("Session is now auth-fix.");
  await clue.type("hello");
  await clue.type(ENTER);
  await clue.turns(1);
  await clue.type(CTRL_D);
  await clue.seen("Resume this session with: clue -r auth-fix");
}, 25_000);

test("/rename with no name shows the current one", async () => {
  const clue = await startClue();
  await clue.type(`/rename${ENTER}`);
  await clue.seen("This session has no name.");
  await clue.type(`/rename auth-fix${ENTER}`);
  await clue.seen("Session is now auth-fix.");
  await clue.type(`/rename${ENTER}`);
  await clue.seen("This session is auth-fix.");
}, 25_000);

test("/rename refuses a bad name and keeps the current one", async () => {
  const clue = await startClue();
  await clue.type(`/rename good-name${ENTER}`);
  await clue.seen("Session is now good-name.");
  await clue.type(`/rename not valid${ENTER}`);
  await clue.seen("A session name");
  await clue.type(`/rename${ENTER}`);
  await clue.seen("This session is good-name.");
}, 25_000);

test("/new clears the name", async () => {
  const clue = await startClue();
  await clue.type(`/rename first-name${ENTER}`);
  await clue.seen("Session is now first-name.");
  await clue.type(`/new${ENTER}`);
  await clue.seen("New session.");
  await clue.type(`/rename${ENTER}`);
  await clue.seen("This session has no name.");
}, 25_000);

const scratch = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), name)));
const clueFirstRun = (cwd: string, home: string, prompt: string) => startClue({ cwd, home, args: ["--name", "thread-1", prompt] });

test("a prompt on the command line runs as the first turn", async () => {
  const clue = await startClue({ args: ["summarise this"] });
  await clue.turns(1);
  expect(clue.wasSent("summarise this")).toBe(true);
}, 25_000);

test("-c with a prompt runs it in the resumed session", async () => {
  const [cwd, home] = [scratch("clue-c-"), scratch("clue-c-home-")];
  const first = await startClue({ cwd, home, args: ["first prompt"] });
  await first.turns(1);
  await stop();
  const second = await startClue({ cwd, home, args: ["-c", "second prompt"] });
  await second.turns(1);
  expect(second.wasSent("first prompt")).toBe(true);
  expect(second.wasSent("second prompt")).toBe(true);
}, 25_000);

test("--name creates the session and runs the prompt, then resumes it without running the prompt again", async () => {
  const [cwd, home] = [scratch("clue-open-"), scratch("clue-open-home-")];
  const first = await clueFirstRun(cwd, home, "read the thread");
  await first.turns(1);
  expect(first.wasSent("read the thread")).toBe(true);
  await stop();

  const second = await clueFirstRun(cwd, home, "read the thread");
  await second.seen("session thread-1 · 1 prompt");
  await second.seen("Resumed thread-1. Your prompt was not sent.");
  await Bun.sleep(300);
  expect(requests.filter((request) => request.max_tokens !== 0)).toEqual([]);
}, 25_000);

test("--name without a prompt resumes quietly", async () => {
  const [cwd, home] = [scratch("clue-quiet-"), scratch("clue-quiet-home-")];
  const first = await clueFirstRun(cwd, home, "read the thread");
  await first.turns(1);
  await stop();
  const second = await startClue({ cwd, home, args: ["--name", "THREAD-1"] });
  await second.seen("session thread-1 · 1 prompt");
  expect(second.screen()).not.toContain("was not sent");
}, 25_000);

test("the same name in another folder creates a separate session", async () => {
  const home = scratch("clue-other-home-");
  const first = await clueFirstRun(scratch("clue-other-a-"), home, "first folder");
  await first.turns(1);
  await stop();
  const second = await clueFirstRun(scratch("clue-other-b-"), home, "second folder");
  await second.turns(1);
  expect(second.wasSent("second folder")).toBe(true);
  expect(second.wasSent("first folder")).toBe(false);
  expect(second.screen()).not.toContain("Resumed thread-1");
}, 25_000);

test("/rename still refuses a name taken in this folder", async () => {
  const [cwd, home] = [scratch("clue-taken-"), scratch("clue-taken-home-")];
  const first = await clueFirstRun(cwd, home, "read the thread");
  await first.turns(1);
  await stop();
  const second = await startClue({ cwd, home, args: ["another prompt"] });
  await second.turns(1);
  await second.type(`/rename thread-1${ENTER}`);
  await second.seen("A session named thread-1 already exists here.");
}, 25_000);

import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "../src/session";
import { statusReport, type ProgramStatus } from "../src/ui/status";
import { compactions, compactionStop, fastMode, requests, startMockApi, usage } from "./mock-api";

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const ENTER = "\r";
const TAB = "\t";
const UP = "\x1b[A";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_V = "\x16";
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

let stop = async () => {};
afterEach(() => stop());

async function startClue(
  options: { delay?: number; env?: Record<string, string>; args?: string[]; cwd?: string; home?: string } = {},
) {
  requests.length = 0;
  const server = startMockApi(0, options.delay ?? 0);
  const cwd = options.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), "clue-composer-")));
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({
    cols: 120,
    rows: 40,
    data: (_terminal, data) => (output += decoder.decode(data, { stream: true })),
  });
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...(options.args ?? [])], {
    cwd,
    env: {
      ...process.env,
      SHELL: "/bin/sh",
      CLUE_HOME: options.home ?? mkdtempSync(join(tmpdir(), "clue-composer-home-")),
      ANTHROPIC_BASE_URL: server.url.origin,
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENROUTER_API_KEY: "",
      ...options.env,
    },
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
    raw: () => output,
    exited: () => Promise.race([proc.exited, Bun.sleep(3000)]),
    hangUp: () => proc.kill("SIGHUP"),
    type: async (text: string) => {
      terminal.write(text);
      await Bun.sleep(40);
    },
    seen: (text: string) => waitFor(() => Bun.stripANSI(output).includes(text), `"${text}" on screen`),
    turns: (count: number) => waitFor(() => reports("done") >= count, `${count} finished turns`),
    working: () => waitFor(() => reports("working") >= 1, "a turn to start"),
    sent: (text: string) =>
      waitFor(
        () => requests.some((request) => JSON.stringify(request.messages).includes(text)),
        `a request with "${text}"`,
      ),
    wasSent: (text: string) => requests.some((request) => JSON.stringify(request.messages).includes(text)),
  };
  await waitFor(() => reports("idle") >= 1, "the prompt");
  return clue;
}

// The user message that carries a prompt, as content blocks.
const promptBlocks = (text: string) => {
  for (const request of requests) {
    for (const message of request.messages as { role: string; content: any }[]) {
      if (
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((block: any) => block.type === "text" && block.text.includes(text))
      )
        return message.content;
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
  expect(imagesIn(blocks)).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
  ]);
}, 25_000);

test("a path with escaped spaces, as a dragged file arrives, attaches", async () => {
  const clue = await startClue();
  writeFileSync(join(clue.cwd, "my shot.png"), PNG);
  await clue.type(paste(join(clue.cwd, "my\\ shot.png")));
  await clue.seen("[Image #1]");
}, 25_000);

test("a macOS screenshot, with its narrow space before PM, attaches", async () => {
  const clue = await startClue();
  const name = "Screenshot 2026-05-01 at 10.23.45\u202fPM.png";
  writeFileSync(join(clue.cwd, name), PNG);
  await clue.type(paste(join(clue.cwd, name).replaceAll(" ", "\\ ")));
  await clue.seen("[Image #1]");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent("PM.png")).toBe(false);
}, 25_000);

test("a paste split over two reads still becomes one placeholder, without the path", async () => {
  const clue = await startClue();
  const file = join(clue.cwd, "shot.png");
  writeFileSync(file, PNG);
  await clue.type("\x1b[200~");
  await clue.type(`${file}\x1b[201~`);
  await clue.seen("[Image #1]");
  await clue.type(` x${ENTER}`);
  await clue.turns(1);
  expect(imagesIn(promptBlocks("[Image #1] x"))).toHaveLength(1);
  expect(clue.wasSent(file)).toBe(false);
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
  const last = requests
    .at(-1)!
    .messages.filter((message) => message.role === "user" && typeof message.content === "string");
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

// The clipboard image comes from a fixture file, or a missing one when there's none.
// A fake pbpaste prints `text`, so the test machine's clipboard stays out of it.
function fakeClipboard(image: boolean, text = "") {
  const bin = mkdtempSync(join(tmpdir(), "clue-fake-bin-"));
  const png = join(bin, "fixture.png");
  if (image) writeFileSync(png, PNG);
  writeFileSync(join(bin, "pbpaste"), `#!/bin/sh\nprintf '%s' '${text}'\n`);
  chmodSync(join(bin, "pbpaste"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, CLUE_TEST_CLIPBOARD_IMAGE: png };
}

// Over SSH, or off macOS, /copy asks the terminal to set the clipboard with OSC 52.
test("/copy over SSH sends the reply to the terminal's clipboard, and explains it once", async () => {
  const clue = await startClue({ env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" } });
  await clue.type("what is this package?");
  await clue.type(ENTER);
  await clue.turns(1);
  await clue.type(`/copy${ENTER}`);
  await clue.seen("Copied the last reply");
  const copied = clue.raw().match(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x1b\\/);
  expect(copied).not.toBeNull();
  expect(Buffer.from(copied![1], "base64").toString()).toContain("The package is called **clue**");
  expect(clue.screen().split("allow clipboard access").length - 1).toBe(1);
  await clue.type(`/copy${ENTER}`);
  const count = (text: string) => clue.raw().split(text).length - 1;
  for (let wait = 0; count("Copied the last reply") < 2 && wait < 800; wait++) await Bun.sleep(10);
  expect(count("\x1b]52;c;")).toBe(2);
  expect(clue.screen().split("allow clipboard access").length - 1).toBe(1);
}, 25_000);

test("a read's path links to the file, live and after a resume", async () => {
  const home = mkdtempSync(join(tmpdir(), "clue-composer-home-"));
  const link = (cwd: string) => `\x1b]8;;file://${hostname()}${encodeURI(join(cwd, "package.json"))}\x1b\\`;
  const clue = await startClue({ home });
  await clue.type("what is this package?");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.raw()).toContain(link(clue.cwd));
  await stop();
  const resumed = await startClue({ home, cwd: clue.cwd, args: ["-c"] });
  await resumed.seen("package.json");
  expect(resumed.raw()).toContain(link(clue.cwd));
}, 25_000);

const macOnly = test.if(process.platform === "darwin");

macOnly.each([
  ["ctrl+v", CTRL_V],
  ["an empty paste", paste("")],
  ["/paste", `/paste${ENTER}`],
])(
  "%s attaches the image on the clipboard",
  async (_name, keys) => {
    const clue = await startClue({ env: fakeClipboard(true) });
    await clue.type(keys);
    await clue.seen("[Image #1]");
    await clue.type(" what is this");
    await clue.type(ENTER);
    await clue.turns(1);
    expect(imagesIn(promptBlocks("what is this"))).toHaveLength(1);
  },
  25_000,
);

macOnly(
  "keys typed while the clipboard is read stay in order, and enter waits for the image",
  async () => {
    const clue = await startClue({ env: fakeClipboard(true) });
    await clue.type(`${CTRL_V}what is this${ENTER}`);
    await clue.turns(1);
    expect(imagesIn(promptBlocks("[Image #1]what is this"))).toHaveLength(1);
  },
  25_000,
);

macOnly.each([
  ["ctrl+v", CTRL_V],
  ["/paste", `/paste${ENTER}`],
])(
  "%s pastes the clipboard's text when it holds no image",
  async (_name, keys) => {
    const clue = await startClue({ env: fakeClipboard(false, "copied words") });
    await clue.type(keys);
    await clue.type(ENTER);
    await clue.turns(1);
    expect(JSON.stringify(promptBlocks("copied words"))).toContain("copied words");
  },
  25_000,
);

macOnly(
  "a paste of only spaces keeps them when the clipboard has no image",
  async () => {
    const clue = await startClue({ env: fakeClipboard(false, "should not appear") });
    await clue.type(`a${paste("   ")}b${ENTER}`);
    await clue.turns(1);
    const blocks = JSON.stringify(promptBlocks("a   b"));
    expect(blocks).toContain("a   b");
    expect(blocks).not.toContain("should not appear");
  },
  25_000,
);

macOnly(
  "clue says so when the clipboard is empty",
  async () => {
    const clue = await startClue({ env: fakeClipboard(false) });
    await clue.type(CTRL_V);
    await clue.seen("The clipboard is empty.");
  },
  25_000,
);

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

// The user message that carries the tool results a steering message rode along with.
const steeredBlocks = (text: string): any[] =>
  requests
    .flatMap((request) => request.messages as { role: string; content: any }[])
    .find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((block: any) => block.type === "tool_result") &&
        message.content.some((block: any) => block.type === "text" && block.text.includes(text)),
    )?.content ?? [];

test("enter during a run steers: the message reaches Claude after the next tool results", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("change course");
  await clue.type(ENTER);
  await clue.seen("Steering: change course");
  await clue.turns(1);
  const blocks = steeredBlocks("change course");
  expect(blocks.map((block) => block.type)).toEqual(["tool_result", "text"]);
  await Bun.sleep(300);
  expect(requests.some((request) => JSON.stringify(request.messages).includes('"content":"change course"'))).toBe(
    false,
  );
}, 25_000);

test("a second message sent right after the first steers it, and never starts a second turn", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type(`first${ENTER}second${ENTER}`);
  await clue.turns(1);
  expect(steeredBlocks("second")).toHaveLength(2);
  await Bun.sleep(300);
  // One request for the prompt, one for the tool results that carried the steer.
  expect(requests).toHaveLength(2);
}, 25_000);

test("more text while a steer waits adds to it", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type(`one${ENTER}`);
  await clue.type(`two${ENTER}`);
  await clue.seen("Steering: one two");
  await clue.turns(1);
  expect(steeredBlocks("one\n\ntwo")).toHaveLength(2);
}, 25_000);

test("a steer that finds no more tool calls starts the next turn", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  const deadline = Date.now() + 8000;
  while (requests.length < 2 && Date.now() < deadline) await Bun.sleep(10);
  await clue.type(`late steer${ENTER}`);
  await clue.turns(2);
  expect(steeredBlocks("late steer")).toEqual([]);
  expect(clue.wasSent("late steer")).toBe(true);
}, 25_000);

test("a command typed during a run queues, because it can't steer", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type(`/usage${ENTER}`);
  await clue.seen("Queued: /usage");
}, 25_000);

test("up takes back the steering message first, then the queued one", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type(`later${TAB}`);
  await clue.type(`steer${ENTER}`);
  await clue.seen("Steering: steer");
  await clue.type(UP);
  await clue.turns(2);
  expect(clue.wasSent("later")).toBe(true);
  expect(clue.wasSent("steer")).toBe(false);
}, 25_000);

test("an interrupt returns the steering message to the editor instead of sending it", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type(`wait${ENTER}`);
  await clue.seen("Steering: wait");
  await clue.type(CTRL_C);
  await Bun.sleep(400);
  expect(clue.wasSent("wait")).toBe(false);
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent("wait")).toBe(true);
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
const clueFirstRun = (cwd: string, home: string, prompt: string) =>
  startClue({ cwd, home, args: ["--name", "thread-1", prompt] });

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

test("broken settings warn in the session", async () => {
  const home = scratch("clue-broken-home-");
  writeFileSync(join(home, "settings.json"), "{ nope");
  const clue = await startClue({ home });
  await clue.seen("isn't valid JSON");
  await clue.seen("clue config edit");
}, 25_000);

test("good settings start without a warning", async () => {
  const home = scratch("clue-good-home-");
  writeFileSync(join(home, "settings.json"), '{ "effort": "low" }');
  const clue = await startClue({ home });
  await Bun.sleep(200);
  expect(clue.screen()).not.toContain("clue config edit");
}, 25_000);

function seedSession(home: string, cwd: string, prompts: number) {
  const dir = join(home, "sessions", projectKey(cwd));
  mkdirSync(dir, { recursive: true });
  const records: object[] = [{ t: "session", id: "seeded", cwd, created: 1, version: "0" }];
  for (let index = 0; index < prompts; index++) {
    records.push({ t: "message", message: { role: "user", content: `seeded prompt ${index}` } });
    records.push({ t: "message", message: { role: "assistant", content: [{ type: "text", text: "A reply." }] } });
  }
  writeFileSync(join(dir, "seeded.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

test("resume restores a session taller than the screen into the scrollback", async () => {
  const [cwd, home] = [scratch("clue-tall-"), scratch("clue-tall-home-")];
  seedSession(home, cwd, 60);
  const clue = await startClue({ cwd, home, args: ["-c"] });
  await clue.seen("seeded prompt 59");
  expect(clue.screen()).toContain("seeded prompt 0");
  expect(clue.screen()).not.toContain("earlier turns hidden");
}, 25_000);

test("shift+enter adds a new line, and enter sends both lines", async () => {
  const clue = await startClue();
  await clue.type("line one");
  await clue.type("\x1b[13;2u");
  await clue.type("line two");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent("line one\\nline two")).toBe(true);
}, 25_000);

test("ctrl+c in its new form still interrupts a turn", async () => {
  const clue = await startClue({ delay: 40 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("\x1b[99;5u");
  await clue.seen("Interrupting");
}, 25_000);

test("clue asks for key reports at startup, and hands the terminal back on exit", async () => {
  const clue = await startClue();
  expect(clue.raw()).toContain("\x1b[>1u");
  expect(clue.raw()).toContain("\x1b[>4;2m");
  await clue.type("\x1b[100;5u");
  await clue.exited();
  expect(clue.raw()).toContain("\x1b[<u");
  expect(clue.raw()).toContain("\x1b[>4;0m");
}, 25_000);

test("a terminal already inside tmux gets no kitty request", async () => {
  const clue = await startClue({ env: { TMUX: "/tmp/tmux-501/default,1,0" } });
  expect(clue.raw()).not.toContain("\x1b[>1u");
  expect(clue.raw()).toContain("\x1b[>4;2m");
}, 25_000);

test("@ picks a file in the real app, and the prompt carries its path", async () => {
  const cwd = scratch("clue-mention-");
  writeFileSync(join(cwd, "notes.md"), "hello");
  writeFileSync(join(cwd, "other.ts"), "");
  const clue = await startClue({ cwd });
  await clue.type("read @not");
  await clue.seen("notes.md");
  await clue.type(ENTER);
  await clue.type("please");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent("read @notes.md please")).toBe(true);
}, 25_000);

test("the picker works while a turn runs, and takes up, tab and enter from the queue", async () => {
  const cwd = scratch("clue-mention-run-");
  writeFileSync(join(cwd, "notes.md"), "hello");
  const clue = await startClue({ cwd, delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("@not");
  await clue.seen("notes.md");
  await clue.type(TAB);
  await clue.type("now");
  await clue.type(TAB);
  await clue.seen("Queued: @notes.md now");
  await clue.turns(2);
  expect(clue.wasSent("@notes.md now")).toBe(true);
}, 25_000);

test("escape in the picker during a turn doesn't count toward an interrupt", async () => {
  const cwd = scratch("clue-mention-esc-");
  writeFileSync(join(cwd, "notes.md"), "hello");
  const clue = await startClue({ cwd, delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("@not");
  await clue.seen("notes.md");
  await clue.type("\x1b");
  await clue.type("\x1b");
  await clue.turns(1);
  expect(clue.screen()).not.toContain("Interrupting");
}, 25_000);

test("arrow keys move the picker selection in the real app", async () => {
  const cwd = scratch("clue-mention-arrows-");
  for (const name of ["a.md", "b.md", "c.md", "d.md"]) writeFileSync(join(cwd, name), "");
  const clue = await startClue({ cwd });
  await clue.type("@");
  await clue.seen("d.md");
  await clue.type("\x1b[B");
  await clue.type("\x1b[B");
  await clue.type("\x1b[A");
  await clue.type("\x1b[B");
  await clue.type(ENTER);
  await clue.type("go");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent("@c.md go")).toBe(true);
}, 25_000);

test("arrow keys that report num lock move the picker selection", async () => {
  const cwd = scratch("clue-mention-numlock-");
  for (const name of ["a.md", "b.md"]) writeFileSync(join(cwd, name), "");
  const clue = await startClue({ cwd });
  await clue.type("@");
  await clue.seen("› a.md");
  await clue.type("\x1b[1;129B");
  await clue.seen("› b.md");
}, 25_000);

test("the selected row is marked on the screen, without relying on colour", async () => {
  const cwd = scratch("clue-mention-mark-");
  for (const name of ["a.md", "b.md"]) writeFileSync(join(cwd, name), "");
  const clue = await startClue({ cwd, env: { NO_COLOR: "1" } });
  await clue.type("@");
  await clue.seen("› a.md");
  await clue.type("\x1b[B");
  await clue.seen("› b.md");
}, 25_000);

const SHIFT_TAB = "\x1b[Z";

test("shift+tab cycles the permission mode and leaves the input alone", async () => {
  const clue = await startClue({ args: ["--permission-mode", "ask"] });
  await clue.type("draft");
  await clue.type(SHIFT_TAB);
  await clue.seen("auto ·");
  await clue.type(SHIFT_TAB);
  await clue.seen("full-access ·");
  await clue.type(SHIFT_TAB);
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent("draft")).toBe(true);
}, 25_000);

test("shift+tab works during a turn, and doesn't queue the draft", async () => {
  const clue = await startClue({ args: ["--permission-mode", "ask"], delay: 30 });
  await clue.type("first");
  await clue.type(ENTER);
  await clue.working();
  await clue.type("next");
  await clue.type(SHIFT_TAB);
  await clue.seen("auto ·");
  expect(clue.screen()).not.toContain("Queued:");
}, 25_000);

test("shift+tab doesn't accept a pick in the file picker", async () => {
  const cwd = scratch("clue-mention-shift-");
  writeFileSync(join(cwd, "notes.md"), "");
  const clue = await startClue({ cwd, args: ["--permission-mode", "ask"] });
  await clue.type("@not");
  await clue.seen("› notes.md");
  await clue.type(SHIFT_TAB);
  await clue.type(ENTER);
  await clue.type("go");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.wasSent("@notes.md go")).toBe(true);
}, 25_000);

test.each(["/usage", "/cost"])(
  "%s reports context and cost after a reply",
  async (command) => {
    const clue = await startClue();
    await clue.type("hello");
    await clue.type(ENTER);
    await clue.turns(1);
    await clue.type(command);
    await clue.type(ENTER);
    await clue.seen("before compaction");
    await clue.seen("across 1 prompt");
  },
  25_000,
);

test("/undo removes what the turn wrote and leaves the conversation alone", async () => {
  const cwd = scratch("clue-undo-");
  const clue = await startClue({ cwd, args: ["--permission-mode", "full-access"] });
  const note = join(cwd, "note.txt");
  await clue.type("create the note");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(existsSync(note)).toBe(true);
  await clue.type("/undo");
  await clue.type(ENTER);
  await clue.seen("Deleted note.txt");
  expect(existsSync(note)).toBe(false);
  await clue.type("next");
  await clue.type(ENTER);
  await clue.turns(2);
  const history = JSON.stringify((requests.at(-1) as { messages: unknown }).messages);
  expect(history).toContain("create the note");
  expect(history).not.toContain("/undo");
  expect(history).not.toContain("Deleted note.txt");
}, 25_000);

test("/compact sends the summary first, then the context again with the next prompt", async () => {
  const clue = await startClue();
  await clue.type("hello there");
  await clue.type(ENTER);
  await clue.turns(1);
  await clue.type("/compact");
  await clue.type(ENTER);
  await clue.seen("token summary");
  await clue.type("next");
  await clue.type(ENTER);
  await clue.turns(2);
  const last = requests.at(-1) as { messages: { role: string; content: any }[]; context_management?: unknown };
  expect(last.messages[0].content[0].type).toBe("compaction");
  expect(last.context_management).toBeUndefined();
  expect(JSON.stringify(last.messages)).not.toContain("hello there");
  expect(JSON.stringify(last.messages[1])).toContain("<context>");
}, 25_000);

test("a summary that doesn't finish leaves the conversation as it was", async () => {
  const clue = await startClue();
  await clue.type("hello there");
  await clue.type(ENTER);
  await clue.turns(1);
  compactionStop.value = "max_tokens";
  await clue.type("/compact");
  await clue.type(ENTER);
  await clue.seen("Nothing changed.");
  compactionStop.value = "compaction";
  await clue.type("next");
  await clue.type(ENTER);
  await clue.turns(2);
  expect(JSON.stringify((requests.at(-1) as { messages: unknown }).messages)).toContain("hello there");
}, 25_000);

test("/compact on an empty session does nothing", async () => {
  const clue = await startClue();
  const before = compactions.length;
  await clue.type("/compact");
  await clue.type(ENTER);
  await clue.seen("Nothing to compact.");
  expect(compactions.length).toBe(before);
}, 25_000);

test("a resumed session still shows what came before a compaction", async () => {
  const [cwd, home] = [scratch("clue-compact-"), scratch("clue-compact-home-")];
  const first = await startClue({ cwd, home });
  await first.type("the early prompt");
  await first.type(ENTER);
  await first.turns(1);
  await first.type("/compact");
  await first.type(ENTER);
  await first.seen("token summary");
  await stop();
  const second = await startClue({ cwd, home, args: ["-c"] });
  await second.seen("the early prompt");
}, 25_000);

const compactedSession = async () => {
  const clue = await startClue();
  await clue.type("hello there");
  await clue.type(ENTER);
  await clue.turns(1);
  await clue.type("/compact");
  await clue.type(ENTER);
  await clue.seen("token summary");
  return clue;
};

test("after /compact, clue compacts a full conversation itself before the next prompt", async () => {
  const clue = await compactedSession();
  usage.cache_read_input_tokens = 200_000;
  await clue.type("zebra-two");
  await clue.type(ENTER);
  await clue.turns(2);
  usage.cache_read_input_tokens = 2000;
  const before = compactions.length;
  await clue.type("third");
  await clue.type(ENTER);
  await clue.turns(3);
  expect(compactions.length).toBe(before + 1);
  await clue.seen("Compacted the conversation.");
  const last = JSON.stringify((requests.at(-1) as { messages: unknown }).messages);
  expect(last).not.toContain("zebra-two");
  expect(last).toContain("third");
}, 25_000);

test("a compaction during a turn lets the turn continue", async () => {
  const clue = await compactedSession();
  usage.cache_read_input_tokens = 200_000;
  const before = compactions.length;
  await clue.type("read the package");
  await clue.type(ENTER);
  await clue.turns(2);
  usage.cache_read_input_tokens = 2000;
  expect(compactions.length).toBe(before + 1);
  const last = (requests.at(-1) as { messages: { role: string; content: any }[] }).messages;
  expect(last[0].content[0].type).toBe("compaction");
  expect(last.at(-1)).toEqual({ role: "user", content: "Continue with the task." });
}, 25_000);

const ESC = "\x1b";
const pressTwice = async (clue: Awaited<ReturnType<typeof startClue>>) => {
  await clue.type(ESC);
  await clue.type(ESC);
};

test("esc esc rewinds: the file goes, the prompt returns, and the next request has no trace of the turn", async () => {
  const cwd = scratch("clue-rewind-");
  const clue = await startClue({ cwd, args: ["--permission-mode", "full-access"] });
  const note = join(cwd, "note.txt");
  await clue.type("hello there");
  await clue.type(ENTER);
  await clue.turns(1);
  await clue.type("create the note");
  await clue.type(ENTER);
  await clue.turns(2);
  expect(existsSync(note)).toBe(true);
  await pressTwice(clue);
  await clue.seen("Rewind to before:");
  await clue.type(ENTER);
  await clue.seen("rewound 1 turn · restored 1 file");
  expect(existsSync(note)).toBe(false);
  await clue.seen("create the note");
  await clue.type("\x15");
  await clue.type("something else");
  await clue.type(ENTER);
  await clue.turns(3);
  const last = JSON.stringify((requests.at(-1) as { messages: unknown }).messages);
  expect(last).toContain("something else");
  expect(last).toContain("hello there");
  expect(last).not.toContain("note.txt");
}, 25_000);

test("tab in rewind keeps the files", async () => {
  const cwd = scratch("clue-rewind-keep-");
  const clue = await startClue({ cwd, args: ["--permission-mode", "full-access"] });
  await clue.type("create the note");
  await clue.type(ENTER);
  await clue.turns(1);
  await pressTwice(clue);
  await clue.seen("Rewind to before:");
  await clue.type(TAB);
  await clue.seen("rewound 1 turn ·");
  expect(existsSync(join(cwd, "note.txt"))).toBe(true);
}, 25_000);

test("esc closes rewind, and an empty session has nothing to rewind", async () => {
  const clue = await startClue();
  await pressTwice(clue);
  await clue.seen("Nothing to rewind.");
  await clue.type("hello");
  await clue.type(ENTER);
  await clue.turns(1);
  await pressTwice(clue);
  await clue.seen("Rewind to before:");
  await clue.type(ESC);
  await clue.type("next");
  await clue.type(ENTER);
  await clue.turns(2);
  expect(clue.wasSent("next")).toBe(true);
}, 25_000);

test("esc esc during a run interrupts instead of rewinding", async () => {
  const clue = await startClue({ delay: 30 });
  await clue.type("hello");
  await clue.type(ENTER);
  await clue.working();
  await pressTwice(clue);
  await clue.seen("Interrupting");
  expect(clue.screen()).not.toContain("Rewind to before:");
}, 25_000);

test("/model with no argument opens a list, and enter selects", async () => {
  const clue = await startClue();
  await clue.type("/model");
  await clue.type(ENTER);
  await clue.seen("enter select · esc cancel");
  await clue.type(UP);
  await clue.type(ENTER);
  await clue.seen("Model is now");
  await clue.type("hello");
  await clue.type(ENTER);
  await clue.turns(1);
  expect((requests.at(-1) as { model: string }).model).toBe("claude-fable-5");
}, 25_000);

test("esc leaves the model as it was, and the input works again", async () => {
  const clue = await startClue();
  await clue.type("/model");
  await clue.type(ENTER);
  await clue.seen("enter select · esc cancel");
  await clue.type("\x1b");
  await clue.type("hello");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(clue.screen()).not.toContain("Model is now");
  expect((requests.at(-1) as { model: string }).model).toBe("claude-opus-5-5");
}, 25_000);

test("/model <name> still switches straight away", async () => {
  const clue = await startClue();
  await clue.type("/model sonnet");
  await clue.type(ENTER);
  await clue.seen("Model is now");
  expect(clue.screen()).not.toContain("enter select");
}, 25_000);

test("/effort and /permissions open a list too", async () => {
  const clue = await startClue({ args: ["--permission-mode", "ask"] });
  await clue.type("/effort");
  await clue.type(ENTER);
  await clue.seen("Effort:");
  await clue.type(UP);
  await clue.type(ENTER);
  await clue.seen("Effort is now low.");
  await clue.type("/permissions");
  await clue.type(ENTER);
  await clue.seen("Permission mode:");
  await clue.type("\x1b[B");
  await clue.type(ENTER);
  await clue.seen("Permission mode is now auto.");
}, 25_000);

test("/fast sends fast requests, and the status line and the footer show it", async () => {
  const clue = await startClue();
  await clue.type("/fast");
  await clue.type(ENTER);
  await clue.seen("Fast mode is on.");
  await clue.seen("medium · fast");
  await clue.type("read it");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(requests.every((request) => request.speed === "fast")).toBe(true);
  expect(requests[0].betas).toContain("fast-mode-2026-02-01");
  await clue.seen("out · fast");
  await clue.type("/fast");
  await clue.type(ENTER);
  await clue.seen("Fast mode is off.");
}, 25_000);

test("the status line keeps the same total as /usage", async () => {
  const clue = await startClue();
  await clue.type("read it");
  await clue.type(ENTER);
  await clue.turns(1);
  await clue.seen("medium · $0.0");
  await clue.type("/usage");
  await clue.type(ENTER);
  const total = clue.screen().match(/medium · (\$\d+\.\d\d)/)![1];
  await clue.seen(`${total} across 1 prompt`);
}, 25_000);

test("switching to a model without fast mode turns it off for good", async () => {
  const clue = await startClue({ args: ["--fast"] });
  await clue.seen("medium · fast");
  await clue.type("/model sonnet");
  await clue.type(ENTER);
  await clue.seen("Fast mode is off.");
  await clue.type("/model opus");
  await clue.type(ENTER);
  await clue.seen("Model is now opus");
  await clue.type("read it");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(requests.some((request) => request.speed === "fast")).toBe(false);
}, 25_000);

test("/fast refuses on a model without fast mode, and --fast does too", async () => {
  const clue = await startClue({ args: ["--model", "sonnet"] });
  await clue.type("/fast");
  await clue.type(ENTER);
  await clue.seen("Fast mode only works with opus 5.5 and opus 5.");
  const flag = Bun.spawnSync(
    ["bun", join(import.meta.dir, "../src/main.ts"), "ask", "--fast", "--model", "sonnet", "hi"],
    {
      env: { ...process.env, CLUE_HOME: mkdtempSync(join(tmpdir(), "clue-fast-home-")) },
      stderr: "pipe",
    },
  );
  expect(flag.exitCode).toBe(2);
  expect(flag.stderr.toString()).toContain("--fast only works with opus 5.5 and opus 5.");
}, 25_000);

test("when the API rejects fast mode, clue turns it off, says so and finishes the turn", async () => {
  fastMode.rejectedFor = "";
  try {
    const clue = await startClue({ args: ["--fast"] });
    await clue.type("read it");
    await clue.type(ENTER);
    await clue.turns(1);
    await clue.seen("Fast mode isn't available now");
    expect(requests[0].speed).toBe("fast");
    expect(requests.at(-1)!.speed).toBeUndefined();
    await clue.type("/fast off");
    await clue.type(ENTER);
    await clue.seen("Fast mode is off.");
    expect(clue.screen().split("Fast mode isn't available now").at(-1)).not.toContain("out · fast");
  } finally {
    fastMode.rejectedFor = null;
  }
}, 25_000);

test("a saved fast setting on a model without it stays off after /model", async () => {
  const home = mkdtempSync(join(tmpdir(), "clue-composer-home-"));
  writeFileSync(join(home, "settings.json"), '{ "fast": true }');
  const clue = await startClue({ home, args: ["--model", "sonnet"] });
  await clue.type("/model opus");
  await clue.type(ENTER);
  await clue.seen("Model is now opus");
  await clue.type("read it");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(requests.some((request) => request.speed === "fast")).toBe(false);
  expect(clue.screen()).not.toContain("· fast");
}, 25_000);

test("a saved fast setting applies on a model that has it", async () => {
  const home = mkdtempSync(join(tmpdir(), "clue-composer-home-"));
  writeFileSync(join(home, "settings.json"), '{ "fast": true }');
  const clue = await startClue({ home });
  await clue.seen("medium · fast");
}, 25_000);

test("when a subagent loses fast mode, the session does too, and clue says so", async () => {
  fastMode.rejectedFor = "the child task";
  try {
    const clue = await startClue({ args: ["--fast"] });
    await clue.type("delegate this");
    await clue.type(ENTER);
    await clue.turns(1);
    await clue.seen("Fast mode isn't available now");
    expect(requests[0].speed).toBe("fast");
    expect(requests.at(-1)!.speed).toBeUndefined();
    await clue.type("/fast");
    await clue.type(ENTER);
    await clue.seen("Fast mode is on.");
  } finally {
    fastMode.rejectedFor = null;
  }
}, 25_000);

test("closing the terminal stops running commands", async () => {
  const clue = await startClue();
  const runs = () => Bun.spawnSync(["pgrep", "-f", "^sleep 26\\.5$"]).exitCode === 0;
  await clue.type("please push slowly");
  await clue.type(ENTER);
  for (let tries = 0; tries < 500 && !runs(); tries++) await Bun.sleep(10);
  expect(runs()).toBe(true);
  clue.hangUp();
  await clue.exited();
  // A signalled process takes a moment to go. A survivor would stay.
  for (let tries = 0; tries < 100 && runs(); tries++) await Bun.sleep(10);
  const stopped = !runs();
  Bun.spawnSync(["pkill", "-9", "-f", "^sleep 26\\.5$"]);
  expect(stopped).toBe(true);
}, 25_000);

test("a resumed session warms the cache on the first key, and the cost counts", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clue-composer-")));
  const home = mkdtempSync(join(tmpdir(), "clue-composer-home-"));
  const first = await startClue({ cwd, home });
  await first.type("read it");
  await first.type(ENTER);
  await first.turns(1);
  await stop();

  const second = await startClue({ cwd, home, args: ["-c"] });
  const warmups = () => requests.filter((request) => request.max_tokens === 0).length;
  await Bun.sleep(200);
  expect(warmups()).toBe(0);
  await second.type("x");
  await second.seen("history cached");
  expect(warmups()).toBe(1);
}, 25_000);

test("/new keeps MCP servers running in the same folder", async () => {
  const home = mkdtempSync(join(tmpdir(), "clue-composer-home-"));
  const log = join(home, "server-starts");
  const server = { command: "sh", args: ["-c", `echo start >> ${log}; exec sleep 5`] };
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { counter: server } }));
  const clue = await startClue({ home });
  for (let tries = 0; tries < 300 && !existsSync(log); tries++) await Bun.sleep(10);
  await clue.type("/new");
  await clue.type(ENTER);
  await Bun.sleep(400);
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
}, 25_000);

test("/new finds a skill added during the session", async () => {
  const home = mkdtempSync(join(tmpdir(), "clue-composer-home-"));
  const clue = await startClue({ home });
  await Bun.sleep(200);
  mkdirSync(join(home, "skills", "late-skill"), { recursive: true });
  writeFileSync(
    join(home, "skills", "late-skill", "SKILL.md"),
    "---\nname: late-skill\ndescription: Added late\n---\nBody\n",
  );
  await clue.type("/new");
  await clue.type(ENTER);
  await clue.type("read it");
  await clue.type(ENTER);
  await clue.turns(1);
  expect(JSON.stringify(requests[0].messages)).toContain("late-skill");
}, 25_000);

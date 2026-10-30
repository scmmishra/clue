import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Agent, type AgentEvents } from "./agent/loop";
import { msSince, now, uptimeMs } from "./clock";
import { describeError } from "./errors";
import { gitBranch, prefetchGitStatus } from "./agent/context";
import { KNOWN_MODELS, modelLabel, resolveModel } from "./agent/models";
import { getClient, MissingCredentials, preconnect, warmCache } from "./agent/provider";
import { mcpCommand } from "./commands/mcp";
import { EFFORTS, PERMISSION_MODES, type Effort, type PermissionMode, type Settings } from "./config";
import { McpManager } from "./mcp/manager";
import { Permissions } from "./permissions";
import { Session, sessionFile, type PromptImage, type TurnRecord } from "./session";
import { encodeImage } from "./tools/files";
import { stopAllProcesses, warmShellEnv } from "./tools/shell";
import { discoverSkills, type Skill } from "./tools/skills";
import type { Question } from "./tools/types";
import { duration, homePath, money, rows, style } from "./ui/ansi";
import { Editor, type Command } from "./ui/editor";
import { clipboardImage, clipboardSupported } from "./ui/clipboard";
import { findImagePaths } from "./ui/paste";
import { pickSession } from "./ui/picker";
import { detailLines, Pager, replay } from "./ui/replay";
import { Keyboard, Screen, type Key, type LiveFrame } from "./ui/screen";
import { turnStatus } from "./ui/status";
import { BAR, header, promptLines, statusLine, TurnView } from "./ui/turn";

const COMMANDS: Command[] = [
  { name: "help", description: "commands and keys" },
  { name: "model", description: "switch model for this session" },
  { name: "effort", description: "low, medium, high, xhigh or max" },
  { name: "permissions", description: "ask, auto or full-access" },
  { name: "resume", description: "pick a past session" },
  { name: "new", description: "start a fresh session" },
  { name: "mcp", description: "manage MCP servers" },
  { name: "paste", description: "attach the image on the clipboard" },
  { name: "cost", description: "tokens and cost of this session" },
  { name: "exit", description: "quit clue" },
];

const DOUBLE_PRESS_MS = 1500;
// A slash command's name has no second slash, so a pasted path like /tmp/a.png is a prompt.
const SLASH_COMMAND = /^\/[\w-]*(\s|$)/;

export type AppOptions = {
  settings: Settings;
  session: Session;
  resumed: boolean;
  benchReady?: boolean;
};

export class App {
  private screen = new Screen();
  private keyboard = new Keyboard();
  private editor = new Editor(COMMANDS);
  private session: Session;
  private agent!: Agent;
  private mcp!: McpManager;
  private permissions!: Permissions;
  private skillCache: Skill[] | null = null;
  private view: TurnView | null = null;
  private turn: AbortController | null = null;
  private pager: Pager | null = null;
  private lastEscape = 0;
  private lastInterrupt = 0;
  private hint = "";
  private warming: AbortController | null = null;
  private settings: Settings;
  private branch: string | null = null;
  // The message waiting for the turn to end. Only one can wait.
  private queued: { text: string; images: PromptImage[] } | null = null;

  constructor(private options: AppOptions) {
    this.settings = options.settings;
    this.session = options.session;
    this.screen.bell = options.settings.bell;
  }

  private get cwd() {
    return this.session.cwd;
  }

  // Everything that depends on the session's folder.
  private load(session: Session) {
    void this.mcp?.closeAll();
    this.session = session;
    if (process.cwd() !== session.cwd) process.chdir(session.cwd);
    this.branch = gitBranch(session.cwd);
    this.skillCache = null;
    this.mcp = new McpManager(session.cwd);
    this.permissions = new Permissions(this.settings.permission_mode, this.settings.permission, session.cwd);
    this.agent = new Agent({
      cwd: session.cwd,
      session,
      settings: { model: this.settings.model, effort: this.settings.effort, review_model: this.settings.review_model },
      permissions: this.permissions,
      mcp: this.mcp,
      skills: () => (this.skillCache ??= discoverSkills(session.cwd)),
      events: this.events(),
      interactive: true,
    });
  }

  // The agent talks to whichever TurnView is current.
  private events(): AgentEvents {
    const view = () => this.view;
    return {
      thinking: (note) => view()?.thinking(note),
      text: (delta) => view()?.text(delta),
      textDone: () => view()?.textDone(),
      toolStart: (id, label, kind) => view()?.toolStart(id, label, kind),
      toolUpdate: (id, label, note) => view()?.toolUpdate(id, label, note),
      toolEnd: (record) => view()?.toolEnd(record),
      review: (id, state, detail) => view()?.review(id, state, detail),
      confirm: (label, subject, pattern) => view()?.confirm(label, subject, pattern) ?? Promise.resolve("no"),
      question: (question: Question) => view()?.question(question) ?? Promise.resolve(null),
      notice: (text, tone) => view()?.notice(text, tone),
    };
  }

  async start() {
    this.load(this.session);
    // First paint, before anything slow.
    this.screen.commit([header(), ""]);
    if (this.options.resumed) this.printResumed();
    this.idle();
    this.keyboard.start();
    this.screen.flush();
    // The binary starts with a lazy JIT so startup code stays interpreted. Back to normal once interactive.
    Bun.unsafe.setJITPolicy?.(1);
    if (this.options.benchReady) {
      process.stderr.write(`ready ${uptimeMs().toFixed(2)}ms\n`);
      return this.exit(0, true);
    }

    // Everything else happens while the user types.
    this.screen.status("idle");
    prefetchGitStatus(this.cwd);
    this.skillCache ??= discoverSkills(this.cwd);
    preconnect();
    void warmShellEnv();
    this.mcp.startAll();
    this.noticeProjectServers();
    void getClient().catch((error) => {
      if (error instanceof MissingCredentials) this.print([`  ${style.orange("No Claude credentials yet.")} ${style.muted("Run `clue login` in another terminal, or set ANTHROPIC_API_KEY.")}`, ""]);
    });
    if (this.options.resumed) void this.warmResumedCache();

    process.on("SIGTERM", () => this.exit(0));
    process.stdout.on("resize", () => this.screen.refresh());
  }

  private print(lines: string[]) {
    this.screen.commit(lines);
  }

  private printResumed() {
    const { lines, hidden } = replay(this.session, Math.max(6, rows() - 8));
    this.print([
      `  ${style.faint(`session ${this.session.id} · ${this.session.turns.length} ${this.session.turns.length === 1 ? "prompt" : "prompts"}${hidden ? " · earlier turns hidden, ctrl+o shows all" : ""}`)}`,
      "",
      ...lines,
    ]);
  }

  private async warmResumedCache() {
    this.warming = new AbortController();
    const started = now();
    try {
      const usage = await warmCache({ model: this.settings.model, effort: this.settings.effort, messages: this.session.messages }, this.warming.signal);
      if (usage) this.print([`  ${style.faint(`history cached in ${duration(msSince(started))}`)}`, ""]);
    } catch {
      // Warming is an optimization. The first real request caches the history anyway.
    } finally {
      this.warming = null;
    }
  }

  private noticeProjectServers() {
    const waiting = [...this.mcp.servers.values()].filter((state) => state.status === "needs-approval").map((state) => state.entry.name);
    if (waiting.length) this.print([`  ${style.orange(`This project has MCP servers that need approval: ${waiting.join(", ")}.`)} ${style.muted("Run /mcp approve --all to start them.")}`, ""]);
  }

  // The input, with the queued message above it.
  private composer = (): LiveFrame => {
    const frame = this.editor.frame(this.hint ? style.faint(this.hint) : statusLine(this.permissions.mode, this.settings.model, this.settings.effort, this.cwd, this.branch));
    if (!this.queued) return frame;
    const preview = this.queued.text.replace(/\s+/g, " ").trim();
    return {
      lines: [`  ${style.muted(`Queued: ${preview}`)}  ${style.faint("↑ edit")}`, ...frame.lines],
      cursor: frame.cursor && { row: frame.cursor.row + 1, col: frame.cursor.col },
    };
  };

  // Waiting for input.
  private idle() {
    this.screen.setRenderer(this.composer);
    this.keyboard.set((key) => this.onIdleKey(key));
  }

  // Pasted text, with image paths that exist turned into attachments. Nothing pasted
  // means the clipboard held no text, which is how an image can arrive.
  private async paste(text: string) {
    if (!text.trim()) return this.pasteClipboard();
    const found = await Promise.all(
      findImagePaths(text).map(async (token) => {
        const block = await this.imageAt(token.path);
        return block ? [{ start: token.start, end: token.end, image: block }] : [];
      }),
    );
    this.editor.paste(text, found.flat());
    this.screen.refresh();
  }

  private async imageAt(path: string) {
    const file = resolve(this.cwd, path.replace(/^~(?=\/)/, homedir()));
    try {
      const stat = statSync(file, { throwIfNoEntry: false });
      return stat?.isFile() ? (await encodeImage(file, stat.size)).block : null;
    } catch {
      return null;
    }
  }

  private async pasteClipboard() {
    if (!clipboardSupported) return this.notice("Pasting an image from the clipboard works on macOS. Paste its file path instead.");
    const image = await clipboardImage();
    if (!image) return this.notice("No image on the clipboard.");
    this.editor.attach(image);
    this.screen.refresh();
  }

  private notice(text: string) {
    this.print([`  ${style.muted(text)}`, ""]);
  }

  private queueDraft() {
    if (!this.editor.text.trim()) return;
    if (this.queued) {
      this.hint = "One message is already queued. Press ↑ to edit it.";
      return this.screen.refresh();
    }
    this.queued = { text: this.editor.text, images: this.editor.images() };
    this.editor.remember(this.editor.text);
    this.editor.clear();
    this.screen.refresh();
  }

  private unqueue() {
    if (!this.queued) return;
    this.editor.restore(this.queued.text, this.queued.images);
    this.queued = null;
    this.screen.refresh();
  }

  private onIdleKey(key: Key) {
    if (this.pager) return this.pager.handle(key);
    if (key.ctrl && key.name === "o") return this.openDetail();
    if (key.ctrl && key.name === "c") {
      if (this.editor.text) {
        this.editor.clear();
        this.hint = "";
      } else if (Date.now() - this.lastInterrupt < DOUBLE_PRESS_MS) return this.exit(0);
      else {
        this.lastInterrupt = Date.now();
        this.hint = "press ctrl+c again to exit";
        setTimeout(() => {
          this.hint = "";
          this.screen.refresh();
        }, DOUBLE_PRESS_MS);
      }
      return this.screen.refresh();
    }
    if (key.ctrl && key.name === "d" && !this.editor.text) return this.exit(0);
    if (key.ctrl && key.name === "l") {
      process.stdout.write("\x1b[2J\x1b[H");
      return this.screen.flush();
    }
    if (key.name === "paste") return void this.paste(key.text ?? "");
    if (key.ctrl && key.name === "v") return void this.pasteClipboard();
    const result = this.editor.handle(key);
    if (result === "submit") {
      const text = this.editor.text;
      const images = this.editor.images();
      this.editor.remember(text);
      this.editor.clear();
      void this.submit(text, images);
      return;
    }
    this.screen.refresh();
  }

  private async submit(text: string, images: PromptImage[] = []) {
    const trimmed = text.trim();
    if (SLASH_COMMAND.test(trimmed) && !trimmed.includes("\n")) {
      this.screen.setRenderer(() => ({ lines: [] }));
      this.print([`${style.accent(BAR)}${style.muted(trimmed)}`, ""]);
      await this.command(trimmed);
      this.idle();
      return;
    }
    await this.runTurn(text, images);
  }

  private async runTurn(prompt: string, images: PromptImage[]) {
    this.warming?.abort();
    this.screen.setRenderer(() => ({ lines: [] }));
    this.print([...promptLines(prompt), ""]);
    this.screen.status("working");
    try {
      await getClient();
    } catch (error) {
      this.print([`  ${style.red((error as Error).message)}`, ""]);
      this.screen.status("error");
      return this.idle();
    }
    const view = new TurnView(this.screen, this.composer);
    this.view = view;
    this.turn = new AbortController();
    this.keyboard.set((key) => this.onTurnKey(key));
    view.start();
    let turn: TurnRecord | null = null;
    try {
      turn = await this.agent.runTurn(prompt, this.turn.signal, images);
    } catch (error) {
      view.notice(describeError(error), "error");
    }
    if (turn) view.finish(turn);
    else {
      this.screen.animate(false);
      this.screen.setRenderer(() => ({ lines: [] }));
      this.print([""]);
    }
    this.screen.status(turnStatus(turn), view.unattendedMs);
    this.view = null;
    this.turn = null;
    // A turn that ended early leaves the queued message for the user to decide on.
    const next = this.queued;
    if (next && turn && turn.stop !== "interrupted") {
      this.queued = null;
      return void this.submit(next.text, next.images);
    }
    this.unqueue();
    this.idle();
  }

  private onTurnKey(key: Key) {
    if (this.pager) return this.pager.handle(key);
    if (key.ctrl && key.name === "o") return this.openDetail();
    if (this.view?.handleKey(key)) return;
    const interrupt = () => {
      this.turn?.abort();
      this.view?.notice("Interrupting…", "warn");
    };
    if (key.ctrl && key.name === "c") return interrupt();
    if (key.name === "escape") {
      if (Date.now() - this.lastEscape < DOUBLE_PRESS_MS) return interrupt();
      this.lastEscape = Date.now();
      return;
    }
    this.hint = "";
    if (key.name === "paste") return void this.paste(key.text ?? "");
    if (key.ctrl && key.name === "v") return void this.pasteClipboard();
    if (key.name === "up" && this.queued) return this.unqueue();
    if (key.name === "tab" && !this.editor.hasCompletions) return this.queueDraft();
    if (this.editor.handle(key) === "submit") return this.queueDraft();
    this.screen.refresh();
  }

  private openDetail() {
    this.screen.suspend();
    const pager = new Pager(() => detailLines(this.session), `clue  session ${this.session.id}`, () => {
      this.pager = null;
      clearInterval(timer);
      this.screen.resume();
    });
    this.pager = pager;
    pager.open();
    // Keeps the view current while a turn is still running.
    const timer = setInterval(() => this.pager === pager && pager.draw(), 500);
  }

  private async command(input: string) {
    const [name, ...args] = input.slice(1).split(/\s+/);
    const say = (text: string) => this.print([`  ${text}`, ""]);
    switch (name) {
      case "help":
        this.print([
          ...COMMANDS.map((command) => `  ${style.accent(`/${command.name}`.padEnd(14))}${style.muted(command.description)}`),
          "",
          `  ${style.muted("enter send · alt+enter or \\ newline · ↑↓ history · tab complete · ctrl+v paste image")}`,
          `  ${style.muted("while clue works: tab queue a message · ↑ edit it")}`,
          `  ${style.muted("esc esc or ctrl+c interrupt · ctrl+o detail · ctrl+d exit")}`,
          "",
        ]);
        return;
      case "model": {
        if (!args[0]) {
          this.print([
            ...KNOWN_MODELS.map((id) => `  ${id === this.settings.model ? style.accent(`› ${id}`) : `  ${style.muted(id)}`}`),
            `  ${style.faint("Switch with /model <name>, such as /model sonnet.")}`,
            "",
          ]);
          return;
        }
        const model = resolveModel(args.join(" "));
        this.settings.model = model;
        this.agent.setModel(model);
        say(`Model is now ${style.bold(modelLabel(model))} ${style.faint(`(${model}). The next request starts a fresh cache.`)}`);
        return;
      }
      case "effort": {
        const effort = args[0] as Effort;
        if (!EFFORTS.includes(effort)) return say(style.muted(`Effort is ${this.settings.effort}. Choose one of ${EFFORTS.join(", ")}.`));
        this.settings.effort = effort;
        this.agent.setEffort(effort);
        return say(`Effort is now ${style.bold(effort)}.`);
      }
      case "permissions": {
        const mode = args[0] as PermissionMode;
        if (!PERMISSION_MODES.includes(mode)) return say(style.muted(`Permission mode is ${this.permissions.mode}. Choose ask, auto or full-access.`));
        this.permissions.mode = mode;
        this.settings.permission_mode = mode;
        return say(`Permission mode is now ${mode === "full-access" ? style.orange(mode) : style.bold(mode)}.`);
      }
      case "resume": {
        const choice = await pickSession(this.screen, this.keyboard, this.cwd);
        if (!choice) return;
        if (!existsSync(choice.cwd)) return say(style.red(`That session's folder no longer exists: ${homePath(choice.cwd)}.`));
        const session = Session.load(sessionFile(choice));
        if (!session) return say(style.red("That session file could not be read."));
        this.load(session);
        this.mcp.startAll();
        this.printResumed();
        void this.warmResumedCache();
        return;
      }
      case "new":
        this.load(Session.create(this.cwd));
        this.mcp.startAll();
        prefetchGitStatus(this.cwd);
        return say(style.muted("New session. Earlier sessions stay in /resume."));
      case "mcp":
        await mcpCommand(args, this.cwd, this.mcp, (lines) => this.print(lines));
        return;
      case "paste":
        return this.pasteClipboard();
      case "cost": {
        const total = this.session.turns.reduce(
          (sum, turn) => ({ cost: sum.cost + (turn.cost ?? 0), input: sum.input + turn.usage.input, cacheRead: sum.cacheRead + turn.usage.cacheRead, cacheWrite: sum.cacheWrite + turn.usage.cacheWrite, output: sum.output + turn.usage.output }),
          { cost: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        );
        return say(
          `${style.bold(money(total.cost))}  ${style.faint(`${this.session.turns.length} prompts   in ${total.input}   cache read ${total.cacheRead}   cache write ${total.cacheWrite}   out ${total.output}`)}`,
        );
      }
      case "exit":
      case "quit":
        return this.exit(0);
      default:
        return say(style.muted(`Unknown command /${name}. Type /help.`));
    }
  }

  async exit(code: number, quiet = false) {
    this.turn?.abort();
    this.warming?.abort();
    this.screen.animate(false);
    this.screen.setRenderer(() => ({ lines: [] }));
    this.screen.flush();
    this.screen.status("clear");
    this.keyboard.stop();
    stopAllProcesses();
    void this.mcp?.closeAll();
    if (!quiet && !this.session.isEmpty) process.stdout.write(`${style.faint(`  Resume this session with: clue -r ${this.session.id}`)}\n`);
    process.exit(code);
  }
}

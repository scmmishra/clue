import { existsSync } from "node:fs";
import { Agent, type AgentEvents } from "./agent/loop";
import { msSince, now, uptimeMs } from "./clock";
import { gitBranch } from "./agent/context";
import { KNOWN_MODELS, modelLabel, resolveModel } from "./agent/models";
import { getClient, MissingCredentials, preconnect, warmCache } from "./agent/provider";
import { mcpCommand } from "./commands/mcp";
import { EFFORTS, PERMISSION_MODES, type Effort, type PermissionMode, type Settings } from "./config";
import { McpManager } from "./mcp/manager";
import { Permissions } from "./permissions";
import { Session, sessionFile, type TurnRecord } from "./session";
import { stopAllProcesses, warmShellEnv } from "./tools/shell";
import { discoverSkills, type Skill } from "./tools/skills";
import type { Question } from "./tools/types";
import { duration, homePath, money, rows, style } from "./ui/ansi";
import { Editor, type Command } from "./ui/editor";
import { pickSession } from "./ui/picker";
import { detailLines, Pager, replay } from "./ui/replay";
import { Keyboard, Screen, type Key } from "./ui/screen";
import { header, promptLines, TurnView } from "./ui/turn";

const COMMANDS: Command[] = [
  { name: "help", description: "commands and keys" },
  { name: "model", description: "switch model for this session" },
  { name: "effort", description: "low, medium, high, xhigh or max" },
  { name: "permissions", description: "ask, auto or full-access" },
  { name: "resume", description: "pick a past session" },
  { name: "new", description: "start a fresh session" },
  { name: "mcp", description: "manage MCP servers" },
  { name: "cost", description: "tokens and cost of this session" },
  { name: "exit", description: "quit clue" },
];

const DOUBLE_PRESS_MS = 1500;

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

  constructor(private options: AppOptions) {
    this.settings = options.settings;
    this.session = options.session;
  }

  private get cwd() {
    return this.session.cwd;
  }

  // Everything that depends on the session's folder.
  private load(session: Session) {
    void this.mcp?.closeAll();
    this.session = session;
    if (process.cwd() !== session.cwd) process.chdir(session.cwd);
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
    const headerLine = header(this.settings.model, this.settings.effort, this.settings.permission_mode, this.cwd, gitBranch(this.cwd), uptimeMs());
    this.screen.commit([headerLine]);
    if (this.options.resumed) this.printResumed();
    else this.screen.commit([""]);
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
      `  ${style.faint(`session ${this.session.id}   ${this.session.turns.length} ${this.session.turns.length === 1 ? "prompt" : "prompts"}${hidden ? "   earlier turns hidden, ctrl+o shows all" : ""}`)}`,
      "",
      ...lines,
    ]);
  }

  private async warmResumedCache() {
    this.warming = new AbortController();
    const started = now();
    try {
      const usage = await warmCache({ model: this.settings.model, effort: this.settings.effort, messages: this.session.messages }, this.warming.signal);
      if (usage) this.print([`  ${style.faint(`history cached   ${duration(msSince(started))}`)}`, ""]);
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

  // Waiting for input.
  private idle() {
    this.screen.setRenderer(() => this.editor.frame(this.hint ? `  ${style.faint(this.hint)}` : undefined));
    this.keyboard.set((key) => this.onIdleKey(key));
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
    const result = this.editor.handle(key);
    if (result === "submit") {
      const text = this.editor.text;
      this.editor.remember(text);
      this.editor.clear();
      void this.submit(text);
      return;
    }
    this.screen.refresh();
  }

  private async submit(text: string) {
    const trimmed = text.trim();
    if (trimmed.startsWith("/") && !trimmed.includes("\n")) {
      this.screen.setRenderer(() => ({ lines: [] }));
      this.print([`${style.accent("›")} ${style.muted(trimmed)}`]);
      await this.command(trimmed);
      this.idle();
      return;
    }
    await this.runTurn(text);
  }

  private async runTurn(prompt: string) {
    this.warming?.abort();
    this.screen.setRenderer(() => ({ lines: [] }));
    this.print([...promptLines(prompt), ""]);
    try {
      await getClient();
    } catch (error) {
      this.print([`  ${style.red((error as Error).message)}`, ""]);
      return this.idle();
    }
    const view = new TurnView(this.screen);
    this.view = view;
    this.turn = new AbortController();
    this.keyboard.set((key) => this.onTurnKey(key));
    view.start();
    let turn: TurnRecord | null = null;
    try {
      turn = await this.agent.runTurn(prompt, this.turn.signal);
    } catch (error) {
      view.notice(describeError(error), "error");
    }
    if (turn) view.finish(turn);
    else {
      this.screen.animate(false);
      this.screen.setRenderer(() => ({ lines: [] }));
      this.print([""]);
    }
    this.view = null;
    this.turn = null;
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
    }
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
          `  ${style.muted("enter send   alt+enter or \\ newline   ↑↓ history   tab complete")}`,
          `  ${style.muted("esc esc or ctrl+c interrupt   ctrl+o detail   ctrl+d exit")}`,
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
        this.print([header(this.settings.model, this.settings.effort, this.permissions.mode, this.cwd, gitBranch(this.cwd))]);
        this.printResumed();
        void this.warmResumedCache();
        return;
      }
      case "new":
        this.load(Session.create(this.cwd));
        this.mcp.startAll();
        return say(style.muted("New session. Earlier sessions stay in /resume."));
      case "mcp":
        await mcpCommand(args, this.cwd, this.mcp, (lines) => this.print(lines));
        return;
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
    this.keyboard.stop();
    stopAllProcesses();
    void this.mcp?.closeAll();
    if (!quiet && !this.session.isEmpty) process.stdout.write(`${style.faint(`  Resume this session with: clue -r ${this.session.id}`)}\n`);
    process.exit(code);
  }
}

export function describeError(error: unknown) {
  const value = error as { status?: number; message?: string; error?: { error?: { message?: string } } };
  const message = value?.error?.error?.message ?? value?.message ?? String(error);
  if (value?.status === 401) return `Claude rejected the credentials (401). Run \`clue login\` or check ANTHROPIC_API_KEY. ${message}`;
  if (value?.status === 429) return `Rate limited by the API (429). ${message}`;
  if (value?.status && value.status >= 500) return `The API had an error (${value.status}). ${message}`;
  return message;
}

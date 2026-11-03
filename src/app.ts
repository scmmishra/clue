import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Agent, type AgentEvents, type Steer } from "./agent/loop";
import { msSince, now, uptimeMs } from "./clock";
import { describeError } from "./errors";
import { gitBranch, prefetchGitStatus } from "./agent/context";
import {
  advisorOf,
  apiModel,
  compactAt,
  FAST_MODELS,
  fastEnabled,
  KNOWN_MODELS,
  modelLabel,
  PAIR_EFFORTS,
  pairEffort,
  resolveModel,
  responseCost,
  responseUsage,
} from "./agent/models";
import { getClient, MissingCredentials, preconnect, warmCache } from "./agent/provider";
import { mcpCommand } from "./commands/mcp";
import { chooseCopy, lastReply } from "./copy";
import { EFFORTS, PERMISSION_MODES, type Effort, type PermissionMode, type Settings } from "./config";
import { McpManager } from "./mcp/manager";
import { Permissions } from "./permissions";
import { nameProblem, Session, sessionFile, type PromptImage, type TurnRecord } from "./session";
import { encodeImage } from "./tools/files";
import { display } from "./tools/files";
import { stopAllProcesses, warmShellEnv } from "./tools/shell";
import { discoverSkills, type Skill } from "./tools/skills";
import type { Question } from "./tools/types";
import { duration, homePath, style, tokens } from "./ui/ansi";
import { Editor, type Command } from "./ui/editor";
import { listPaths, recentPaths } from "./ui/file-mention";
import { OptionPicker, type Dial, type Option } from "./ui/option-picker";
import { RewindPicker, rewindReport } from "./ui/rewind";
import { undoReport } from "./ui/undo";
import { usageReport } from "./ui/usage";
import { clipboardImage, clipboardSupported, clipboardText, copyMethod, writeClipboard } from "./ui/clipboard";
import { findImagePaths } from "./ui/paste";
import { pickSession } from "./ui/picker";
import { detailLines, Pager, replay, RESUME_SCROLLBACK_BYTES } from "./ui/replay";
import { Keyboard, Screen, type Key, type LiveFrame } from "./ui/screen";
import { turnStatus } from "./ui/status";
import { BAR, header, markPrompt, promptLines, statusLine, TurnView } from "./ui/turn";

const COMMANDS: Command[] = [
  { name: "help", description: "commands and keys" },
  { name: "model", description: "switch model for this session" },
  { name: "effort", description: "low, medium, high, xhigh or max" },
  { name: "fast", description: "faster replies at twice the price" },
  { name: "permissions", description: "ask, auto or full-access" },
  { name: "resume", description: "pick a past session" },
  { name: "rename", description: "name this session" },
  { name: "new", description: "start a fresh session" },
  { name: "mcp", description: "manage MCP servers" },
  { name: "copy", description: "copy the last reply, or the part you describe" },
  { name: "paste", description: "attach the image on the clipboard" },
  { name: "compact", description: "replace the conversation with a summary" },
  { name: "undo", description: "restore the files changed in the last turn" },
  { name: "usage", description: "context, tokens and cost of this session" },
  { name: "cost", description: "same as /usage" },
  { name: "exit", description: "quit clue" },
];

const DOUBLE_PRESS_MS = 1500;
// A slash command's name has no second slash, so a pasted path like /tmp/a.png is a prompt.
const SLASH_COMMAND = /^\/[\w-]*(\s|$)/;

// Who owns the keyboard and the live area. Each mode has one key handler and one renderer,
// set together by App.enter, so they can't disagree.
// idle: the input. picker: a list under the input, such as /model or rewind.
// command: a slash command is running, and keys wait for it. turn: Claude is working.
type Mode = "idle" | "picker" | "command" | "turn";
const blank = (): LiveFrame => ({ lines: [] });

export type AppOptions = {
  settings: Settings;
  session: Session;
  resumed: boolean;
  // Sent as the first message once the prompt is ready.
  prompt?: string;
  // A prompt was given, but the session already existed.
  droppedPrompt?: boolean;
  // Problems with settings.json.
  warnings?: string[];
  benchReady?: boolean;
};

// The model id, or for a pair, such as "claude-sonnet-5-5 with opus advisor".
function modelDetail(id: string) {
  const advisor = advisorOf(id);
  return advisor ? `${apiModel(id)} with ${modelLabel(advisor).split(" ")[0]} advisor` : id;
}

export class App {
  private screen = new Screen();
  private keyboard = new Keyboard();
  private editor = new Editor(
    COMMANDS,
    () => listPaths(this.cwd),
    () => this.screen.refresh(),
    () => recentPaths(this.cwd),
  );
  private session: Session;
  private agent!: Agent;
  private mcp!: McpManager;
  private permissions!: Permissions;
  private skillCache: Skill[] | null = null;
  private view: TurnView | null = null;
  private turn: AbortController | null = null;
  private pager: Pager | null = null;
  private lastEscape = 0;
  private mode: Mode = "idle";
  // Keys typed while a command runs. They go to whichever mode follows it.
  private typedAhead: Key[] = [];
  private rewindPicker: RewindPicker | null = null;
  private optionPicker: OptionPicker | null = null;
  private onChosen: (value: string, level: string) => void = () => {};
  private lastInterrupt = 0;
  private hint = "";
  private warming: AbortController | null = null;
  // A resumed session warms the cache on the first key, so reading a session costs nothing.
  private warmOnKey = false;
  private settings: Settings;
  private branch: string | null = null;
  // The message waiting for the turn to end. Only one can wait.
  private queued: Steer | null = null;
  // The message waiting to reach the running turn with the next tool results. More text adds to it.
  private steering: Steer | null = null;

  constructor(private options: AppOptions) {
    this.settings = options.settings;
    this.session = options.session;
    this.screen.bell = options.settings.bell;
  }

  private get cwd() {
    return this.session.cwd;
  }

  // Everything that depends on the session's folder. True when MCP servers need starting.
  // Servers keep running in the same folder, so /new doesn't restart them.
  private load(session: Session) {
    const newFolder = !this.mcp || this.session.cwd !== session.cwd;
    this.warmOnKey = false;
    this.warming?.abort();
    this.session = session;
    if (process.cwd() !== session.cwd) process.chdir(session.cwd);
    this.branch = gitBranch(session.cwd);
    this.skillCache = null;
    if (newFolder) {
      void this.mcp?.closeAll();
      this.mcp = new McpManager(session.cwd);
    }
    this.permissions = new Permissions(this.settings.permission_mode, this.settings.permission, session.cwd);
    this.agent = new Agent({
      cwd: session.cwd,
      session,
      // The same object: the agent reads changes from here, and turns fast mode off if the API won't serve it.
      settings: this.settings,
      permissions: this.permissions,
      mcp: this.mcp,
      skills: () => (this.skillCache ??= discoverSkills(session.cwd)),
      events: this.events(),
      interactive: true,
    });
    return newFolder;
  }

  // The agent talks to whichever TurnView is current.
  private events(): AgentEvents {
    const view = () => this.view;
    return {
      thinking: (note) => view()?.thinking(note),
      text: (delta) => view()?.text(delta),
      textDone: () => view()?.textDone(),
      toolStart: (id, label, kind) => view()?.toolStart(id, label, kind),
      toolUpdate: (id, label, note, subagent) => view()?.toolUpdate(id, label, note, subagent),
      toolEnd: (record) => view()?.toolEnd(record),
      review: (id, state, detail) => view()?.review(id, state, detail),
      confirm: (label, subject, pattern, note) =>
        view()?.confirm(label, subject, pattern, note) ?? Promise.resolve("no"),
      question: (question: Question) => view()?.question(question) ?? Promise.resolve(null),
      notice: (text, tone) => view()?.notice(text, tone),
      toolsStopped: () => view()?.toolsStopped(),
      steer: () => {
        const steer = this.steering;
        if (!steer) return null;
        this.steering = null;
        view()?.steered(steer.text);
        this.screen.refresh();
        return steer;
      },
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
      if (error instanceof MissingCredentials)
        this.print([
          `  ${style.orange("No Claude credentials yet.")} ${style.muted("Run `clue login` in another terminal, or set ANTHROPIC_API_KEY.")}`,
          "",
        ]);
    });
    this.warmOnKey = this.options.resumed;

    process.on("SIGTERM", () => this.exit(0));
    // The terminal is gone, so exit can't draw. Commands ignore SIGHUP, so clue must stop them.
    process.on("SIGHUP", () => void stopAllProcesses().finally(() => process.exit(129)));
    process.stdout.on("resize", () => this.screen.refresh());

    for (const warning of this.options.warnings ?? []) this.print([`  ${style.orange(warning)}`, ""]);
    if (this.options.droppedPrompt) this.notice(`Resumed ${this.session.name}. Your prompt was not sent.`);
    if (this.options.prompt) {
      this.editor.remember(this.options.prompt);
      void this.submit(this.options.prompt);
    }
  }

  private print(lines: string[]) {
    this.screen.commit(lines);
  }

  private printResumed() {
    const { lines, hidden } = replay(this.session, RESUME_SCROLLBACK_BYTES);
    this.print([
      `  ${style.faint(`session ${this.session.name ?? this.session.id} · ${this.session.turns.length} ${this.session.turns.length === 1 ? "prompt" : "prompts"}${hidden ? " · earlier turns hidden, ctrl+o shows all" : ""}`)}`,
      "",
      ...lines,
    ]);
  }

  private async warmResumedCache() {
    const session = this.session;
    this.warming = new AbortController();
    const started = now();
    // Read before the request, so a /model or /fast during the warm-up can't misprice it.
    const model = this.settings.model;
    const fast = fastEnabled(this.settings);
    try {
      const usage = await warmCache(
        { model, effort: this.settings.effort, fast, messages: this.session.messages },
        this.warming.signal,
      );
      if (usage) {
        const used = responseUsage(usage);
        const price = responseCost(model, usage, fast);
        session.append({ t: "spend", usage: used, cost: price, model, at: Date.now() });
        this.print([`  ${style.faint(`history cached in ${duration(msSince(started))}`)}`, ""]);
      }
    } catch {
      // Warming is an optimization. The first real request caches the history anyway.
    } finally {
      this.warming = null;
    }
  }

  private noticeProjectServers() {
    const waiting = [...this.mcp.servers.values()]
      .filter((state) => state.status === "needs-approval")
      .map((state) => state.entry.name);
    if (waiting.length)
      this.print([
        `  ${style.orange(`This project has MCP servers that need approval: ${waiting.join(", ")}.`)} ${style.muted("Run /mcp approve --all to start them.")}`,
        "",
      ]);
  }

  // The input, with the queued message above it.
  private composer = (): LiveFrame => {
    const panel = this.rewindPicker ?? this.optionPicker;
    if (panel) {
      const { lines, cursor } = this.editor.frame("");
      return { lines: [...lines.slice(0, -1), ...panel.frame()], cursor };
    }
    const frame = this.editor.frame(
      this.hint
        ? style.muted(this.hint)
        : statusLine({
            mode: this.permissions.mode,
            model: this.settings.model,
            effort: this.settings.effort,
            cwd: this.cwd,
            branch: this.branch,
            fast: fastEnabled(this.settings),
            spent: this.session.spent,
          }),
    );
    const preview = (message: Steer) => message.text.replace(/\s+/g, " ").trim();
    const waiting = [
      ...(this.queued ? [`Queued: ${preview(this.queued)}`] : []),
      ...(this.steering ? [`Steering: ${preview(this.steering)}`] : []),
    ];
    if (!waiting.length) return frame;
    // ↑ takes back the bottom line first.
    const lines = waiting.map(
      (line, index) => `  ${style.muted(line)}${index === waiting.length - 1 ? `  ${style.faint("↑ edit")}` : ""}`,
    );
    return {
      lines: [...lines, ...frame.lines],
      cursor: frame.cursor && { row: frame.cursor.row + lines.length, col: frame.cursor.col },
    };
  };

  private enter(mode: Mode) {
    this.mode = mode;
    const [handler, render]: [(key: Key) => void, () => LiveFrame] =
      mode === "idle"
        ? [this.onIdleKey, this.composer]
        : mode === "picker"
          ? [this.onPickerKey, this.composer]
          : mode === "command"
            ? [this.onCommandKey, blank]
            : [this.onTurnKey, blank];
    this.keyboard.set((key) => handler.call(this, key));
    this.screen.setRenderer(render);
  }

  // Waiting for input.
  private idle() {
    this.enter("idle");
  }

  // A paste with no text can mean the clipboard holds an image, so clue looks for one.
  private async paste(text: string) {
    return text.trim() ? this.insertPaste(text) : this.pasteClipboard(text);
  }

  // Pasted text, with image paths that exist turned into attachments.
  private async insertPaste(text: string) {
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

  // The clipboard's image, or its text when it has none. `pasted` is what the terminal
  // already sent, such as a few spaces, and goes in as it is.
  private async pasteClipboard(pasted = "") {
    if (!clipboardSupported) {
      if (pasted) return this.insertPaste(pasted);
      return this.notice("Pasting an image from the clipboard works on macOS. Paste its file path instead.");
    }
    const image = await clipboardImage();
    if (image) {
      this.editor.attach(image);
      this.screen.refresh();
      return;
    }
    const text = pasted || (await clipboardText());
    if (text) return this.insertPaste(text);
    this.notice("The clipboard is empty.");
  }

  // Handles a key that adds to the input from outside it. True when the key was one.
  // Keys wait for the copy, so a prompt typed meanwhile can't start a turn under it.
  private async copy(request: string) {
    const method = copyMethod();
    if (!method) return this.notice("Copying needs a terminal that takes escape codes, and TERM is dumb here.");
    const reply = lastReply(this.session.messages);
    if (request && reply) this.screen.status("working");
    const choice = await chooseCopy(reply, request, this.settings.copy);
    this.screen.status("idle");
    if ("problem" in choice) return this.notice(choice.problem);
    if (!(await writeClipboard(choice.text, method)))
      return this.print([`  ${style.red("pbcopy failed, so nothing was copied.")}`, ""]);
    const notes = [choice.note, method === "terminal" ? this.terminalCopyNote() : undefined].filter(Boolean);
    this.print([`  ${style.muted(choice.summary)}`, ...notes.map((note) => `  ${style.faint(note!)}`), ""]);
  }

  // A terminal never says whether it took an OSC 52 copy, and some turn them off until
  // asked. The first copy in a session says how to turn it on.
  private terminalCopyNoted = false;
  private terminalCopyNote() {
    if (this.terminalCopyNoted) return undefined;
    this.terminalCopyNoted = true;
    return process.env.TMUX
      ? "The terminal sets the clipboard. In tmux, that needs `set -g set-clipboard on`."
      : "The terminal sets the clipboard. If nothing arrived, allow clipboard access in its settings.";
  }

  private async compact() {
    const before = this.session.turns.at(-1)?.context;
    this.print([`  ${style.muted("Compacting…")}`]);
    this.screen.status("working");
    try {
      const result = await this.agent.compact(new AbortController().signal);
      if ("problem" in result) this.print([`  ${style.orange(result.problem)} ${style.muted("Nothing changed.")}`, ""]);
      else {
        const size = `${before ? `${tokens(before)} tokens into ` : ""}a ${tokens(result.summaryTokens)} token summary`;
        const note = result.kept
          ? "Recent messages stay as they were. Older images and file contents are gone, and Claude reads files again when it needs them."
          : "Images and file contents are gone. Claude reads files again when it needs them.";
        this.print([`  ${style.muted(`Compacted ${size}.`)}`, `  ${style.faint(note)}`, ""]);
      }
    } catch (error) {
      this.print([`  ${style.red(describeError(error))}`, ""]);
    }
    this.screen.status("idle");
  }

  private setPermissionMode(mode: PermissionMode) {
    this.permissions.mode = mode;
    this.settings.permission_mode = mode;
  }

  private cycleKey(key: Key) {
    if (key.name !== "tab" || !key.shift) return false;
    const next = (PERMISSION_MODES.indexOf(this.permissions.mode) + 1) % PERMISSION_MODES.length;
    this.setPermissionMode(PERMISSION_MODES[next]);
    this.screen.refresh();
    return true;
  }

  private pasteKey(key: Key) {
    if (key.name === "paste") this.keyboard.hold(this.paste(key.text ?? ""));
    else if (key.ctrl && key.name === "v") this.keyboard.hold(this.pasteClipboard());
    else return false;
    return true;
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

  // Enter during a turn. A command can't steer, because Claude would get it as text, so it queues.
  private steerDraft() {
    const text = this.editor.text;
    if (!text.trim()) return;
    if (text.trim().startsWith("/")) return this.queueDraft();
    const images = this.editor.images();
    this.steering = this.steering
      ? { text: `${this.steering.text}\n\n${text}`, images: [...this.steering.images, ...images] }
      : { text, images };
    this.editor.remember(text);
    this.editor.clear();
    this.screen.refresh();
  }

  // ↑ during a turn: the steering message comes back first, then the queued one.
  private takeBack() {
    if (this.steering) {
      this.editor.restore(this.steering.text, this.steering.images);
      this.steering = null;
    } else if (this.queued) {
      this.editor.restore(this.queued.text, this.queued.images);
      this.queued = null;
    }
    this.screen.refresh();
  }

  // Both waiting messages back to the editor, so nothing typed is lost. Each goes in front
  // of the text, so the steering message ends up first.
  private unqueue() {
    for (const message of [this.queued, this.steering]) if (message) this.editor.restore(message.text, message.images);
    this.queued = this.steering = null;
    this.screen.refresh();
  }

  private openRewind() {
    const points = this.session.rewindPoints;
    if (!points.length) return this.print([`  ${style.muted("Nothing to rewind.")}`, ""]);
    const { undo } = this.agent;
    const rows = points.map((point) => ({
      point,
      ...undo.summary(point.transcript),
      restorable: undo.covers(point.transcript),
    }));
    this.editor.closePicker();
    this.rewindPicker = new RewindPicker(rows);
    this.enter("picker");
  }

  private choose(
    title: string,
    options: Option[],
    current: string,
    onChosen: (value: string, level: string) => void,
    dial?: Dial,
  ) {
    this.editor.closePicker();
    this.optionPicker = new OptionPicker(title, options, current, dial);
    this.onChosen = onChosen;
    this.enter("picker");
  }

  private closePicker() {
    this.rewindPicker = this.optionPicker = null;
    this.idle();
  }

  // Ctrl+C cancels a list, like esc.
  private onPickerKey(key: Key) {
    if (this.pager) return this.pager.handle(key);
    const cancel = key.ctrl && key.name === "c" ? { name: "escape" } : key;
    if (this.rewindPicker) return this.rewindKey(cancel);
    if (this.optionPicker) return this.optionKey(cancel);
    this.closePicker();
  }

  private optionKey(key: Key) {
    const picker = this.optionPicker!;
    const value = picker.handle(key);
    if (value !== null) this.closePicker();
    if (value) this.onChosen(value, picker.chosenLevel);
    this.screen.refresh();
  }

  private setModel(model: string, effort?: Effort) {
    const wasFast = fastEnabled(this.settings);
    this.settings.model = model;
    this.print([
      `  Model is now ${style.bold(modelLabel(model))} ${style.faint(`(${modelDetail(model)}). The next request starts a fresh cache.`)}`,
      "",
    ]);
    if (effort && effort !== this.settings.effort) this.setEffort(effort);
    else this.raiseEffortForPair();
    // Coming back to a fast model later must not start charging double without a word.
    if (wasFast && !fastEnabled(this.settings)) {
      this.settings.fast = false;
      this.print([`  ${style.muted(`Fast mode is off. It only works with ${FAST_MODELS.join(" and ")}.`)}`, ""]);
    }
  }

  private setEffort(effort: Effort) {
    this.settings.effort = effort;
    this.print([`  Effort is now ${style.bold(effort)}.`, ""]);
    this.raiseEffortForPair();
  }

  // Below medium, a pair's executor rarely asks its advisor, so a pair runs at medium or above.
  private raiseEffortForPair() {
    const effort = pairEffort(this.settings.model, this.settings.effort);
    if (effort === this.settings.effort) return;
    this.settings.effort = effort;
    this.print([
      `  ${style.muted(`Effort is ${effort}. Below that, ${modelLabel(this.settings.model)} rarely asks its advisor.`)}`,
      "",
    ]);
  }

  private setFast(fast: boolean) {
    if (fast && !fastEnabled({ ...this.settings, fast })) {
      this.print([`  ${style.muted(`Fast mode only works with ${FAST_MODELS.join(" and ")}.`)}`, ""]);
      return;
    }
    this.settings.fast = fast;
    this.print([
      fast
        ? `  Fast mode is ${style.orange("on")}. ${style.faint("Tokens cost twice as much. The next request starts a fresh cache.")}`
        : `  Fast mode is ${style.bold("off")}. ${style.faint("The next request starts a fresh cache.")}`,
      "",
    ]);
  }

  private announcePermissionMode(mode: PermissionMode) {
    this.setPermissionMode(mode);
    this.print([`  Permission mode is now ${mode === "full-access" ? style.orange(mode) : style.bold(mode)}.`, ""]);
  }

  private rewindKey(key: Key) {
    const picker = this.rewindPicker!;
    const choice = picker.handle(key);
    if (choice === "cancel") this.closePicker();
    else if (choice) {
      const dropped = picker.turnsDropped;
      const result = this.agent.rewind(choice.point, choice);
      if (result?.kind === "changed") picker.conflict(result.paths.map((path) => display(this.cwd, path)));
      else {
        this.closePicker();
        this.print(rewindReport(dropped, result, this.cwd));
        this.editor.restore(choice.point.text, []);
      }
    }
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
    if (key.name === "escape" && !this.editor.pickerOpen) {
      const opens = Date.now() - this.lastEscape < DOUBLE_PRESS_MS;
      // A pair is used up, so the next single esc doesn't open it again.
      this.lastEscape = opens ? 0 : Date.now();
      if (opens) this.openRewind();
      return;
    }
    if (key.ctrl && key.name === "l") {
      process.stdout.write("\x1b[2J\x1b[H");
      return this.screen.flush();
    }
    if (this.cycleKey(key) || this.pasteKey(key)) return;
    if (this.warmOnKey && key.text && key.text !== "/" && !this.editor.text.startsWith("/")) {
      this.warmOnKey = false;
      void this.warmResumedCache();
    }
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

  // Every prompt and command starts here, typed or queued, so each runs in its own mode.
  private async submit(text: string, images: PromptImage[] = []) {
    const trimmed = text.trim();
    if (SLASH_COMMAND.test(trimmed) && !trimmed.includes("\n")) {
      // Before the first await: keys typed from here on wait for the command.
      this.enter("command");
      this.print([...markPrompt([`${style.brand(BAR)}${style.muted(trimmed)}`]), ""]);
      try {
        await this.command(trimmed);
      } finally {
        this.endCommand();
      }
      return;
    }
    await this.runTurn(text, images);
  }

  // Back to the input, unless the command handed the keyboard on, such as to a list.
  // Then the keys typed meanwhile go to whatever mode is current, as if typed now.
  private endCommand() {
    if (this.mode === "command") this.idle();
    const keys = this.typedAhead;
    this.typedAhead = [];
    for (const key of keys) this.keyboard.deliver(key);
  }

  // Keys during a command wait for it, so Enter can't start a turn under it or steer
  // a turn that isn't running. Ctrl+C twice still exits, since a command can wait minutes.
  private onCommandKey(key: Key) {
    if (key.ctrl && key.name === "c") {
      if (Date.now() - this.lastInterrupt < DOUBLE_PRESS_MS) return void this.exit(0);
      this.lastInterrupt = Date.now();
      return;
    }
    this.typedAhead.push(key);
  }

  private async runTurn(prompt: string, images: PromptImage[]) {
    this.warmOnKey = false;
    this.warming?.abort();
    // Before the first await: a second Enter must queue, not start a second turn.
    this.enter("turn");
    this.print([...promptLines(prompt), ""]);
    this.screen.status("working");
    try {
      await getClient();
    } catch (error) {
      this.print([`  ${style.red((error as Error).message)}`, ""]);
      this.screen.status("error");
      this.unqueue();
      return this.idle();
    }
    const view = new TurnView(this.screen, this.composer);
    this.view = view;
    this.turn = new AbortController();
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
    // A turn that ended early leaves the waiting messages for the user to decide on. A steering
    // message that found no tool results to ride along with goes first, and the queued one waits for it.
    const next = this.steering ?? this.queued;
    if (next && turn && turn.stop !== "interrupted") {
      if (next === this.steering) this.steering = null;
      else this.queued = null;
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
    if (key.name === "escape" && !this.editor.pickerOpen) {
      if (Date.now() - this.lastEscape < DOUBLE_PRESS_MS) return interrupt();
      this.lastEscape = Date.now();
      return;
    }
    this.hint = "";
    if (this.cycleKey(key) || this.pasteKey(key)) return;
    if (key.name === "up" && (this.queued || this.steering) && !this.editor.hasCompletions) return this.takeBack();
    if (key.name === "tab" && !this.editor.hasCompletions) return this.queueDraft();
    if (this.editor.handle(key) === "submit") return this.steerDraft();
    this.screen.refresh();
  }

  private openDetail() {
    this.screen.suspend();
    const pager = new Pager(
      () => detailLines(this.session),
      `clue  session ${this.session.name ?? this.session.id}`,
      () => {
        this.pager = null;
        clearInterval(timer);
        this.screen.resume();
      },
    );
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
          ...COMMANDS.map(
            (command) => `  ${style.accent(`/${command.name}`.padEnd(14))}${style.muted(command.description)}`,
          ),
          "",
          `  ${style.muted("enter send · shift+enter, alt+enter or \\ newline · ↑↓ history · @ file · tab complete · shift+tab permission mode")}`,
          `  ${style.muted("while clue works: enter steer the turn · tab queue for after it · ↑ edit")}`,
          `  ${style.muted("esc esc interrupt, or rewind when idle · ctrl+c interrupt · ctrl+o detail · ctrl+d exit")}`,
          "",
        ]);
        return;
      case "model": {
        if (args[0]) return this.setModel(resolveModel(args.join(" ")));
        const options = KNOWN_MODELS.map((id) => {
          const advisor = advisorOf(id);
          return {
            value: id,
            label: modelLabel(id),
            detail: modelDetail(id),
            levels: advisor ? PAIR_EFFORTS : EFFORTS,
          };
        });
        return this.choose(
          "Model:",
          options,
          this.settings.model,
          (model, effort) => this.setModel(model, effort as Effort),
          { name: "Effort", level: this.settings.effort },
        );
      }
      case "effort": {
        const effort = args[0] as Effort;
        if (!args[0]) {
          const options = EFFORTS.map((value) => ({ value, label: value }));
          return this.choose("Effort:", options, this.settings.effort, (value) => this.setEffort(value as Effort));
        }
        if (!EFFORTS.includes(effort))
          return say(style.muted(`Effort is ${this.settings.effort}. Choose one of ${EFFORTS.join(", ")}.`));
        return this.setEffort(effort);
      }
      case "fast": {
        if (args[0] && args[0] !== "on" && args[0] !== "off")
          return say(
            style.muted(`Fast mode is ${this.settings.fast ? "on" : "off"}. Use /fast, /fast on or /fast off.`),
          );
        return this.setFast(args[0] ? args[0] === "on" : !this.settings.fast);
      }
      case "permissions": {
        const mode = args[0] as PermissionMode;
        if (!args[0]) {
          const options = PERMISSION_MODES.map((value) => ({ value, label: value }));
          return this.choose("Permission mode:", options, this.permissions.mode, (value) =>
            this.announcePermissionMode(value as PermissionMode),
          );
        }
        if (!PERMISSION_MODES.includes(mode))
          return say(style.muted(`Permission mode is ${this.permissions.mode}. Choose ask, auto or full-access.`));
        return this.announcePermissionMode(mode);
      }
      case "resume": {
        const choice = await pickSession(this.screen, this.keyboard, this.cwd);
        if (!choice) return;
        if (!existsSync(choice.cwd))
          return say(style.red(`That session's folder no longer exists: ${homePath(choice.cwd)}.`));
        const session = Session.load(sessionFile(choice));
        if (!session) return say(style.red("That session file could not be read."));
        if (this.load(session)) this.mcp.startAll();
        this.printResumed();
        this.warmOnKey = true;
        return;
      }
      case "rename": {
        const name = args.join(" ");
        if (!name)
          return say(
            this.session.name
              ? `This session is ${style.bold(this.session.name)}.`
              : style.muted("This session has no name. Set one with /rename <name>."),
          );
        const problem = nameProblem(this.cwd, name, this.session.id);
        if (problem) return say(style.red(problem));
        this.session.rename(name);
        return say(`Session is now ${style.bold(name)}.`);
      }
      case "new":
        if (this.load(Session.create(this.cwd))) this.mcp.startAll();
        prefetchGitStatus(this.cwd);
        return say(style.muted("New session. Earlier sessions stay in /resume."));
      case "mcp":
        await mcpCommand(args, this.cwd, this.mcp, (lines) => this.print(lines));
        return;
      case "copy":
        return this.copy(args.join(" "));
      case "paste":
        return this.pasteClipboard();
      case "compact":
        if (this.session.isEmpty) return say(style.muted("Nothing to compact."));
        return this.compact();
      case "undo":
        return this.print(undoReport(this.agent.undo.undo(args[0] === "force"), this.cwd));
      case "cost":
      case "usage":
        return this.print(
          usageReport(
            this.session.turns,
            this.session.compactions,
            this.session.rewound,
            this.session.spends,
            compactAt(this.settings.model),
          ),
        );
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
    await stopAllProcesses();
    void this.mcp?.closeAll();
    if (!quiet && !this.session.isEmpty)
      process.stdout.write(
        `${style.faint(`  Resume this session with: clue -r ${this.session.name ?? this.session.id}`)}\n`,
      );
    process.exit(code);
  }
}

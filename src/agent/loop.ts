import type Anthropic from "@anthropic-ai/sdk";
import { isObject, type Effort, type Settings } from "../config";
import type { McpManager } from "../mcp/manager";
import { approvalQuestion, Permissions, reviewAction, reviewContext } from "../permissions";
import {
  CONTINUE_PROMPT,
  Session,
  type PromptImage,
  type RewindPoint,
  type ToolRecord,
  type TurnRecord,
  type Usage,
} from "../session";
import { findTool } from "../tools";
import type { Skill } from "../tools/skills";
import { clip, type Question, type ToolContext, type ToolOutput } from "../tools/types";
import { buildContext } from "./context";
import { msSince, now } from "../clock";
import {
  addUsage,
  advisorCost,
  advisorOf,
  COMPACTION_TRIGGER_TOKENS,
  cost,
  emptyUsage,
  fastEnabled,
  modelLabel,
  responseUsage,
} from "./models";
import { dropRejectedFeature, fastRejected, stream, summarize } from "./provider";
import { UndoStack, type UndoResult } from "./undo";

type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export type ConfirmAnswer = "once" | "always" | "no";

// What the loop tells the interface. The terminal UI and `clue ask` each implement it.
export type AgentEvents = {
  thinking(note: string | null): void;
  text(delta: string): void;
  textDone(): void;
  toolStart(id: string, label: string, kind: string): void;
  toolUpdate(id: string, label: string, note?: string): void;
  toolEnd(record: ToolRecord): void;
  review(id: string, state: "reviewing" | "approved" | "held", detail?: string): void;
  // `note` says why clue asks when it isn't the usual approval, such as a reviewer's flag.
  confirm(label: string, subject: string, pattern: string, note?: string): Promise<ConfirmAnswer>;
  question(question: Question): Promise<string | null>;
  notice(text: string, tone?: "info" | "warn" | "error"): void;
  // A message the user typed to steer the running turn, taken once. The loop sends it with
  // the next tool results, so Claude reads it before its next step.
  steer?(): Steer | null;
};

export type Steer = { text: string; images: PromptImage[] };

export type AgentOptions = {
  cwd: string;
  session: Session;
  settings: Pick<Settings, "model" | "effort" | "fast" | "review">;
  permissions: Permissions;
  mcp: McpManager;
  skills: () => Skill[];
  events: AgentEvents;
  interactive: boolean;
  subagent?: boolean;
  // A subagent can't show a notice, and its settings are a copy, so its parent turns fast mode off.
  onFastOff?: () => void;
};

// A turn's spend so far. Requests are priced as they arrive, because speed can differ between them.
type Tally = { usage: Usage; cost: number | null };

function tallyUp(tally: Tally, usage: Usage, price: number | null) {
  for (const key of Object.keys(usage) as (keyof Usage)[]) tally.usage[key] += usage[key];
  tally.cost = tally.cost === null || price === null ? null : tally.cost + price;
}

const MAX_JSON_RETRIES = 2;
const MAX_FEATURE_RETRIES = 3;
const ERROR_NOTE_CHARS = 60;

export class Agent {
  readStamps = new Map<string, number>();
  seenInstructions = new Set<string>();
  undo = new UndoStack(this.readStamps);
  private lastContext = 0;

  constructor(private options: AgentOptions) {
    this.undo.startAt(options.session.transcript.length);
  }

  get session() {
    return this.options.session;
  }

  // Replaces the conversation with a summary. Returns its size in tokens, or why there is none.
  async compact(signal: AbortSignal): Promise<{ summaryTokens: number } | { problem: string }> {
    const { session, settings } = this.options;
    session.closeUnfinishedTools();
    const model = settings.model;
    const fast = fastEnabled(settings);
    const message = await summarize({ model, effort: settings.effort, fast, messages: session.messages }, signal);
    const iterations = message.usage.iterations ?? [];
    const usage = emptyUsage();
    for (const iteration of iterations) addUsage(usage, iteration);
    // Known gap: this early return records no cost. It matters only if the API bills a summary
    // that didn't finish, which isn't confirmed, so it stays for now.
    if (message.stop_reason !== "compaction" || !message.content.some((block) => block.type === "compaction")) {
      return { problem: `The summary didn't finish (${message.stop_reason ?? "no reason given"}).` };
    }
    session.append({
      t: "compacted",
      message: { role: "assistant", content: message.content as Anthropic.Beta.Messages.BetaContentBlockParam[] },
      usage,
      cost: cost(model, usage, fast),
      model,
      at: Date.now(),
    });
    // The summary doesn't hold file contents or instructions, so Claude has to read them again.
    this.readStamps.clear();
    this.seenInstructions.clear();
    this.lastContext = 0;
    return { summaryTokens: usage.output };
  }

  // Goes back to before a prompt. Returns the file result, or null when files stay as they are.
  // If files changed since, it returns that result and leaves the conversation alone.
  rewind(point: RewindPoint, { keepFiles = false, force = false } = {}) {
    let files: UndoResult | null = null;
    if (keepFiles || !this.undo.covers(point.transcript)) this.undo.forgetFrom(point.transcript);
    else {
      files = this.undo.rewindTo(point.transcript, force);
      if (files.kind === "changed") return files;
    }
    this.options.session.append({ t: "rewind", transcript: point.transcript, turns: point.turns });
    // Claude no longer has what it read in the dropped turns.
    this.readStamps.clear();
    this.seenInstructions.clear();
    this.lastContext = 0;
    return files;
  }

  // Automatic compaction can't run on a session with a /compact summary, so clue triggers it here.
  private async compactIfFull(signal: AbortSignal, midTurn: boolean) {
    const { session, events } = this.options;
    if (!session.carriesSummary || this.lastContext < COMPACTION_TRIGGER_TOKENS) return;
    let problem: string | null = null;
    try {
      const result = await this.compact(signal);
      if ("problem" in result) problem = result.problem;
    } catch (error) {
      problem = (error as Error).message;
    }
    if (problem) {
      // Trying again before the next request would only repeat the failure.
      this.lastContext = 0;
      return events.notice(`Compaction failed. ${problem}`, "warn");
    }
    events.notice("Compacted the conversation.", "info");
    // A request can't end on the summary, which is an assistant message.
    if (midTurn) session.appendMessage({ role: "user", content: CONTINUE_PROMPT });
  }

  private turnOffFast() {
    const { settings, events, onFastOff } = this.options;
    settings.fast = false;
    if (onFastOff) return onFastOff();
    events.notice("Fast mode isn't available now, so clue turned it off. Run /fast to try again.", "warn");
  }

  // Runs one user prompt to completion: model turns and tool calls until Claude stops.
  async runTurn(prompt: string, signal: AbortSignal, images: PromptImage[] = []): Promise<TurnRecord> {
    const { session, events, settings } = this.options;
    const startedAt = Date.now();
    const clock = now();
    let firstTokenMs: number | null = null;
    const tally: Tally = { usage: emptyUsage(), cost: 0 };
    let context: number | undefined;
    let toolCount = 0;
    let stop = "end_turn";
    let model = settings.model;
    let fast = false;

    session.closeUnfinishedTools();
    this.lastContext ||= session.lastContextSize ?? 0;
    await this.compactIfFull(signal, false);
    const promptAt = session.transcript.length;
    if (!this.options.subagent) this.undo.beginTurn(promptAt);
    if (session.needsContext) {
      const context = await buildContext(
        this.options.cwd,
        this.options.skills(),
        this.options.mcp.configuredNames(),
        this.seenInstructions,
      );
      session.appendMessage({
        role: "user",
        content: [{ type: "text", text: context }, { type: "text", text: prompt }, ...images],
      });
    } else {
      session.appendMessage({
        role: "user",
        content: images.length ? [{ type: "text", text: prompt }, ...images] : prompt,
      });
    }

    const finish = (ending: string) => {
      const turn: TurnRecord = {
        prompt,
        startedAt,
        ms: msSince(clock),
        firstTokenMs,
        tools: toolCount,
        usage: tally.usage,
        cost: tally.cost,
        model,
        stop: ending,
        context,
        fast: fast || undefined,
        transcript: promptAt,
      };
      session.append({ t: "turn", turn });
      return turn;
    };

    let jsonRetries = 0;
    let featureRetries = 0;

    while (true) {
      if (signal.aborted) {
        stop = "interrupted";
        break;
      }
      if (toolCount) await this.compactIfFull(signal, true);
      model = settings.model;
      const askedFast = fastEnabled(settings);
      let message: Anthropic.Beta.Messages.BetaMessage;
      try {
        message = await this.request(model, settings.effort, askedFast, signal, () => {
          firstTokenMs ??= msSince(clock);
        });
        jsonRetries = 0;
      } catch (error) {
        // The SDK is loaded by now: the request needed it. Importing it here keeps it off the startup path.
        const { default: Sdk } = await import("@anthropic-ai/sdk");
        if (signal.aborted || error instanceof Sdk.APIUserAbortError) {
          stop = "interrupted";
          break;
        }
        if (
          error instanceof Sdk.BadRequestError &&
          featureRetries < MAX_FEATURE_RETRIES &&
          dropRejectedFeature(error)
        ) {
          featureRetries += 1;
          continue;
        }
        // Fast mode has its own rate limit, so a standard request can still go through.
        if (
          askedFast &&
          (error instanceof Sdk.RateLimitError || (error instanceof Sdk.BadRequestError && fastRejected(error)))
        ) {
          this.turnOffFast();
          continue;
        }
        if (!(error instanceof Sdk.APIError) && error instanceof SyntaxError && jsonRetries < MAX_JSON_RETRIES) {
          jsonRetries += 1;
          events.notice("A tool input arrived as broken JSON. Asking again.", "warn");
          continue;
        }
        // Earlier requests of this turn were paid for, and the session must stay findable.
        finish("error");
        throw error;
      }

      const servedFast = (message.usage.speed ?? (askedFast ? "fast" : "standard")) === "fast";
      const used = responseUsage(message.usage);
      const executorPrice = cost(model, used, servedFast);
      const advisorPrice = advisorCost(message.usage);
      tallyUp(tally, used, executorPrice === null || advisorPrice === null ? null : executorPrice + advisorPrice);
      fast ||= servedFast;
      context = this.lastContext = contextTokens(message.usage);
      session.appendMessage({
        role: "assistant",
        content: message.content as Anthropic.Beta.Messages.BetaContentBlockParam[],
      });
      stop = message.stop_reason ?? "end_turn";

      if (stop === "pause_turn") continue;
      if (stop === "refusal") {
        events.notice("Claude declined this request.", "warn");
        break;
      }
      const toolUses = message.content.filter((block): block is ToolUse => block.type === "tool_use");
      if (toolUses.length === 0) {
        if (stop === "max_tokens") events.notice("The reply hit the output limit and was cut off.", "warn");
        break;
      }
      if (stop === "max_tokens") {
        // A tool input cut off mid-way must not run.
        const results: ToolResult[] = toolUses.map((use) => ({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: "The tool input was cut off by the output limit. Retry with smaller steps.",
        }));
        session.appendMessage({ role: "user", content: results });
        continue;
      }

      toolCount += toolUses.length;
      const results = await this.runTools(toolUses, prompt, signal, tally);
      // Text after the results is allowed, unless a server tool still waits for its result.
      const steer = signal.aborted || awaitsServerTool(message.content) ? null : (events.steer?.() ?? null);
      session.appendMessage({
        role: "user",
        content: steer ? [...results, { type: "text", text: steer.text }, ...steer.images] : results,
      });
      if (signal.aborted) {
        stop = "interrupted";
        break;
      }
    }

    return finish(stop);
  }

  // One streamed model request. Forwards text, progress notes and tool activity as they arrive.
  private async request(model: string, effort: Effort, fast: boolean, signal: AbortSignal, onFirstToken: () => void) {
    const { events } = this.options;
    const response = await stream(
      { model, effort, fast, messages: this.session.messages, subagent: this.options.subagent },
      signal,
    );
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
    // Advisor calls waiting for their answer, by id. The answer arrives whole, after a pause.
    const asking = new Map<string, number>();
    let inText = false;
    events.thinking("");

    for await (const event of response) {
      if (event.type === "content_block_start") {
        const block = event.content_block as ContentBlock;
        blocks.set(event.index, {
          type: block.type,
          id: (block as { id?: string }).id,
          name: (block as { name?: string }).name,
          json: "",
        });
        if (block.type === "tool_use") {
          const tool = findTool(block.name);
          events.toolStart(block.id, tool ? safeLabel(tool, {}, false) : block.name, tool ? tool.kind : "mcp");
        } else if (block.type === "server_tool_use" && block.name === "advisor") {
          asking.set(block.id, Date.now());
          events.toolStart(block.id, `Asking ${this.advisorLabel()}`, "advisor");
        } else if (block.type === "server_tool_use") {
          events.toolStart(block.id, block.name === "web_fetch" ? "Fetching" : "Searching the web", "web");
        } else if (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
          events.toolUpdate(block.tool_use_id, "", "done");
        } else if ((block.type as string) === "advisor_tool_result") {
          const answer = block as unknown as { tool_use_id: string; content?: { type?: string; error_code?: string } };
          const record = this.advisorRecord(answer.tool_use_id, asking.get(answer.tool_use_id), answer.content);
          this.session.append({ t: "tool", tool: record });
          events.toolEnd(record);
        }
      } else if (event.type === "content_block_delta") {
        onFirstToken();
        const block = blocks.get(event.index);
        const delta = event.delta;
        if (delta.type === "text_delta") {
          if (!inText) events.thinking(null);
          inText = true;
          events.text(delta.text);
        } else if (delta.type === "thinking_delta") {
          if (delta.thinking.trim()) events.thinking(delta.thinking);
        } else if (delta.type === "input_json_delta" && block) {
          block.json += delta.partial_json;
          if (block.type === "tool_use" && block.id) {
            const tool = findTool(block.name ?? "");
            const preview = previewInput(block.json);
            if (tool && preview) events.toolUpdate(block.id, safeLabel(tool, preview, false));
          } else if (block.type === "server_tool_use" && block.id) {
            const preview = previewInput(block.json);
            if (preview?.query) events.toolUpdate(block.id, `Searching the web for "${preview.query}"`);
            else if (preview?.url) events.toolUpdate(block.id, `Fetching ${preview.url}`);
          }
        }
      } else if (event.type === "content_block_stop") {
        const block = blocks.get(event.index);
        if (block?.type === "text" && inText) {
          events.textDone();
          inText = false;
        }
        if (block?.type === "server_tool_use" && block.id && block.name !== "advisor") {
          const record = serverToolRecord(block.id, block.name ?? "web_search", parseJson(block.json));
          this.session.append({ t: "tool", tool: record });
          events.toolEnd(record);
        }
      }
    }
    if (inText) events.textDone();
    events.thinking(null);
    return response.finalMessage();
  }

  private advisorLabel() {
    const advisor = advisorOf(this.options.settings.model);
    return advisor ? modelLabel(advisor) : "the advisor";
  }

  // The advice itself is encrypted, so the record says only that the call happened.
  private advisorRecord(id: string, startedAt = Date.now(), content?: { type?: string; error_code?: string }) {
    const failed = content?.type === "advisor_tool_result_error";
    const record: ToolRecord = {
      id,
      name: "advisor",
      input: {},
      label: `Asked ${this.advisorLabel()}`,
      kind: "advisor",
      output: "",
      isError: failed,
      startedAt,
      ms: Date.now() - startedAt,
      note: failed ? `couldn't answer: ${(content?.error_code ?? "error").replaceAll("_", " ")}` : undefined,
    };
    return record;
  }

  // Runs tool calls: consecutive read-only calls in parallel, everything else in order.
  private async runTools(uses: ToolUse[], prompt: string, signal: AbortSignal, tally: Tally): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(uses.length);
    let index = 0;
    while (index < uses.length) {
      const batch: number[] = [];
      while (index < uses.length && findTool(uses[index].name)?.readOnly && uses[index].name !== "ask_user_question")
        batch.push(index++);
      if (batch.length === 0) batch.push(index++);
      await Promise.all(
        batch.map(async (position) => (results[position] = await this.runTool(uses[position], prompt, signal, tally))),
      );
    }
    return results;
  }

  private async runTool(use: ToolUse, prompt: string, signal: AbortSignal, tally: Tally): Promise<ToolResult> {
    const { events, permissions, session } = this.options;
    const startedAt = Date.now();
    const clock = now();
    const tool = findTool(use.name);
    const input = use.input as Record<string, unknown>;
    const finish = (output: ToolOutput, label: string, kind: string, review?: string): ToolResult => {
      const full = output.full ?? (typeof output.content === "string" ? output.content : "");
      const record: ToolRecord = {
        id: use.id,
        name: use.name,
        input,
        label,
        kind,
        output: full,
        isError: output.isError === true,
        diff: output.diff,
        added: output.added,
        removed: output.removed,
        startedAt,
        ms: msSince(clock),
        review,
        // A failed call without its own note shows the error's first line.
        note:
          output.note ??
          (output.isError && !review ? full.trim().split("\n")[0].slice(0, ERROR_NOTE_CHARS) || undefined : undefined),
      };
      session.append({ t: "tool", tool: record });
      events.toolEnd(record);
      const content = typeof output.content === "string" ? clip(output.content, use.id) : output.content;
      return { type: "tool_result", tool_use_id: use.id, content, is_error: output.isError || undefined };
    };

    if (!tool) return finish({ content: `There is no tool named ${use.name}.`, isError: true }, use.name, "mcp");
    const invalid = tool.validate(input);
    const kind = tool.kind;
    if (invalid) {
      return finish(
        { content: JSON.stringify({ INVALID_INPUT: invalid, received: input }), isError: true },
        `${tool.name}: invalid input`,
        kind,
      );
    }
    const label = safeLabel(tool, input, false);
    events.toolUpdate(use.id, label);
    if (signal.aborted)
      return finish(
        { content: "Interrupted by the user before it ran.", isError: true },
        safeLabel(tool, input, true),
        kind,
      );

    const decision = permissions.decide(tool, input);
    let review: string | undefined;
    if (decision.action === "deny") {
      return finish(
        {
          content: `clue refused this action because of ${decision.reason}. Tell the user, and don't try to work around it.`,
          isError: true,
        },
        label,
        kind,
        "denied",
      );
    }
    // A flagged review asks the user, like an action that needs approval. Only an
    // interrupt or a non-interactive run keeps it held.
    let ask = decision.action === "ask";
    let note: string | undefined;
    if (decision.action === "review") {
      events.review(use.id, "reviewing");
      const verdict = await reviewAction(
        tool.name,
        input,
        prompt,
        this.options.settings.review,
        signal,
        reviewContext(session.transcript, prompt),
      );
      if (!verdict.approved) {
        events.review(use.id, "held", `${verdict.reviewer}: ${verdict.reason ?? "held"}`);
        if (!this.options.interactive || signal.aborted) {
          return finish(
            {
              content: `clue held this action: ${verdict.reviewer} reviewed it and ${verdict.reason ?? "did not approve it"}. Tell the user what you wanted to do and why.`,
              isError: true,
            },
            label,
            kind,
            `held by ${verdict.reviewer}`,
          );
        }
        ask = true;
        note = `not cleared by ${verdict.reviewer}${verdict.reason ? `: ${verdict.reason}` : ""}`;
      } else {
        events.review(use.id, "approved", verdict.reviewer);
        review = `approved by ${verdict.reviewer}`;
      }
    }
    if (ask) {
      if (!this.options.interactive) {
        return finish(
          {
            content:
              "This action needs the user's approval, and clue is running non-interactively. Report what you wanted to do instead.",
            isError: true,
          },
          label,
          kind,
          "needs approval",
        );
      }
      const answer = await events.confirm(
        approvalQuestion(tool, input),
        decision.subject,
        Permissions.grantPattern(tool, decision.subject),
        note,
      );
      if (answer === "no")
        return finish(
          { content: "The user declined this action. Ask how they want to proceed.", isError: true },
          label,
          kind,
          "declined",
        );
      if (answer === "always") permissions.grant(tool.name, Permissions.grantPattern(tool, decision.subject));
      review = answer === "always" ? "allowed always" : "allowed once";
    }

    const context: ToolContext = {
      cwd: this.options.cwd,
      session,
      signal,
      mcp: this.options.mcp,
      skills: this.options.skills,
      readStamps: this.readStamps,
      undo: this.undo,
      seenInstructions: this.seenInstructions,
      ask: (question) => events.question(question),
      progress: (note) => events.toolUpdate(use.id, label, note),
      subagent: (task, description, childSignal) => this.runSubagent(task, description, childSignal, use.id, tally),
      interactive: this.options.interactive,
    };
    let output: ToolOutput;
    try {
      output = await tool.run(input, context);
    } catch (error) {
      output = { content: `${tool.name} failed: ${(error as Error).message}`, isError: true };
    }
    return finish(output, safeLabel(tool, input, true), kind, review);
  }

  private async runSubagent(
    task: string,
    description: string,
    signal: AbortSignal,
    parentId: string,
    tally: Tally,
  ): Promise<ToolOutput> {
    const child = new Session(`${this.session.id}-sub`, this.options.cwd);
    child.ephemeral = true;
    let calls = 0;
    let text = "";
    const parent = this.options.events;
    const agent = new Agent({
      ...this.options,
      session: child,
      subagent: true,
      onFastOff: () => this.turnOffFast(),
      settings: { ...this.options.settings },
      events: {
        thinking: () => {},
        text: (delta) => (text += delta),
        textDone: () => (text += "\n"),
        toolStart: () => {},
        toolUpdate: () => {},
        toolEnd: () => parent.toolUpdate(parentId, `Subagent: ${description}`, `${++calls} tool calls`),
        review: () => {},
        confirm: (label, subject, pattern, note) => parent.confirm(`subagent: ${label}`, subject, pattern, note),
        question: async () => null,
        notice: () => {},
      },
    });
    agent.undo = this.undo;
    let turn: TurnRecord;
    try {
      turn = await agent.runTurn(task, signal);
    } finally {
      const spent = child.turns.at(-1);
      if (spent) tallyUp(tally, spent.usage, spent.cost);
    }
    const last = child.messages.at(-1);
    const finalText =
      last?.role === "assistant" && Array.isArray(last.content)
        ? last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
        : text;
    return {
      content: finalText.trim() || "The subagent finished without an answer.",
      note: `${calls} tool calls`,
      isError: turn.stop === "interrupted",
    };
  }
}

// The size of the context in a response. After a compaction, the last `message` entry has the new size.
export function contextTokens(usage: Anthropic.Beta.Messages.BetaUsage) {
  const last = usage.iterations?.findLast((entry) => entry.type === "message") ?? usage;
  return (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0);
}

// A server tool call with no result block yet. The next user message must then hold only tool results.
export function awaitsServerTool(content: ContentBlock[]) {
  const answered = new Set(content.flatMap((block) => ("tool_use_id" in block ? [block.tool_use_id] : [])));
  return content.some((block) => block.type === "server_tool_use" && !answered.has(block.id));
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text || "{}");
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

// Reads the fields that have arrived so far from a partial JSON object.
// A label needs fields near the start, such as a path or a command. Input can be a whole
// file, and it's read again on every streamed piece, so only this much is ever scanned.
export const PREVIEW_CHARS = 2048;

export function previewInput(input: string): Record<string, string> | null {
  const partial = input.slice(0, PREVIEW_CHARS);
  const fields: Record<string, string> = {};
  for (const match of partial.matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      fields[match[1]] = String(JSON.parse(`"${match[2]}"`));
    } catch {}
  }
  // A string still arriving, such as a long command.
  const open = partial.match(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*\\?)$/);
  if (open && !(open[1] in fields)) {
    try {
      fields[open[1]] = String(JSON.parse(`"${open[2].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")}"`));
    } catch {}
  }
  return Object.keys(fields).length ? fields : null;
}

function safeLabel(tool: NonNullable<ReturnType<typeof findTool>>, input: unknown, done: boolean) {
  try {
    return tool
      .label(input, done)
      .replace(/\s+undefined\b/g, "")
      .trim();
  } catch {
    return tool.name;
  }
}

function serverToolRecord(id: string, name: string, input: Record<string, unknown>): ToolRecord {
  const query = typeof input.query === "string" ? input.query : typeof input.url === "string" ? input.url : "";
  return {
    id,
    name,
    input,
    label: name === "web_fetch" ? `Fetched ${query}` : `Searched the web for "${query}"`,
    kind: "web",
    output: "",
    isError: false,
    startedAt: Date.now(),
    ms: 0,
  };
}

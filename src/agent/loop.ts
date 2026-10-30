import type Anthropic from "@anthropic-ai/sdk";
import type { Effort, Settings } from "../config";
import type { McpManager } from "../mcp/manager";
import { approvalQuestion, Permissions, reviewAction } from "../permissions";
import { Session, type PromptImage, type ToolRecord, type TurnRecord, type Usage } from "../session";
import { findTool } from "../tools";
import type { Skill } from "../tools/skills";
import { clip, toolKind, type Question, type ToolContext, type ToolOutput } from "../tools/types";
import { buildContext } from "./context";
import { msSince, now } from "../clock";
import { cost } from "./models";
import { dropRejectedFeature, stream } from "./provider";

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
  confirm(label: string, subject: string, pattern: string): Promise<ConfirmAnswer>;
  question(question: Question): Promise<string | null>;
  notice(text: string, tone?: "info" | "warn" | "error"): void;
};

export type AgentOptions = {
  cwd: string;
  session: Session;
  settings: Pick<Settings, "model" | "effort" | "review_model">;
  permissions: Permissions;
  mcp: McpManager;
  skills: () => Skill[];
  events: AgentEvents;
  interactive: boolean;
  subagent?: boolean;
};

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 });
const MAX_JSON_RETRIES = 2;
const MAX_FEATURE_RETRIES = 3;
const ERROR_NOTE_CHARS = 60;

export class Agent {
  readStamps = new Map<string, number>();
  seenInstructions = new Set<string>();

  constructor(private options: AgentOptions) {}

  get session() {
    return this.options.session;
  }

  setModel(model: string) {
    this.options.settings.model = model;
  }

  setEffort(effort: Effort) {
    this.options.settings.effort = effort;
  }

  // Runs one user prompt to completion: model turns and tool calls until Claude stops.
  async runTurn(prompt: string, signal: AbortSignal, images: PromptImage[] = []): Promise<TurnRecord> {
    const { session, events, settings } = this.options;
    const startedAt = Date.now();
    const clock = now();
    let firstTokenMs: number | null = null;
    const usage = emptyUsage();
    let toolCount = 0;
    let stop = "end_turn";
    let model = settings.model;

    session.closeUnfinishedTools();
    if (session.isEmpty) {
      const context = await buildContext(this.options.cwd, this.options.skills(), this.options.mcp.configuredNames(), this.seenInstructions);
      session.appendMessage({ role: "user", content: [{ type: "text", text: context }, { type: "text", text: prompt }, ...images] });
    } else {
      session.appendMessage({ role: "user", content: images.length ? [{ type: "text", text: prompt }, ...images] : prompt });
    }

    let jsonRetries = 0;
    let featureRetries = 0;

    while (true) {
      if (signal.aborted) {
        stop = "interrupted";
        break;
      }
      model = settings.model;
      let message: Anthropic.Beta.Messages.BetaMessage;
      try {
        message = await this.request(model, settings.effort, signal, () => {
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
        if (error instanceof Sdk.BadRequestError && featureRetries < MAX_FEATURE_RETRIES && dropRejectedFeature(error)) {
          featureRetries += 1;
          continue;
        }
        if (!(error instanceof Sdk.APIError) && error instanceof SyntaxError && jsonRetries < MAX_JSON_RETRIES) {
          jsonRetries += 1;
          events.notice("A tool input arrived as broken JSON. Asking again.", "warn");
          continue;
        }
        throw error;
      }

      addUsage(usage, message.usage);
      session.appendMessage({ role: "assistant", content: message.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
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
      const results = await this.runTools(toolUses, prompt, signal, usage);
      session.appendMessage({ role: "user", content: results });
      if (signal.aborted) {
        stop = "interrupted";
        break;
      }
    }

    const turn: TurnRecord = {
      prompt,
      startedAt,
      ms: msSince(clock),
      firstTokenMs,
      tools: toolCount,
      usage,
      cost: cost(model, usage),
      model,
      stop,
    };
    session.append({ t: "turn", turn });
    return turn;
  }

  // One streamed model request. Forwards text, progress notes and tool activity as they arrive.
  private async request(model: string, effort: Effort, signal: AbortSignal, onFirstToken: () => void) {
    const { events } = this.options;
    const response = await stream({ model, effort, messages: this.session.messages, subagent: this.options.subagent }, signal);
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
    let inText = false;
    events.thinking("");

    for await (const event of response) {
      if (event.type === "content_block_start") {
        const block = event.content_block as ContentBlock;
        blocks.set(event.index, { type: block.type, id: (block as { id?: string }).id, name: (block as { name?: string }).name, json: "" });
        if (block.type === "tool_use") {
          const tool = findTool(block.name);
          events.toolStart(block.id, tool ? safeLabel(tool, {}, false) : block.name, tool ? toolKind(tool, {}) : "mcp");
        } else if (block.type === "server_tool_use") {
          events.toolStart(block.id, block.name === "web_fetch" ? "Fetching" : "Searching the web", "web");
        } else if (block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
          events.toolUpdate(block.tool_use_id, "", "done");
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
        if (block?.type === "server_tool_use" && block.id) {
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

  // Runs tool calls: consecutive read-only calls in parallel, everything else in order.
  private async runTools(uses: ToolUse[], prompt: string, signal: AbortSignal, usage: Usage): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(uses.length);
    let index = 0;
    while (index < uses.length) {
      const batch: number[] = [];
      while (index < uses.length && findTool(uses[index].name)?.readOnly && uses[index].name !== "ask_user_question") batch.push(index++);
      if (batch.length === 0) batch.push(index++);
      await Promise.all(batch.map(async (position) => (results[position] = await this.runTool(uses[position], prompt, signal, usage))));
    }
    return results;
  }

  private async runTool(use: ToolUse, prompt: string, signal: AbortSignal, usage: Usage): Promise<ToolResult> {
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
        note: output.note ?? (output.isError && !review ? full.trim().split("\n")[0].slice(0, ERROR_NOTE_CHARS) || undefined : undefined),
      };
      session.append({ t: "tool", tool: record });
      events.toolEnd(record);
      const content = typeof output.content === "string" ? clip(output.content, use.id) : output.content;
      return { type: "tool_result", tool_use_id: use.id, content, is_error: output.isError || undefined };
    };

    if (!tool) return finish({ content: `There is no tool named ${use.name}.`, isError: true }, use.name, "mcp");
    const invalid = tool.validate(input);
    const kind = toolKind(tool, input);
    if (invalid) {
      return finish({ content: JSON.stringify({ INVALID_INPUT: invalid, received: input }), isError: true }, `${tool.name}: invalid input`, kind);
    }
    const label = safeLabel(tool, input, false);
    events.toolUpdate(use.id, label);
    if (signal.aborted) return finish({ content: "Interrupted by the user before it ran.", isError: true }, safeLabel(tool, input, true), kind);

    const decision = permissions.decide(tool, input);
    let review: string | undefined;
    if (decision.action === "deny") {
      return finish({ content: `clue refused this action because of ${decision.reason}. Tell the user, and don't try to work around it.`, isError: true }, label, kind, "denied");
    }
    if (decision.action === "ask") {
      if (!this.options.interactive) {
        return finish({ content: "This action needs the user's approval, and clue is running non-interactively. Report what you wanted to do instead.", isError: true }, label, kind, "needs approval");
      }
      const answer = await events.confirm(approvalQuestion(tool, input), decision.subject, Permissions.grantPattern(tool, decision.subject));
      if (answer === "no") return finish({ content: "The user declined this action. Ask how they want to proceed.", isError: true }, label, kind, "declined");
      if (answer === "always") permissions.grant(tool.name, Permissions.grantPattern(tool, decision.subject));
      review = answer === "always" ? "allowed always" : "allowed once";
    }
    if (decision.action === "review") {
      events.review(use.id, "reviewing");
      const verdict = await reviewAction(tool.name, input, prompt, this.options.settings.review_model, signal);
      if (!verdict.approved) {
        events.review(use.id, "held", `${verdict.reviewer}: ${verdict.reason ?? "held"}`);
        return finish(
          { content: `clue held this action: ${verdict.reviewer} reviewed it and ${verdict.reason ?? "did not approve it"}. Tell the user what you wanted to do and why.`, isError: true },
          label,
          kind,
          `held by ${verdict.reviewer}`,
        );
      }
      events.review(use.id, "approved", verdict.reviewer);
      review = `approved by ${verdict.reviewer}`;
    }

    const context: ToolContext = {
      cwd: this.options.cwd,
      session,
      signal,
      mcp: this.options.mcp,
      skills: this.options.skills,
      readStamps: this.readStamps,
      seenInstructions: this.seenInstructions,
      ask: (question) => events.question(question),
      progress: (note) => events.toolUpdate(use.id, label, note),
      subagent: (task, description, childSignal) => this.runSubagent(task, description, childSignal, use.id, usage),
      interactive: this.options.interactive,
    };
    let output: ToolOutput;
    try {
      output = await tool.run(input as never, context);
    } catch (error) {
      output = { content: `${tool.name} failed: ${(error as Error).message}`, isError: true };
    }
    return finish(output, safeLabel(tool, input, true), kind, review);
  }

  private async runSubagent(task: string, description: string, signal: AbortSignal, parentId: string, usage: Usage): Promise<ToolOutput> {
    const child = new Session(`${this.session.id}-sub`, this.options.cwd);
    child.ephemeral = true;
    let calls = 0;
    let text = "";
    const parent = this.options.events;
    const agent = new Agent({
      ...this.options,
      session: child,
      subagent: true,
      settings: { ...this.options.settings },
      events: {
        thinking: () => {},
        text: (delta) => (text += delta),
        textDone: () => (text += "\n"),
        toolStart: () => {},
        toolUpdate: () => {},
        toolEnd: () => parent.toolUpdate(parentId, `Subagent: ${description}`, `${++calls} tool calls`),
        review: () => {},
        confirm: (label, subject, pattern) => parent.confirm(`subagent: ${label}`, subject, pattern),
        question: async () => null,
        notice: () => {},
      },
    });
    const turn = await agent.runTurn(task, signal);
    for (const key of Object.keys(usage) as (keyof Usage)[]) usage[key] += turn.usage[key];
    const last = child.messages.at(-1);
    const finalText =
      last?.role === "assistant" && Array.isArray(last.content)
        ? last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
        : text;
    return { content: finalText.trim() || "The subagent finished without an answer.", note: `${calls} tool calls`, isError: turn.stop === "interrupted" };
  }
}

function addUsage(total: Usage, usage: Anthropic.Beta.Messages.BetaUsage) {
  total.input += usage.input_tokens ?? 0;
  total.output += usage.output_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.webSearches += usage.server_tool_use?.web_search_requests ?? 0;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

// Reads the fields that have arrived so far from a partial JSON object.
function previewInput(partial: string): Record<string, string> | null {
  const fields: Record<string, string> = {};
  for (const match of partial.matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      fields[match[1]] = JSON.parse(`"${match[2]}"`);
    } catch {}
  }
  // A string still arriving, such as a long command.
  const open = partial.match(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)$/);
  if (open && !(open[1] in fields)) {
    try {
      fields[open[1]] = JSON.parse(`"${open[2].replace(/\\$/, "")}"`);
    } catch {}
  }
  return Object.keys(fields).length ? fields : null;
}

function safeLabel(tool: NonNullable<ReturnType<typeof findTool>>, input: unknown, done: boolean) {
  try {
    return tool.label(input as never, done).replace(/\s+undefined\b/g, "").trim();
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

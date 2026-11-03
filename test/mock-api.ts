// A stand-in for the Anthropic Messages API, for tests without credentials.
// It streams a reply that calls read_file, then a final answer once the tool result arrives.

import { COMPACT_PROMPT } from "../src/agent/prompt";

type Body = {
  model?: string;
  messages: { role: string; content: unknown }[];
  max_tokens: number;
  stream?: boolean;
  output_config?: { effort?: string };
  speed?: string;
  betas?: string[];
  system?: unknown;
  tools?: unknown;
  thread?: { type: string; previous_message_id?: string };
};

// Every request, as a full conversation: one that continues a thread is rebuilt the way the API does.
export const requests: Body[] = [];

// The requests of a thread as they went over the wire, before they were rebuilt.
export const wire: Body[] = [];

// What the API holds for each thread reply: the conversation up to it, Claude's reply included.
const threads = new Map<string, { system: unknown; tools: unknown; messages: Body["messages"]; continued: boolean }>();
const THREADS_BETA = "message-threads-2026-08-12";

const failure = (status: number, type: string, message: string, code?: string) =>
  Response.json(
    { type: "error", error: { type, message, ...(code && { details: { error_code: code } }) } },
    { status },
  );

// Checks a thread request the way the API does, and rebuilds a continue into the full conversation.
function threadRequest(body: Body) {
  const thread = body.thread;
  if (!thread) return null;
  wire.push({ ...body });
  if (!body.betas?.includes(THREADS_BETA)) return failure(400, "invalid_request_error", "thread needs its beta header");
  if (thread.type !== "continue") return null;
  if (body.system !== undefined || body.tools !== undefined)
    return failure(400, "invalid_request_error", "a continue request can't send system or tools");
  const held = threads.get(thread.previous_message_id ?? "");
  if (!held) return failure(404, "not_found_error", "thread not found", "thread_not_found");
  if (held.continued) return failure(400, "invalid_request_error", "already continued", "thread_already_continued");
  body.system = held.system;
  body.tools = held.tools;
  body.messages = [...held.messages, ...body.messages];
  return null;
}

// Claude's reply, rebuilt from its stream events.
function replyOf(events: Record<string, unknown>[]) {
  const blocks: any[] = [];
  const json = new Map<number, string>();
  for (const event of events as any[]) {
    if (event.type === "content_block_start") blocks[event.index] = structuredClone(event.content_block);
    else if (event.type === "content_block_delta") {
      const block = blocks[event.index];
      const delta = event.delta;
      if (delta.type === "text_delta") block.text += delta.text;
      else if (delta.type === "thinking_delta") block.thinking += delta.thinking;
      else if (delta.type === "signature_delta") block.signature = delta.signature;
      else if (delta.type === "input_json_delta")
        json.set(event.index, (json.get(event.index) ?? "") + delta.partial_json);
    } else if (event.type === "content_block_stop" && json.has(event.index))
      blocks[event.index].input = JSON.parse(json.get(event.index) || "{}");
  }
  return blocks.filter(Boolean);
}

// The request being answered. Set before any await, so the reply is stored with the right request.
let current: Body | null = null;

// Fast requests whose first message holds this text get a 400. An empty string matches every fast request.
export const fastMode = { rejectedFor: null as string | null, rejectedFromRequest: Infinity };

// How the reviewers answer. Tests change this to force each failure.
export const reviewers = {
  // Claude models that answer with an error.
  failing: new Set<string>(),
  // What a Claude reviewer decides.
  decision: "clear",
  // What Jev decides. "error" answers 500, and anything else is sent as the choice.
  jev: "clear",
  claudeCalls: [] as { model: string; effort?: string }[],
  jevCalls: [] as { model: string }[],
  // The state each reviewer was sent, parsed, in call order.
  states: [] as Record<string, unknown>[],
};

export const resetReviewers = () => {
  reviewers.failing.clear();
  reviewers.decision = reviewers.jev = "clear";
  reviewers.claudeCalls.length = reviewers.jevCalls.length = reviewers.states.length = 0;
};

// MOCK_DELAY_MS spaces the events out, so tests can watch the live view.
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 0);

function sse(events: Record<string, unknown>[], delay: number) {
  const start = events.find((event) => event.type === "message_start") as { message: { id: string } } | undefined;
  // A reply that was served uses up the id it continued. A request the API rejects doesn't.
  if (current?.thread?.type === "continue") threads.get(current.thread.previous_message_id ?? "")!.continued = true;
  if (current?.thread && start)
    threads.set(start.message.id, {
      system: current.system,
      tools: current.tools,
      messages: [...current.messages, { role: "assistant", content: replyOf(events) }],
      continued: false,
    });
  const encode = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (!delay) return new Response(events.map(encode).join(""), { headers: { "content-type": "text/event-stream" } });
  const stream = new ReadableStream({
    async start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(encode(event)));
        await Bun.sleep(delay);
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

export const usage = {
  input_tokens: 120,
  output_tokens: 40,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 300,
};

function message(content: unknown[], stop: string) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage,
  };
}

function streamText(text: string, index: number) {
  const chunks = text.match(/[\s\S]{1,12}/g) ?? [];
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    ...chunks.map((chunk) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } })),
    { type: "content_block_stop", index },
  ];
}

// Requests for a summary, which clue sends to compact a conversation, and how they stop.
export const compactions: Body[] = [];
export const compactionStop = { value: "end_turn" };

const textOf = (message: { content: unknown } | undefined) =>
  Array.isArray(message?.content) ? (message.content as { type: string; text?: string }[]) : [];

export function startMockApi(port = 0, delay = DELAY) {
  return Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/alpha/decisions")) {
        const { model, state } = (await request.json()) as { model: string; state: string };
        reviewers.jevCalls.push({ model });
        reviewers.states.push(JSON.parse(state));
        if (reviewers.jev === "error") return Response.json({ error: { message: "limit reached" } }, { status: 500 });
        return Response.json({ answers: { decision: { choice: reviewers.jev } } });
      }
      if (url.pathname.includes("/v1/models/"))
        return Response.json({
          id: url.pathname.split("/").at(-1),
          type: "model",
          display_name: "mock",
          created_at: "2026-01-01T00:00:00Z",
        });
      if (!url.pathname.endsWith("/v1/messages")) return new Response("not found", { status: 404 });
      const body = (await request.json()) as Body;
      // A review is the one request that doesn't stream and asks for a reply.
      if (!body.stream && body.max_tokens !== 0) {
        reviewers.claudeCalls.push({ model: body.model!, effort: body.output_config?.effort });
        const sent = (body.messages as { content?: unknown }[] | undefined)?.[0]?.content;
        if (typeof sent === "string") reviewers.states.push(JSON.parse(sent));
        if (reviewers.failing.has(body.model!))
          return Response.json(
            { type: "error", error: { type: "invalid_request_error", message: "reviewer is down" } },
            { status: 400 },
          );
        return Response.json(
          message(
            [{ type: "text", text: JSON.stringify({ decision: reviewers.decision, reason: "the reviewer's reason" }) }],
            "end_turn",
          ),
        );
      }
      // The SDK sends betas as a header.
      body.betas = request.headers.get("anthropic-beta")?.split(",") ?? [];
      const rejected = threadRequest(body);
      if (rejected) return rejected;
      current = body;
      const lastMessage = body.messages.at(-1);
      if (lastMessage?.role === "user" && textOf(lastMessage).some((block) => block.text === COMPACT_PROMPT)) {
        compactions.push(body);
        return sse(
          [
            { type: "message_start", message: message([], "") },
            ...streamText("Summary of the conversation.", 0),
            {
              type: "message_delta",
              delta: { stop_reason: compactionStop.value, stop_sequence: null },
              usage: { output_tokens: 700 },
            },
            { type: "message_stop" },
          ],
          delay,
        );
      }
      requests.push(body);
      if (
        body.speed === "fast" &&
        (requests.length >= fastMode.rejectedFromRequest ||
          (fastMode.rejectedFor !== null && JSON.stringify(body.messages[0]).includes(fastMode.rejectedFor)))
      )
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "speed: fast mode isn't enabled" } },
          { status: 400 },
        );
      const last = body.messages.at(-1);
      const hasToolResult =
        Array.isArray(last?.content) &&
        (last.content as { type: string }[]).some((block) => block.type === "tool_result");
      if (body.max_tokens === 0) {
        return Response.json(message([], "max_tokens"));
      }
      const promptText = JSON.stringify(body.messages.filter((item) => item.role === "user").at(-1)?.content ?? "");
      // An advisor call: the executor asks, the advice arrives whole, and usage then reports the
      // advisor's tokens in iterations. "stall" stops the stream during the advisor's pause.
      if (promptText.includes("consult the advisor")) {
        const asked = [
          { type: "message_start", message: message([], "") },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "server_tool_use", id: "srvtoolu_advice", name: "advisor", input: {} },
          },
          { type: "content_block_stop", index: 0 },
        ];
        if (promptText.includes("stall")) {
          const encode = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          const open = new ReadableStream({
            start(controller) {
              for (const event of asked) controller.enqueue(new TextEncoder().encode(encode(event)));
            },
          });
          return new Response(open, { headers: { "content-type": "text/event-stream" } });
        }
        return sse(
          [
            ...asked,
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "advisor_tool_result",
                tool_use_id: "srvtoolu_advice",
                content: { type: "advisor_redacted_result", encrypted_content: "sealed" },
              },
            },
            { type: "content_block_stop", index: 1 },
            ...streamText("Done, with advice.", 2),
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: {
                ...usage,
                iterations: [
                  { type: "message", model: null, ...usage, output_tokens: 10 },
                  {
                    type: "advisor_message",
                    model: "claude-opus-5-5",
                    input_tokens: 1000,
                    output_tokens: 500,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                  },
                  {
                    type: "message",
                    model: null,
                    input_tokens: 0,
                    output_tokens: 30,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                  },
                ],
              },
            },
            { type: "message_stop" },
          ],
          delay,
        );
      }
      // After a compaction that kept nothing, Claude goes on from the summary with a final answer.
      const fromSummary = lastMessage?.role === "user" && textOf(lastMessage)[0]?.text?.startsWith("<summary>");
      if (!hasToolResult && !fromSummary) {
        const wantsPush = promptText.includes("push");
        const wantsWrite = promptText.includes("create the note");
        const wantsSubagent = promptText.includes("delegate this");
        const input = JSON.stringify(
          wantsPush
            ? { command: promptText.includes("push slowly") ? "sleep 26.5" : "deploy-preview --dry-run" }
            : wantsWrite
              ? { path: "note.txt", content: "from clue" }
              : wantsSubagent
                ? {
                    task: "the child task",
                    description: "look around",
                    ...(promptText.includes("on haiku") ? { model: "haiku" } : {}),
                  }
                : { path: "package.json" },
        );
        const toolName = wantsPush ? "shell" : wantsWrite ? "write_file" : wantsSubagent ? "subagent" : "read_file";
        return sse(
          [
            { type: "message_start", message: message([], "") },
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "Checking the package file." },
            },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
            { type: "content_block_stop", index: 0 },
            ...streamText("I'll read the package file first.", 1),
            {
              type: "content_block_start",
              index: 2,
              content_block: { type: "tool_use", id: `toolu_${requests.length}`, name: toolName, input: {} },
            },
            {
              type: "content_block_delta",
              index: 2,
              delta: { type: "input_json_delta", partial_json: input.slice(0, 8) },
            },
            {
              type: "content_block_delta",
              index: 2,
              delta: { type: "input_json_delta", partial_json: input.slice(8) },
            },
            { type: "content_block_stop", index: 2 },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: 40 },
            },
            { type: "message_stop" },
          ],
          delay,
        );
      }
      const firstPrompt = JSON.stringify(body.messages[0]);
      if (firstPrompt.includes("fail midway"))
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "bad request" } },
          { status: 400 },
        );
      const answer =
        "## Done\n\nThe package is called **clue**. It uses:\n\n- `@anthropic-ai/sdk`\n- `@modelcontextprotocol/sdk`\n\n| Field | Value |\n|---|---|\n| name | clue |\n| version | 0.1.0 |\n";
      return sse(
        [
          { type: "message_start", message: message([], "") },
          ...streamText(answer, 0),
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 60 },
          },
          { type: "message_stop" },
        ],
        delay,
      );
    },
  });
}

if (import.meta.main) {
  const server = startMockApi(Number(process.env.PORT ?? 7777));
  console.log(`mock api on ${server.url}`);
}

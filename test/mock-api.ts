// A stand-in for the Anthropic Messages API, for tests without credentials.
// It streams a reply that calls read_file, then a final answer once the tool result arrives.

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
  thread?: { type: "create" } | { type: "continue"; previous_message_id: string };
};

export const requests: Body[] = [];

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

// Message threads. `requests` logs each request as the API rebuilds it, with the whole conversation.
// `threads.sent` logs them as clue sent them.
export const threads = {
  // What each response's thread holds, by response id. A response can be continued once.
  held: new Map<string, { messages: Body["messages"]; system?: unknown; tools?: unknown }>(),
  sent: [] as Body[],
  // An `unsupported` value: every thread request gets thread_unsupported_request with it.
  unsupported: null as string | null,
};

const apiError = (status: number, type: string, message: string, details?: Record<string, unknown>) =>
  Response.json({ type: "error", error: { type, message, ...(details ? { details } : {}) } }, { status });

// Rebuilds a thread request's conversation the way the API does. Returns the request in full, or
// the error the API would send.
function rebuildThread(body: Body): Body | Response {
  const thread = body.thread!;
  threads.sent.push(structuredClone(body));
  if (!body.betas?.includes("message-threads-2026-08-12"))
    return apiError(400, "invalid_request_error", "thread requires anthropic-beta: message-threads-2026-08-12");
  if (threads.unsupported)
    return apiError(400, "invalid_request_error", `thread: ${threads.unsupported} isn't supported`, {
      error_code: "thread_unsupported_request",
      unsupported: [threads.unsupported],
    });
  if (thread.type === "create") return body;
  if (body.system !== undefined || body.tools !== undefined)
    return apiError(400, "invalid_request_error", "thread: system and tools can't be sent on a continue request");
  const held = threads.held.get(thread.previous_message_id);
  if (!held) return apiError(404, "not_found_error", "thread not found", { error_code: "thread_not_found" });
  threads.held.delete(thread.previous_message_id);
  return { ...body, system: held.system, tools: held.tools, messages: [...held.messages, ...body.messages] };
}

// Passes a streamed reply through, and keeps the thread's conversation once it reaches message_stop.
function keepThread(response: Response, body: Body) {
  if (!response.body || !response.headers.get("content-type")?.includes("event-stream")) return response;
  let text = "";
  const decoder = new TextDecoder();
  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      text += decoder.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
    flush() {
      const events = text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      if (!events.some((event) => event.type === "message_stop")) return;
      const content: Record<string, unknown>[] = [];
      let id = "";
      for (const event of events) {
        if (event.type === "message_start") id = event.message.id;
        if (event.type === "content_block_start") content[event.index] = { ...event.content_block };
        if (event.type === "content_block_delta") {
          const block = content[event.index];
          if (event.delta.type === "text_delta") block.text = `${block.text ?? ""}${event.delta.text}`;
          if (event.delta.type === "thinking_delta") block.thinking = `${block.thinking ?? ""}${event.delta.thinking}`;
          if (event.delta.type === "signature_delta") block.signature = event.delta.signature;
          if (event.delta.type === "input_json_delta") block.json = `${block.json ?? ""}${event.delta.partial_json}`;
        }
      }
      for (const block of content) {
        if (typeof block.json === "string") block.input = JSON.parse(block.json || "{}");
        delete block.json;
      }
      threads.held.set(id, {
        messages: [...body.messages, { role: "assistant", content }],
        system: body.system,
        tools: body.tools,
      });
    },
  });
  return new Response(response.body.pipeThrough(tee), { status: response.status, headers: response.headers });
}

export const compactions: unknown[] = [];
export const compactionStop = { value: "compaction" };

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
      let body = (await request.json()) as Body;
      // The SDK sends betas as a header.
      body.betas = request.headers.get("anthropic-beta")?.split(",") ?? [];
      if (body.thread) {
        const rebuilt = rebuildThread(body);
        if (rebuilt instanceof Response) return rebuilt;
        body = rebuilt;
        return keepThread(await answer(body), body);
      }
      return answer(body);
    },
  });

  async function answer(body: Body): Promise<Response> {
    {
      if ((body as { compaction?: unknown }).compaction) {
        compactions.push(body);
        return sse(
          [
            { type: "message_start", message: message([], "") },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "compaction", content: "Summary of the conversation.", signature: "sig" },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: compactionStop.value, stop_sequence: null },
              usage: {
                output_tokens: 0,
                iterations: [{ type: "compaction", input_tokens: 5000, output_tokens: 700 }],
              },
            },
            { type: "message_stop" },
          ],
          delay,
        );
      }
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
      if (!hasToolResult && !JSON.stringify(body.messages).includes("Continue with the task.")) {
        const wantsPush = promptText.includes("push");
        const wantsWrite = promptText.includes("create the note");
        const wantsSubagent = promptText.includes("delegate this");
        const input = JSON.stringify(
          wantsPush
            ? { command: promptText.includes("push slowly") ? "sleep 26.5" : "deploy-preview --dry-run" }
            : wantsWrite
              ? { path: "note.txt", content: "from clue" }
              : wantsSubagent
                ? { task: "the child task", description: "look around" }
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
            usage: {
              output_tokens: 60,
              ...(firstPrompt.includes("compact on the server")
                ? { iterations: [{ type: "compaction", input_tokens: 5000, output_tokens: 700 }] }
                : {}),
            },
          },
          { type: "message_stop" },
        ],
        delay,
      );
    }
  }
}

if (import.meta.main) {
  const server = startMockApi(Number(process.env.PORT ?? 7777));
  console.log(`mock api on ${server.url}`);
}

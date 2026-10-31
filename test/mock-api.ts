// A stand-in for the Anthropic Messages API, for tests without credentials.
// It streams a reply that calls read_file, then a final answer once the tool result arrives.

type Body = { model?: string; messages: { role: string; content: unknown }[]; max_tokens: number; stream?: boolean; output_config?: { effort?: string } };

export const requests: Body[] = [];

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
};

export const resetReviewers = () => {
  reviewers.failing.clear();
  reviewers.decision = reviewers.jev = "clear";
  reviewers.claudeCalls.length = reviewers.jevCalls.length = 0;
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

const usage = { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 };

function message(content: unknown[], stop: string) {
  return { id: `msg_${Math.random().toString(36).slice(2)}`, type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stop, stop_sequence: null, usage };
}

function streamText(text: string, index: number) {
  const chunks = text.match(/[\s\S]{1,12}/g) ?? [];
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    ...chunks.map((chunk) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } })),
    { type: "content_block_stop", index },
  ];
}

export function startMockApi(port = 0, delay = DELAY) {
  return Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/alpha/decisions")) {
        const { model } = (await request.json()) as { model: string };
        reviewers.jevCalls.push({ model });
        if (reviewers.jev === "error") return Response.json({ error: { message: "limit reached" } }, { status: 500 });
        return Response.json({ answers: { decision: { choice: reviewers.jev } } });
      }
      if (url.pathname.includes("/v1/models/")) return Response.json({ id: url.pathname.split("/").at(-1), type: "model", display_name: "mock", created_at: "2026-01-01T00:00:00Z" });
      if (!url.pathname.endsWith("/v1/messages")) return new Response("not found", { status: 404 });
      const body = (await request.json()) as Body;
      // A review is the one request that doesn't stream and asks for a reply.
      if (!body.stream && body.max_tokens !== 0) {
        reviewers.claudeCalls.push({ model: body.model!, effort: body.output_config?.effort });
        if (reviewers.failing.has(body.model!)) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "reviewer is down" } }, { status: 400 });
        return Response.json(message([{ type: "text", text: JSON.stringify({ decision: reviewers.decision, reason: "the reviewer's reason" }) }], "end_turn"));
      }
      requests.push(body);
      const last = body.messages.at(-1);
      const hasToolResult = Array.isArray(last?.content) && (last.content as { type: string }[]).some((block) => block.type === "tool_result");
      if (body.max_tokens === 0) {
        return Response.json(message([], "max_tokens"));
      }
      const promptText = JSON.stringify(body.messages.filter((item) => item.role === "user").at(-1)?.content ?? "");
      if (!hasToolResult) {
        const wantsPush = promptText.includes("push");
        const input = JSON.stringify(wantsPush ? { command: "deploy-preview --dry-run" } : { path: "package.json" });
        const toolName = wantsPush ? "shell" : "read_file";
        return sse([
          { type: "message_start", message: message([], "") },
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking the package file." } },
          { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
          { type: "content_block_stop", index: 0 },
          ...streamText("I'll read the package file first.", 1),
          { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: `toolu_${requests.length}`, name: toolName, input: {} } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: input.slice(0, 8) } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: input.slice(8) } },
          { type: "content_block_stop", index: 2 },
          { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } },
          { type: "message_stop" },
        ], delay);
      }
      const answer = "## Done\n\nThe package is called **clue**. It uses:\n\n- `@anthropic-ai/sdk`\n- `@modelcontextprotocol/sdk`\n\n| Field | Value |\n|---|---|\n| name | clue |\n| version | 0.1.0 |\n";
      return sse([
        { type: "message_start", message: message([], "") },
        ...streamText(answer, 0),
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 60 } },
        { type: "message_stop" },
      ], delay);
    },
  });
}

if (import.meta.main) {
  const server = startMockApi(Number(process.env.PORT ?? 7777));
  console.log(`mock api on ${server.url}`);
}

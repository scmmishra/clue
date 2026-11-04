// The session the start and resume benchmarks open.
import type { Session as SessionClass } from "../src/session";

// A long session to resume: `turns` prompts, each with text and two tool calls.
// Session comes in as an argument because the caller imports it after setting CLUE_HOME.
export function seedSession(Session: typeof SessionClass, project: string, turns: number) {
  const session = Session.create(project);
  for (let index = 0; index < turns; index++) {
    session.appendMessage({ role: "user", content: `Change number ${index}: update the handler and run the tests` });
    session.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: `I'll update the handler for change ${index}.` },
        { type: "tool_use", id: `toolu_${index}_a`, name: "read_file", input: { path: "src/handler.ts" } },
        { type: "tool_use", id: `toolu_${index}_b`, name: "shell", input: { command: "bun test" } },
      ],
    });
    for (const [suffix, kind, label] of [
      ["a", "read", "Read src/handler.ts"],
      ["b", "command", "Ran bun test"],
    ] as const) {
      session.append({
        t: "tool",
        tool: {
          id: `toolu_${index}_${suffix}`,
          name: kind === "read" ? "read_file" : "shell",
          input: {},
          label,
          kind,
          output: "x".repeat(2000),
          isError: false,
          startedAt: Date.now(),
          ms: 120,
        },
      });
    }
    session.appendMessage({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `toolu_${index}_a`, content: "export function handler() {}\n".repeat(40) },
        { type: "tool_result", tool_use_id: `toolu_${index}_b`, content: "12 pass\n0 fail" },
      ],
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `## Done\n\nUpdated the handler. **12 tests pass.**\n\n- one\n- two\n` }],
    });
    session.append({
      t: "turn",
      turn: {
        prompt: `Change number ${index}`,
        startedAt: Date.now(),
        ms: 9000,
        firstTokenMs: 800,
        tools: 2,
        usage: { input: 100, output: 300, cacheRead: 40000, cacheWrite: 900, webSearches: 0 },
        cost: 0.02,
        model: "claude-opus-5-5",
        stop: "end_turn",
      },
    });
  }
  return session;
}

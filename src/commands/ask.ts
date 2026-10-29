import { prefetchGitStatus } from "../agent/context";
import { Agent, type AgentEvents } from "../agent/loop";
import { getClient } from "../agent/provider";
import type { Settings } from "../config";
import { McpManager } from "../mcp/manager";
import { Permissions } from "../permissions";
import type { Session } from "../session";
import { stopAllProcesses } from "../tools/shell";
import { discoverSkills } from "../tools/skills";
import { describeError } from "../errors";

// One request without the interactive shell. The answer goes to stdout;
// progress and diagnostics go to stderr. Exits nonzero when the request fails.
export async function runAsk(prompt: string, settings: Settings, session: Session, json: boolean) {
  // Overlap the two slow startup steps: git status, and loading the SDK and credentials.
  if (session.isEmpty) prefetchGitStatus(session.cwd);
  void getClient().catch(() => {});
  const mcp = new McpManager(session.cwd);
  mcp.startAll();
  const progress = (text: string) => {
    if (process.stderr.isTTY || process.env.CLUE_PROGRESS) process.stderr.write(`${text}\n`);
  };
  let answer = "";
  let current = "";
  const events: AgentEvents = {
    thinking: () => {},
    text: (delta) => (current += delta),
    textDone: () => {
      answer = current;
    },
    toolStart: () => {
      current = "";
    },
    toolUpdate: () => {},
    toolEnd: (record) => progress(`${record.isError ? "✗" : "✓"} ${record.label}${record.note ? `  ${record.note}` : ""}`),
    review: () => {},
    confirm: async () => "no",
    question: async () => null,
    notice: (text) => progress(text),
  };
  const agent = new Agent({
    cwd: session.cwd,
    session,
    settings: { model: settings.model, effort: settings.effort, review_model: settings.review_model },
    permissions: new Permissions(settings.permission_mode, settings.permission, session.cwd),
    mcp,
    skills: () => discoverSkills(session.cwd),
    events,
    interactive: false,
  });
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  let code = 0;
  try {
    const turn = await agent.runTurn(prompt, controller.signal);
    const final = (answer || current).trim();
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ final_output: final, session_id: session.id, stop_reason: turn.stop, tools: turn.tools, duration_ms: turn.ms, first_token_ms: turn.firstTokenMs, usage: turn.usage, cost_usd: turn.cost })}\n`,
      );
    } else process.stdout.write(`${final}\n`);
    if (turn.stop === "interrupted" || turn.stop === "refusal") code = 1;
  } catch (error) {
    const message = describeError(error);
    if (json) process.stdout.write(`${JSON.stringify({ error: message, session_id: session.id })}\n`);
    else process.stderr.write(`clue: ${message}\n`);
    code = 1;
  }
  stopAllProcesses();
  await mcp.closeAll();
  process.exit(code);
}

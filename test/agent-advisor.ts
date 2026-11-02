// Runs one sonnet+opus turn against the mock API, in its own process, and prints the turn and
// its tool rows. With "interrupt", it stops the turn once the advisor call starts.
import { Agent } from "../src/agent/loop";
import { Permissions } from "../src/permissions";
import { Session } from "../src/session";

const [cwd, prompt, mode] = Bun.argv.slice(2);
const session = Session.create(cwd!);
const controller = new AbortController();
const rows: unknown[] = [];
const agent = new Agent({
  cwd: cwd!,
  session,
  settings: { model: "claude-sonnet-5-5+opus-5-5", effort: "medium", fast: false },
  permissions: new Permissions("full-access", {}, cwd!),
  mcp: { configuredNames: () => [] } as never,
  skills: () => [],
  events: {
    thinking() {},
    text() {},
    textDone() {},
    toolStart(_id, label, kind) {
      if (kind === "advisor" && mode === "interrupt") setTimeout(() => controller.abort(), 20);
    },
    toolUpdate() {},
    toolEnd(record) {
      rows.push({ label: record.label, kind: record.kind, isError: record.isError });
    },
    review() {},
    confirm: async () => "no",
    question: async () => null,
    notice() {},
  },
  interactive: false,
});
const turn = await agent.runTurn(prompt!, controller.signal);
console.log(JSON.stringify({ turn, rows }));
process.exit(0);

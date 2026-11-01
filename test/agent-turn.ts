// Runs one turn on a saved session, in its own process. The API client is cached per process,
// so a test that starts its own mock server can't share one with the other test files.
import { Agent } from "../src/agent/loop";
import { Permissions } from "../src/permissions";
import { Session } from "../src/session";

const [file, prompt] = Bun.argv.slice(2);
const session = Session.load(file!)!;
const agent = new Agent({
  cwd: session.cwd,
  session,
  settings: { model: "claude-opus-5-5", effort: "medium", fast: false },
  permissions: new Permissions("full-access", {}, session.cwd),
  mcp: { configuredNames: () => [] } as never,
  skills: () => [],
  events: {
    thinking() {},
    text() {},
    textDone() {},
    toolStart() {},
    toolUpdate() {},
    toolEnd() {},
    review() {},
    confirm: async () => "no",
    question: async () => null,
    notice() {},
  },
  interactive: false,
});
const turn = await agent.runTurn(prompt!, new AbortController().signal);
const point = session.rewindPoints.find((candidate) => candidate.text === prompt)!;
console.log(
  JSON.stringify({
    transcript: turn.transcript,
    point: point.transcript,
    files: agent.undo.summary(point.transcript).files,
  }),
);
process.exit(0);

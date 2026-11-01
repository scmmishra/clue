import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutProviderKeys } from "../src/config";

const shellModule = join(import.meta.dir, "../src/tools/shell.ts");
const SCRIPT = `
const { shell, stopAllProcesses } = await import(${JSON.stringify(shellModule)});
const context = { cwd: process.cwd(), signal: new AbortController().signal, undo: { noteShell() {} }, progress() {} };
const result = await shell.run({ command: process.env.TEST_COMMAND }, context);
console.log(result.content);
stopAllProcesses();
process.exit(0);
`;

function setup(shell: string, startup: Record<string, string>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clue-shell-")));
  const clue = join(home, ".clue");
  mkdirSync(clue);
  for (const [name, text] of Object.entries(startup)) writeFileSync(join(home, name), text);
  const run = async (command: string, env: Record<string, string> = {}) => {
    const proc = Bun.spawn(["bun", "-e", SCRIPT], {
      cwd: home,
      env: { ...process.env, HOME: home, SHELL: shell, CLUE_HOME: clue, TEST_COMMAND: command, ZDOTDIR: home, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  };
  return { home, clue, run };
}

// Linux CI machines don't have zsh.
const hasZsh = existsSync("/bin/zsh");
const zshTest = test.skipIf(!hasZsh);
const shells: [string, string][] = [
  ["/bin/bash", ".bash_profile"],
  ...(hasZsh ? ([["/bin/zsh", ".zshrc"]] as [string, string][]) : []),
];

test.each(shells)(
  "%s commands can use aliases and functions from %s",
  async (shell, file) => {
    const { run } = setup(shell, {
      [file]:
        "alias hello='echo from-alias'\ngreet() { echo \"from-function $1\"; }\n_private() { echo hidden; }\nexport FROM_RC=yes\n",
    });
    const output = await run("hello; greet there; echo $FROM_RC");
    expect(output).toContain("from-alias");
    expect(output).toContain("from-function there");
    expect(output).toContain("yes");
  },
  20_000,
);

test.each(shells)(
  "%s keeps standard programs when an alias or function shadows them",
  async (shell, file) => {
    const { run } = setup(shell, {
      [file]: "alias ls='echo shadowed-alias'\nsort() { echo shadowed-function; }\nalias mine='echo my-shortcut'\n",
    });
    const output = await run("ls /; printf 'b\\na\\n' | sort; mine");
    expect(output).not.toContain("shadowed");
    expect(output).toContain("my-shortcut");
  },
  20_000,
);

test.each(shells)(
  "%s keeps quotes, multi-line commands and exit codes",
  async (shell, file) => {
    const { run } = setup(shell, { [file]: "alias hello='echo hi'\n" });
    const output = await run("echo 'it'\"'\"'s'\nprintf '%s\\n' \"a b\"\nexit 3");
    expect(output).toContain("it's");
    expect(output).toContain("a b");
    expect(output).toContain("[Exit code 3]");
  },
  20_000,
);

zshTest(
  "completion functions stay out of the snapshot",
  async () => {
    const { clue, run } = setup("/bin/zsh", { ".zshrc": "_private() { echo hidden; }\nvisible() { echo shown; }\n" });
    await run("true");
    const snapshot = readFileSync(join(clue, "shell-snapshot.sh"), "utf8");
    expect(snapshot).toContain("visible");
    expect(snapshot).not.toContain("_private");
    expect(statSync(join(clue, "shell-snapshot.sh")).mode & 0o777).toBe(0o600);
  },
  20_000,
);

zshTest(
  "the startup files run once, until one changes",
  async () => {
    const { home, run } = setup("/bin/zsh", { ".zshrc": 'echo run >> "$HOME/runs"\nalias hello="echo one"\n' });
    const runs = () => readFileSync(join(home, "runs"), "utf8").trim().split("\n").length;
    await run("hello");
    const first = runs();
    await run("hello");
    expect(runs()).toBe(first);
    writeFileSync(join(home, ".zshrc"), 'echo run >> "$HOME/runs"\nalias hello="echo two-now"\n');
    expect(await run("hello")).toContain("two-now");
    expect(runs()).toBeGreaterThan(first);
  },
  30_000,
);

zshTest(
  "a change to a startup file in ZDOTDIR refreshes the cache",
  async () => {
    const { home, run } = setup("/bin/zsh", {});
    const dot = join(home, "dot");
    mkdirSync(dot);
    writeFileSync(join(dot, ".zshrc"), "alias hello='echo first'\n");
    expect(await run("hello", { ZDOTDIR: dot })).toContain("first");
    writeFileSync(join(dot, ".zshrc"), "alias hello='echo second-version'\n");
    expect(await run("hello", { ZDOTDIR: dot })).toContain("second-version");
  },
  30_000,
);

zshTest(
  "a missing snapshot captures again",
  async () => {
    const { clue, run } = setup("/bin/zsh", { ".zshrc": "alias hello='echo back'\n" });
    await run("hello");
    rmSnapshot(clue);
    expect(await run("hello")).toContain("back");
    expect(existsSync(join(clue, "shell-snapshot.sh"))).toBe(true);
  },
  20_000,
);

const rmSnapshot = (clue: string) => Bun.spawnSync(["rm", join(clue, "shell-snapshot.sh")]);

test("a shell with no support runs commands as before", async () => {
  const { clue, run } = setup("/bin/sh", {});
  expect(await run("echo plain")).toContain("plain");
  expect(existsSync(join(clue, "shell-snapshot.sh"))).toBe(false);
}, 20_000);

test.each(shells)(
  "%s commands get the environment of this launch, not the one that filled the cache",
  async (shell, file) => {
    const { run } = setup(shell, { [file]: "export FROM_RC=yes\n" });
    await run("true", { CLUE_TEST_PROFILE: "prod" });
    expect(await run('echo "profile=[$CLUE_TEST_PROFILE] rc=[$FROM_RC]"', { CLUE_TEST_PROFILE: "dev" })).toContain(
      "profile=[dev] rc=[yes]",
    );
    expect(await run('echo "profile=[$CLUE_TEST_PROFILE]"')).toContain("profile=[]");
  },
  30_000,
);

test.each(shells)(
  "%s keeps this launch's PATH first and adds what the startup files put on it",
  async (shell, file) => {
    const { run } = setup(shell, { [file]: "export PATH=/from/rc:$PATH\n" });
    await run("true");
    const output = await run('echo "path=$PATH"', { PATH: `/from/launch:${process.env.PATH}` });
    expect(output.indexOf("/from/launch")).toBeGreaterThan(-1);
    expect(output.indexOf("/from/rc")).toBeGreaterThan(output.indexOf("/from/launch"));
  },
  30_000,
);

test.each(shells)(
  "%s commands don't get clue's API keys, and the cache doesn't store them",
  async (shell, file) => {
    const { clue, run } = setup(shell, { [file]: "export OPENROUTER_API_KEY=from-rc\n" });
    const output = await run('echo "keys=[$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$OPENROUTER_API_KEY]"', {
      ANTHROPIC_API_KEY: "secret-one",
      ANTHROPIC_AUTH_TOKEN: "secret-two",
    });
    expect(output).toContain("keys=[]");
    const cache = readFileSync(join(clue, "shell-env.json"), "utf8");
    expect(cache).not.toContain("secret-");
    expect(cache).not.toContain("from-rc");
  },
  20_000,
);

test("MCP servers don't get clue's API keys", () => {
  const env = withoutProviderKeys({
    ANTHROPIC_API_KEY: "a",
    ANTHROPIC_AUTH_TOKEN: "b",
    OPENROUTER_API_KEY: "c",
    PATH: "/bin",
  });
  expect(env).toEqual({ PATH: "/bin" });
});

test("a background process from a startup file doesn't hold up commands", async () => {
  const { run } = setup("/bin/bash", { ".bash_profile": "sleep 12 &\n" });
  const started = Date.now();
  expect(await run("echo after-startup")).toContain("after-startup");
  expect(Date.now() - started).toBeLessThan(6000);
}, 20_000);

test("stopping all processes also kills a command that ignores SIGTERM", async () => {
  const script = `
const { shell, stopAllProcesses } = await import(${JSON.stringify(shellModule)});
const context = { cwd: process.cwd(), signal: new AbortController().signal, undo: { noteShell() {} }, progress() {} };
const { content } = await shell.run({ command: "trap '' TERM; echo pid=$$; sleep 25.5", wait_ms: 500 }, context);
const pid = Number(content.match(/pid=(\\d+)/)[1]);
await stopAllProcesses();
// SIGKILL takes a moment to finish, and the group lasts until then. A survivor would stay.
let alive = true;
for (let tries = 0; alive && tries < 100; tries++) {
  try { process.kill(-pid, 0); await Bun.sleep(10); } catch { alive = false; }
}
console.log(alive ? "still alive" : "gone");
process.exit(0);
`;
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: realpathSync(mkdtempSync(join(tmpdir(), "clue-stop-"))),
    env: { ...process.env, SHELL: "/bin/sh", CLUE_HOME: mkdtempSync(join(tmpdir(), "clue-stop-home-")) },
    stdout: "pipe",
    stderr: "inherit",
  });
  expect(await new Response(proc.stdout).text()).toContain("gone");
}, 15_000);

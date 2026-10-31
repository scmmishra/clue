import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

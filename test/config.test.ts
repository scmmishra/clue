import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsProblems } from "../src/config";
import { commandIsRoutine } from "../src/permissions";

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "clue-config-")));

function setup(settings?: string | object) {
  const home = folder();
  if (settings !== undefined)
    writeFileSync(join(home, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  const file = join(home, "settings.json");
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const clean: Record<string, string | undefined> = {
      ...process.env,
      CLUE_HOME: home,
      ANTHROPIC_API_KEY: "sk-ant-test",
      ...env,
    };
    for (const name of ["CLUE_MODEL", "CLUE_EFFORT", "CLUE_PERMISSION_MODE", "VISUAL", "EDITOR"])
      if (!(name in env)) delete clean[name];
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
      cwd: folder(),
      env: clean,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
  return { home, file, run, saved: () => JSON.parse(readFileSync(file, "utf8")) };
}

// An editor that writes fixed text over the file it's given.
function fakeEditor(text: string) {
  const path = join(folder(), "fake-editor");
  writeFileSync(path, `#!/bin/sh\ncat > "$1" <<'CONTENT'\n${text}\nCONTENT\n`);
  chmodSync(path, 0o755);
  return path;
}

test("good settings have no problems", () => {
  expect(
    settingsProblems(
      JSON.stringify({
        model: "sonnet",
        effort: "high",
        permission_mode: "ask",
        bell: false,
        permission: { shell: { "git *": "allow" } },
        review: { provider: "anthropic", model: "haiku" },
      }),
    ),
  ).toEqual([]);
  expect(settingsProblems("{}")).toEqual([]);
});

test.each([
  ["broken JSON", "{ nope", "isn't valid JSON"],
  ["a list", "[]", "must be a JSON object"],
  ["an unknown key", '{"modle":"x"}', "modle isn't a setting"],
  ["the old reviewer key", '{"review_model":"x"}', "review_model was replaced by review"],
  ["a bad effort", '{"effort":"hihg"}', "effort must be one of low, medium, high, xhigh, max"],
  ["a bad mode", '{"permission_mode":"yolo"}', "permission_mode must be one of ask, auto, full-access"],
  ["a bad bell", '{"bell":"no"}', "bell must be true or false"],
  ["a bad model", '{"model":5}', "model must be a string"],
  ["bad rules", '{"permission":"allow"}', "permission must be an object"],
  ["a bad review", '{"review":"haiku"}', "review must be an object"],
  ["a bad provider", '{"review":{"provider":"acme"}}', "review.provider must be one of anthropic, openrouter"],
  ["an unknown review key", '{"review":{"effort":"low"}}', "review.effort isn't a setting"],
])("%s is a problem", (_name, text, expected) => {
  expect(settingsProblems(text).join(" ")).toContain(expected);
});

test("config path prints the settings file", async () => {
  const { run, file } = setup();
  const { stdout, code } = await run(["config", "path"]);
  expect(code).toBe(0);
  expect(stdout.trim()).toBe(file);
});

test("config show says where each value comes from", async () => {
  const { run } = setup({ effort: "high" });
  const { stdout, code } = await run(["config", "show"], { CLUE_MODEL: "claude-sonnet-5-5" });
  expect(code).toBe(0);
  const row = (key: string) =>
    stdout
      .split("\n")
      .find((line) => line.startsWith(`${key} `))
      ?.split(/\s{2,}/);
  expect(row("model")).toEqual(["model", "claude-sonnet-5-5", "CLUE_MODEL"]);
  expect(row("effort")).toEqual(["effort", "high", "settings.json"]);
  expect(row("permission_mode")).toEqual(["permission_mode", "auto", "default"]);
  expect(row("bell")).toEqual(["bell", "true", "default"]);
  expect(row("review.provider")).toEqual(["review.provider", "automatic", "default"]);
});

test("config show --json gives scripts the same data", async () => {
  const { run, file } = setup({ review: { provider: "anthropic" }, permission: { shell: { "git *": "allow" } } });
  const { stdout } = await run(["config", "show", "--json"]);
  const shown = JSON.parse(stdout);
  expect(shown.path).toBe(file);
  expect(shown.settings["review.provider"]).toEqual({ value: "anthropic", source: "settings.json" });
  expect(shown.settings["review.model"]).toEqual({ value: null, source: "default" });
  expect(shown.settings.permission).toEqual({ value: { shell: { "git *": "allow" } }, source: "settings.json" });
  expect(shown.problems).toEqual([]);
});

test("a value the environment overrides with something invalid isn't credited to it", async () => {
  const { run } = setup();
  const { stdout } = await run(["config", "show", "--json"], { CLUE_EFFORT: "bogus" });
  expect(JSON.parse(stdout).settings.effort).toEqual({ value: "medium", source: "default" });
});

test("config show reports a broken file", async () => {
  const { run } = setup("{ nope");
  const { stderr, code } = await run(["config", "show"]);
  expect(code).toBe(0);
  expect(stderr).toContain("isn't valid JSON");
});

test("config set writes a setting, creating the file", async () => {
  const { run, saved, file } = setup();
  expect(existsSync(file)).toBe(false);
  const { stdout, code } = await run(["config", "set", "effort", "high"]);
  expect(code).toBe(0);
  expect(stdout).toContain("Set effort to high.");
  expect(saved()).toEqual({ effort: "high" });
});

test("config set keeps the other settings", async () => {
  const { run, saved } = setup({ model: "sonnet", permission: { "*": "ask" } });
  await run(["config", "set", "bell", "false"]);
  expect(saved()).toEqual({ model: "sonnet", permission: { "*": "ask" }, bell: false });
});

test("config set reaches nested settings", async () => {
  const { run, saved } = setup({ review: { model: "haiku" } });
  await run(["config", "set", "review.provider", "anthropic"]);
  expect(saved()).toEqual({ review: { model: "haiku", provider: "anthropic" } });
});

test.each([
  [["config", "set", "effort", "hihg"], "effort must be one of"],
  [["config", "set", "bell", "maybe"], "bell must be true or false"],
  [["config", "set", "review.provider", "acme"], "review.provider must be one of"],
  [["config", "set", "modle", "x"], "modle isn't a setting"],
  [["config", "set", "permission", "x"], "Use clue config edit"],
  [["config", "set", "constructor", "x"], "constructor isn't a setting"],
  [["config", "set", "effort"], "Usage:"],
  [["config", "set"], "Usage:"],
])("%j is refused and writes nothing", async (args, expected) => {
  const { run, file } = setup();
  const { stderr, code } = await run(args);
  expect(code).toBe(2);
  expect(stderr).toContain(expected);
  expect(existsSync(file)).toBe(false);
});

test("config set won't overwrite a file it can't read", async () => {
  const { run, file } = setup("{ nope");
  const { stderr, code } = await run(["config", "set", "bell", "false"]);
  expect(code).toBe(2);
  expect(stderr).toContain("Fix it with clue config edit");
  expect(readFileSync(file, "utf8")).toBe("{ nope");
});

test("config edit opens the named editor, and accepts good settings", async () => {
  const { run, saved } = setup();
  const { code } = await run(["config", "edit", fakeEditor('{ "effort": "low" }')]);
  expect(code).toBe(0);
  expect(saved()).toEqual({ effort: "low" });
});

test("config edit falls back to VISUAL, then EDITOR", async () => {
  const first = setup();
  await first.run(["config", "edit"], {
    VISUAL: fakeEditor('{ "effort": "low" }'),
    EDITOR: fakeEditor('{ "effort": "high" }'),
  });
  expect(first.saved()).toEqual({ effort: "low" });
  const second = setup();
  await second.run(["config", "edit"], { EDITOR: fakeEditor('{ "effort": "high" }') });
  expect(second.saved()).toEqual({ effort: "high" });
});

test("config edit runs an editor with arguments", async () => {
  const { run, saved } = setup();
  const editor = fakeEditor('{ "effort": "low" }');
  writeFileSync(
    editor,
    `#!/bin/sh\n[ "$1" = "--wait" ] || exit 9\ncat > "$2" <<'CONTENT'\n{ "effort": "low" }\nCONTENT\n`,
  );
  await run(["config", "edit"], { EDITOR: `${editor} --wait` });
  expect(saved()).toEqual({ effort: "low" });
});

test("config edit warns about what the edit broke, and fails", async () => {
  const { run } = setup();
  const { stderr, code } = await run(["config", "edit", fakeEditor('{ "effort": "hihg" }')]);
  expect(code).toBe(1);
  expect(stderr).toContain("effort must be one of");
});

test("config edit says so when the editor can't start", async () => {
  const { run } = setup();
  const { stderr, code } = await run(["config", "edit", "/no/such/editor"]);
  expect(code).toBe(1);
  expect(stderr).toContain("Could not open /no/such/editor");
});

test.each([[["config"]], [["config", "nope"]]])("%j prints the usage", async (args) => {
  const { stderr, code } = await setup().run(args);
  expect(code).toBe(2);
  expect(stderr).toContain("clue config show");
});

test("the config command takes its own flags", async () => {
  const { stdout, code } = await setup().run(["config", "show", "--json"]);
  expect(code).toBe(0);
  expect(() => JSON.parse(stdout)).not.toThrow();
});

test("clue ask warns about broken settings on stderr, and keeps stdout clean", async () => {
  const { run } = setup("{ nope");
  const { stderr } = await run(["ask", "--json", "hi"], { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" });
  expect(stderr).toContain("isn't valid JSON");
});

test("a shell command that changes settings is never routine", () => {
  expect(commandIsRoutine("clue config set permission_mode full-access")).toBe(false);
});

test("config unset removes a setting and keeps the others", async () => {
  const { run, saved } = setup({ effort: "high", bell: false });
  const { stdout, code } = await run(["config", "unset", "effort"]);
  expect(code).toBe(0);
  expect(stdout).toContain("Unset effort.");
  expect(saved()).toEqual({ bell: false });
});

test("config unset reaches nested settings, and keeps what's left beside them", async () => {
  const { run, saved } = setup({ review: { provider: "anthropic", model: "haiku" } });
  await run(["config", "unset", "review.model"]);
  expect(saved()).toEqual({ review: { provider: "anthropic" } });
});

test("config unset removes a parent it leaves empty", async () => {
  const { run, saved } = setup({ review: { provider: "anthropic" }, bell: true });
  await run(["config", "unset", "review.provider"]);
  expect(saved()).toEqual({ bell: true });
});

test("config unset can remove a whole group", async () => {
  const { run, saved } = setup({ permission: { "*": "ask" }, review: { model: "haiku" } });
  await run(["config", "unset", "permission"]);
  await run(["config", "unset", "review"]);
  expect(saved()).toEqual({});
});

test("config unset can clear the old review_model", async () => {
  const { run, saved } = setup({ review_model: "typesafe/jev-1.14" });
  const { code } = await run(["config", "unset", "review_model"]);
  expect(code).toBe(0);
  expect(saved()).toEqual({});
});

test("the value falls back once it's unset", async () => {
  const { run } = setup({ effort: "high" });
  await run(["config", "unset", "effort"]);
  const { stdout } = await run(["config", "show", "--json"]);
  expect(JSON.parse(stdout).settings.effort).toEqual({ value: "medium", source: "default" });
});

test("config unset of something not set changes nothing", async () => {
  const { run, file } = setup({ bell: true });
  const before = readFileSync(file, "utf8");
  const { stdout, code } = await run(["config", "unset", "effort"]);
  expect(code).toBe(0);
  expect(stdout).toContain("effort isn't set.");
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("config unset with no file creates none", async () => {
  const { run, file } = setup();
  const { code } = await run(["config", "unset", "effort"]);
  expect(code).toBe(0);
  expect(existsSync(file)).toBe(false);
});

test.each([
  [["config", "unset", "modle"], "modle isn't a setting"],
  [["config", "unset", "constructor"], "constructor isn't a setting"],
  [["config", "unset"], "Usage:"],
  [["config", "unset", "bell", "extra"], "Usage:"],
])("%j is refused", async (args, expected) => {
  const { run, file } = setup({ bell: true });
  const { stderr, code } = await run(args);
  expect(code).toBe(2);
  expect(stderr).toContain(expected);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ bell: true });
});

test("config unset won't overwrite a file it can't read", async () => {
  const { run, file } = setup("{ nope");
  const { stderr, code } = await run(["config", "unset", "bell"]);
  expect(code).toBe(2);
  expect(stderr).toContain("Fix it with clue config edit");
  expect(readFileSync(file, "utf8")).toBe("{ nope");
});

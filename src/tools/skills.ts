import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { ensureDir, paths } from "../config";
import { checkFields, type Tool } from "./types";

export type Skill = { name: string; description: string; dir: string };

const skillDirs = (cwd: string) => [
  join(cwd, ".clue", "skills"),
  paths.skills,
  join(cwd, ".claude", "skills"),
  join(homedir(), ".claude", "skills"),
  join(cwd, ".agents", "skills"),
  join(homedir(), ".agents", "skills"),
];

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const parsed = Bun.YAML.parse(match[1]) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed ?? {}).map(([key, value]) => [key, String(value)]));
  } catch {
    return {};
  }
}

// Skills from every known folder. The first folder that defines a name wins.
export function discoverSkills(cwd: string): Skill[] {
  const found = new Map<string, Skill>();
  for (const root of skillDirs(cwd)) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const dir = join(root, entry);
      const file = join(dir, "SKILL.md");
      if (!existsSync(file)) continue;
      const fields = frontmatter(readFileSync(file, "utf8"));
      const name = fields.name || entry;
      if (found.has(name)) continue;
      found.set(name, { name, description: (fields.description || "No description.").slice(0, 300), dir });
    }
  }
  return [...found.values()];
}

function listResources(dir: string, base = dir, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listResources(full, base, out);
    else if (entry !== "SKILL.md") out.push(relative(base, full));
  }
  return out;
}

export const skillTool: Tool<{ name: string; resource?: string }> = {
  name: "skill",
  description: "Read a skill's instructions (SKILL.md), or one of its reference files with resource.",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name from the context block." },
      resource: { type: "string", description: "Path of a file inside the skill folder." },
    },
    required: ["name"],
  },
  kind: "skill",
  readOnly: true,
  label: (input, done) => `${done ? "Read" : "Reading"} skill ${input.name}${input.resource ? ` ${input.resource}` : ""}`,
  validate: (input) => checkFields(input, { name: "string", resource: "string?" }),
  async run(input, context) {
    const skill = context.skills().find((item) => item.name === input.name);
    if (!skill) return { content: `No skill named ${input.name}.`, isError: true };
    if (input.resource) {
      const file = resolve(skill.dir, input.resource);
      if (!file.startsWith(skill.dir) || !existsSync(file)) return { content: `No file ${input.resource} in skill ${skill.name}.`, isError: true };
      return { content: readFileSync(file, "utf8") };
    }
    const resources = listResources(skill.dir);
    const text = readFileSync(join(skill.dir, "SKILL.md"), "utf8");
    return { content: resources.length ? `${text}\n\nFiles in this skill: ${resources.join(", ")}` : text };
  },
};

export const installSkill: Tool<{ source: string }> = {
  name: "install_skill",
  description: "Install a skill into ~/.clue/skills from a local folder or a git repository URL. The folder must contain SKILL.md.",
  schema: {
    type: "object",
    properties: { source: { type: "string", description: "Local folder path or git URL." } },
    required: ["source"],
  },
  kind: "skill",
  label: (input, done) => `${done ? "Installed" : "Installing"} skill from ${input.source}`,
  validate: (input) => checkFields(input, { source: "string" }),
  async run(input, context) {
    ensureDir(paths.skills);
    let dir = resolve(context.cwd, input.source);
    if (/^(https?:|git@)/.test(input.source)) {
      const target = join(paths.skills, basename(input.source).replace(/\.git$/, ""));
      if (existsSync(target)) return { content: `${target} already exists.`, isError: true };
      const proc = Bun.spawn(["git", "clone", "--depth", "1", input.source, target], { stdout: "pipe", stderr: "pipe", signal: context.signal });
      if ((await proc.exited) !== 0) return { content: await new Response(proc.stderr).text(), isError: true };
      dir = target;
    } else {
      if (!existsSync(join(dir, "SKILL.md"))) return { content: `${input.source} has no SKILL.md.`, isError: true };
      const target = join(paths.skills, basename(dir));
      if (existsSync(target)) return { content: `${target} already exists.`, isError: true };
      cpSync(dir, target, { recursive: true });
      dir = target;
    }
    if (!existsSync(join(dir, "SKILL.md"))) return { content: `Installed ${dir}, but it has no SKILL.md at its root.`, isError: true };
    return { content: `Installed skill at ${dir}. It is available from the next session.` };
  },
};

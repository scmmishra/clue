import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { paths } from "../config";
import type { Skill } from "../tools/skills";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
const MAX_INSTRUCTION_CHARS = 20_000;

// Reads the branch from .git/HEAD directly. Spawning git costs more than the whole launch budget.
export function gitBranch(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const head = join(dir, ".git", "HEAD");
    if (existsSync(head)) {
      try {
        const text = readFileSync(head, "utf8").trim();
        return text.startsWith("ref: refs/heads/") ? text.slice(16) : text.slice(0, 8);
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function gitRoot(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// git status takes about 15 ms, and a new session can't send its first request
// without it. App start and `/new` run it while the user is still typing, and the
// first turn takes the result. It is used once, and only if it is fresh.
const PREFETCH_MAX_AGE_MS = 60_000;
let prefetched: { cwd: string; at: number; status: Promise<string> } | null = null;

export function prefetchGitStatus(cwd: string) {
  if (gitBranch(cwd)) prefetched = { cwd, at: Date.now(), status: gitStatus(cwd) };
}

function takeGitStatus(cwd: string) {
  const ready = prefetched;
  prefetched = null;
  return ready && ready.cwd === cwd && Date.now() - ready.at < PREFETCH_MAX_AGE_MS ? ready.status : gitStatus(cwd);
}

async function gitStatus(cwd: string) {
  try {
    const proc = Bun.spawn(["git", "status", "--short", "--branch"], { cwd, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = text.trim().split("\n");
    return lines.length > 40 ? `${lines.slice(0, 40).join("\n")}\n… ${lines.length - 40} more` : text.trim();
  } catch {
    return "";
  }
}

function readInstructions(file: string) {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text.length > MAX_INSTRUCTION_CHARS ? `${text.slice(0, MAX_INSTRUCTION_CHARS)}\n…(truncated)` : text;
  } catch {
    return null;
  }
}

// Instruction files from the git root down to the folder clue started in, plus ~/.clue/AGENTS.md.
export function instructionFiles(cwd: string): string[] {
  const root = gitRoot(cwd) ?? cwd;
  const files: string[] = [];
  if (existsSync(paths.agents)) files.push(paths.agents);
  const chain: string[] = [];
  let dir = cwd;
  while (true) {
    chain.unshift(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const folder of chain) {
    for (const name of INSTRUCTION_FILES) {
      const file = join(folder, name);
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

// Instructions in a subfolder that apply once the agent works there.
export function nestedInstructions(cwd: string, target: string, seen: Set<string>): string[] {
  const notes: string[] = [];
  let dir = dirname(resolve(cwd, target));
  const root = resolve(cwd);
  const found: string[] = [];
  while (dir.startsWith(root) && dir !== root) {
    for (const name of INSTRUCTION_FILES) {
      const file = join(dir, name);
      if (!seen.has(file) && existsSync(file)) found.unshift(file);
    }
    dir = dirname(dir);
  }
  for (const file of found) {
    seen.add(file);
    const text = readInstructions(file);
    if (text)
      notes.push(
        `Instructions from ${relative(cwd, file)} apply to files under ${relative(cwd, dirname(file)) || "."}:\n${text}`,
      );
  }
  return notes;
}

export async function buildContext(cwd: string, skills: Skill[], mcpServers: string[], seen: Set<string>) {
  const branch = gitBranch(cwd);
  const status = branch ? await takeGitStatus(cwd) : "";
  const shell = basename(process.env.SHELL ?? "sh");
  const lines = [
    "<context>",
    `folder: ${cwd}`,
    `os: ${process.platform} ${process.arch}`,
    `shell: ${shell}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    branch ? `git:\n${status}` : "git: not a repository",
  ];
  for (const file of instructionFiles(cwd)) {
    seen.add(file);
    const text = readInstructions(file);
    if (text)
      lines.push(
        `\n<instructions file="${file === paths.agents ? "~/.clue/AGENTS.md" : relative(cwd, file) || basename(file)}">\n${text}\n</instructions>`,
      );
  }
  if (skills.length) {
    lines.push("\nskills (read one with the skill tool when it matches the task):");
    for (const skill of skills) lines.push(`- ${skill.name}: ${skill.description}`);
  }
  if (mcpServers.length)
    lines.push(`\nmcp servers: ${mcpServers.join(", ")} (find their tools with capability_search)`);
  lines.push("</context>");
  return lines.join("\n");
}

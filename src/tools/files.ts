import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { nestedInstructions } from "../agent/context";
import { checkFields, type Tool, type ToolContext } from "./types";

const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_GLOB_RESULTS = 400;
const MAX_IMAGE_EDGE = 1568;
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_GREP_LINES = 400;
const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", ".next", "target", "vendor", ".venv", "__pycache__"];

export const absolute = (cwd: string, path: string) => (isAbsolute(path) ? path : resolve(cwd, path));
export const display = (cwd: string, path: string) => {
  const rel = relative(cwd, absolute(cwd, path));
  return rel && !rel.startsWith("..") ? rel : path;
};

const mtime = (file: string) => statSync(file).mtimeMs;

function withNestedInstructions(context: ToolContext, path: string, text: string) {
  const notes = nestedInstructions(context.cwd, path, context.seenInstructions);
  return notes.length ? `${text}\n\n${notes.join("\n\n")}` : text;
}

export const readFile: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: "read_file",
  description:
    "Read a file. Text comes back with line numbers. Images (png, jpg, gif, webp) come back as images you can see. Use offset and limit for large files.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project folder or absolute." },
      offset: { type: "number", description: "First line to read, starting at 1." },
      limit: { type: "number", description: `Number of lines to read. Default ${DEFAULT_READ_LINES}.` },
    },
    required: ["path"],
  },
  kind: "read",
  readOnly: true,
  label: (input, done) => `${done ? "Read" : "Reading"} ${input.path}`,
  validate: (input) => checkFields(input, { path: "string", offset: "number?", limit: "number?" }),
  async run(input, context) {
    const file = absolute(context.cwd, input.path);
    if (!existsSync(file)) return { content: `No file at ${input.path}.`, isError: true };
    const stat = statSync(file);
    if (stat.isDirectory()) return { content: `${input.path} is a folder. Use glob_files to list it.`, isError: true };
    const imageType = IMAGE_TYPES[extname(file).toLowerCase()];
    if (imageType) {
      context.readStamps.set(file, stat.mtimeMs);
      const image = Bun.file(file).image();
      const { width, height } = await image.metadata();
      // Claude scales images above about 1568 px anyway. Shrinking here sends fewer bytes and tokens.
      const large = Math.max(width, height) > MAX_IMAGE_EDGE || stat.size > MAX_IMAGE_BYTES;
      const data = large
        ? await image.resize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, { fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBase64()
        : Buffer.from(await Bun.file(file).bytes()).toString("base64");
      return {
        content: [{ type: "image", source: { type: "base64", media_type: large ? "image/webp" : imageType, data } }],
        full: `[image ${input.path}, ${width}×${height}${large ? `, sent as ${MAX_IMAGE_EDGE}px webp` : ""}]`,
        note: `${width}×${height}${large ? " → resized" : ""}`,
      };
    }
    const text = await Bun.file(file).text();
    context.readStamps.set(file, stat.mtimeMs);
    const lines = text.split("\n");
    const start = Math.max(1, input.offset ?? 1);
    const end = Math.min(lines.length, start - 1 + (input.limit ?? DEFAULT_READ_LINES));
    const numbered = lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(6)}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`)
      .join("\n");
    const more = end < lines.length ? `\n\n[${lines.length - end} more lines. Continue with offset ${end + 1}.]` : "";
    return {
      content: withNestedInstructions(context, file, (numbered || "(empty file)") + more),
      note: `${end - start + 1} lines`,
    };
  },
};

export const globFiles: Tool<{ pattern: string; path?: string }> = {
  name: "glob_files",
  description: "Find files by glob pattern, such as \"src/**/*.ts\". Skips node_modules, .git and build folders.",
  schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern." },
      path: { type: "string", description: "Folder to search in. Defaults to the project folder." },
    },
    required: ["pattern"],
  },
  kind: "search",
  readOnly: true,
  label: (input, done) => `${done ? "Found" : "Finding"} ${input.pattern}`,
  validate: (input) => checkFields(input, { pattern: "string", path: "string?" }),
  async run(input, context) {
    const root = absolute(context.cwd, input.path ?? ".");
    const glob = new Bun.Glob(input.pattern);
    const found: string[] = [];
    for await (const file of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
      if (context.signal.aborted) break;
      if (IGNORED_DIRS.some((dir) => file.split("/").includes(dir))) continue;
      found.push(file);
      if (found.length > MAX_GLOB_RESULTS) break;
    }
    found.sort();
    const shown = found.slice(0, MAX_GLOB_RESULTS);
    const prefix = input.path ? `${display(context.cwd, root)}/` : "";
    const body = shown.map((file) => prefix + file).join("\n");
    const more = found.length > MAX_GLOB_RESULTS ? `\n[More than ${MAX_GLOB_RESULTS} files. Narrow the pattern.]` : "";
    return { content: body ? body + more : "No files match.", note: `${shown.length}${found.length > MAX_GLOB_RESULTS ? "+" : ""} files` };
  },
};

export const grepFiles: Tool<{ pattern: string; path?: string; glob?: string; regex?: boolean; ignore_case?: boolean; context?: number }> = {
  name: "grep_files",
  description:
    "Search file contents. Matches literal text by default; set regex for a regular expression. Returns file:line:text. Respects .gitignore.",
  schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Text or regular expression to find." },
      path: { type: "string", description: "File or folder to search. Defaults to the project folder." },
      glob: { type: "string", description: "Only search files matching this glob, such as \"*.ts\"." },
      regex: { type: "boolean", description: "Treat pattern as a regular expression." },
      ignore_case: { type: "boolean" },
      context: { type: "number", description: "Lines of context around each match." },
    },
    required: ["pattern"],
  },
  kind: "search",
  readOnly: true,
  label: (input, done) => `${done ? "Searched" : "Searching"} "${input.pattern}"`,
  validate: (input) => checkFields(input, { pattern: "string", path: "string?", glob: "string?", regex: "boolean?", ignore_case: "boolean?", context: "number?" }),
  async run(input, context) {
    const rg = Bun.which("rg");
    const target = input.path ? absolute(context.cwd, input.path) : ".";
    let text: string;
    if (rg) {
      const args = [rg, "--line-number", "--no-heading", "--color", "never", "--max-columns", "400", "--max-count", "50"];
      if (!input.regex) args.push("--fixed-strings");
      if (input.ignore_case) args.push("--ignore-case");
      if (input.context) args.push("--context", String(Math.min(input.context, 10)));
      if (input.glob) args.push("--glob", input.glob);
      args.push("--", input.pattern, target);
      const proc = Bun.spawn(args, { cwd: context.cwd, stdout: "pipe", stderr: "pipe", signal: context.signal });
      text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 2) return { content: (await new Response(proc.stderr).text()).trim() || "Search failed.", isError: true };
    } else {
      const proc = Bun.spawn(["grep", "-rn", input.regex ? "-E" : "-F", ...(input.ignore_case ? ["-i"] : []), "--", input.pattern, target], {
        cwd: context.cwd,
        stdout: "pipe",
        stderr: "ignore",
        signal: context.signal,
      });
      text = await new Response(proc.stdout).text();
      await proc.exited;
    }
    const lines = text.trim() ? text.trim().split("\n") : [];
    const files = new Set(lines.map((line) => line.split(":")[0]));
    const shown = lines.slice(0, MAX_GREP_LINES).join("\n");
    const more = lines.length > MAX_GREP_LINES ? `\n[${lines.length - MAX_GREP_LINES} more lines. Narrow the search.]` : "";
    return {
      content: shown ? shown + more : "No matches.",
      note: lines.length ? `${lines.length} matches in ${files.size} files` : "no matches",
    };
  },
};

// A unified-style diff of one replacement, with a little context.
function replacementDiff(before: string, after: string, index: number, oldText: string, newText: string) {
  const startLine = before.slice(0, index).split("\n").length;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const CONTEXT = 2;
  const out: string[] = [];
  for (let line = Math.max(1, startLine - CONTEXT); line < startLine; line++) out.push(`  ${line} ${beforeLines[line - 1]}`);
  oldLines.forEach((text, offset) => out.push(`- ${startLine + offset} ${text}`));
  newLines.forEach((text, offset) => out.push(`+ ${startLine + offset} ${text}`));
  const resume = startLine + newLines.length;
  for (let line = resume; line < resume + CONTEXT && line <= afterLines.length; line++) out.push(`  ${line} ${afterLines[line - 1]}`);
  return { diff: out.join("\n"), added: newLines.length, removed: oldLines.length };
}

export const writeFile: Tool<{ path: string; content: string }> = {
  name: "write_file",
  description: "Create a file, or replace a whole file you have already read. Prefer edit_file for changes to existing files.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "The complete file contents." },
    },
    required: ["path", "content"],
  },
  kind: "write",
  label: (input, done) => `${done ? "Wrote" : "Writing"} ${input.path}`,
  validate: (input) => checkFields(input, { path: "string", content: "string" }),
  async run(input, context) {
    const file = absolute(context.cwd, input.path);
    const exists = existsSync(file);
    if (exists && !context.readStamps.has(file)) {
      return { content: `${input.path} already exists. Read it before replacing it.`, isError: true };
    }
    if (exists && context.readStamps.get(file) !== mtime(file)) {
      return { content: `${input.path} changed since you last read it. Read it again first.`, isError: true };
    }
    const before = exists ? readFileSync(file, "utf8") : "";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, input.content);
    context.readStamps.set(file, mtime(file));
    const added = input.content.split("\n").length;
    const removed = exists ? before.split("\n").length : 0;
    const diff = input.content
      .split("\n")
      .map((line, index) => `+ ${index + 1} ${line}`)
      .join("\n");
    return {
      content: withNestedInstructions(context, file, `${exists ? "Replaced" : "Created"} ${input.path} (${added} lines).`),
      diff,
      added,
      removed,
    };
  },
};

export const editFile: Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> = {
  name: "edit_file",
  description:
    "Replace exact text in a file you have read. old_string must match the file exactly, including whitespace, and must be unique unless replace_all is set. Refuses if the file changed since you read it.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence." },
    },
    required: ["path", "old_string", "new_string"],
  },
  kind: "edit",
  label: (input, done) => `${done ? "Edited" : "Editing"} ${input.path}`,
  validate: (input) => checkFields(input, { path: "string", old_string: "string", new_string: "string", replace_all: "boolean?" }),
  async run(input, context) {
    const file = absolute(context.cwd, input.path);
    if (!existsSync(file)) return { content: `No file at ${input.path}. Use write_file to create it.`, isError: true };
    if (!context.readStamps.has(file)) return { content: `Read ${input.path} before editing it.`, isError: true };
    if (context.readStamps.get(file) !== mtime(file)) {
      return { content: `${input.path} changed since you last read it. Read it again, then edit.`, isError: true };
    }
    if (input.old_string === input.new_string) return { content: "old_string and new_string are the same.", isError: true };
    const before = readFileSync(file, "utf8");
    const first = before.indexOf(input.old_string);
    if (first === -1) return { content: `old_string was not found in ${input.path}. Check whitespace and read the file again.`, isError: true };
    const count = before.split(input.old_string).length - 1;
    if (count > 1 && !input.replace_all) {
      return { content: `old_string appears ${count} times in ${input.path}. Add surrounding lines to make it unique, or set replace_all.`, isError: true };
    }
    const after = input.replace_all ? before.split(input.old_string).join(input.new_string) : before.replace(input.old_string, () => input.new_string);
    writeFileSync(file, after);
    context.readStamps.set(file, mtime(file));
    const { diff, added, removed } = replacementDiff(before, after, first, input.old_string, input.new_string);
    const times = input.replace_all && count > 1 ? ` (${count} places)` : "";
    return {
      content: withNestedInstructions(context, file, `Edited ${input.path}${times}.`),
      diff,
      added: added * (input.replace_all ? count : 1),
      removed: removed * (input.replace_all ? count : 1),
    };
  },
};

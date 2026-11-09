import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { nestedInstructions } from "../agent/context";
import { snapshotFile } from "../agent/undo";
import { checkFields, fieldOf, type Tool, type ToolContext } from "./types";

const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_IMAGE_EDGE = 1568;
export const MAX_IMAGE_BYTES = 3_500_000;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MEDIA_TYPES: Partial<Record<Bun.Image.Format, "image/png" | "image/jpeg" | "image/gif" | "image/webp">> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export const absolute = (cwd: string, path: string) => (isAbsolute(path) ? path : resolve(cwd, path));
export const display = (cwd: string, path: string) => {
  const rel = relative(cwd, absolute(cwd, path));
  return rel && !rel.startsWith("..") ? rel : path;
};

const mtime = (file: string) => statSync(file).mtimeMs;

// Claude scales images above about 1568 px anyway, so shrinking here sends fewer bytes and tokens.
export const isLargeImage = (width: number, height: number) => Math.max(width, height) > MAX_IMAGE_EDGE;
export const shrinkImage = (image: Bun.Image) =>
  image
    .resize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBase64();

// An image as Claude receives it.
export async function encodeImage(file: string, size: number) {
  const image = Bun.file(file).image();
  const { width, height, format } = await image.metadata();
  // The bytes decide the type: the API refuses a wrong one, and the block stays in the session.
  const type = MEDIA_TYPES[format];
  const large = !type || isLargeImage(width, height) || size > MAX_IMAGE_BYTES;
  const data = large ? await shrinkImage(image) : Buffer.from(await Bun.file(file).bytes()).toString("base64");
  const block = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: large ? ("image/webp" as const) : type!,
      data,
    },
  };
  return { block, width, height, large };
}

function withNestedInstructions(context: ToolContext, path: string, text: string) {
  const notes = nestedInstructions(context.cwd, path, context.seenInstructions);
  return notes.length ? `${text}\n\n${notes.join("\n\n")}` : text;
}

const LARGE_FILE_BYTES = 256 * 1024;
const HEAD_WINDOW_LINES = 5000;
const FIRST_READ_BYTES = 64 * 1024;

const numberLines = (lines: string[], start: number, end: number) =>
  lines
    .slice(start - 1, end)
    .map(
      (line, index) =>
        `${String(start + index).padStart(6)}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`,
    )
    .join("\n");

// Reads the start of a file until at least `needed` complete lines are in, doubling the
// read each time. `complete` is true when the whole file was read.
async function readHead(file: string, size: number, needed: number) {
  let bytes = Math.min(size, FIRST_READ_BYTES);
  while (true) {
    const lines = (await Bun.file(file).slice(0, bytes).text()).split("\n");
    if (bytes >= size) return { lines, complete: true };
    // The last piece may be cut off mid-line or mid-character.
    lines.pop();
    if (lines.length > needed) return { lines, complete: false };
    bytes = Math.min(size, bytes * 2);
  }
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
    additionalProperties: false,
  },
  kind: "read",
  readOnly: true,
  label: (input, done) => `${done ? "Read" : "Reading"} ${input.path}`,
  validate: (input) => checkFields(input, { path: "string", offset: "number?", limit: "number?" }),
  async run(input, context) {
    const file = absolute(context.cwd, input.path);
    // One stat answers "does it exist", "is it a folder" and "how big".
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!stat) return { content: `No file at ${input.path}.`, isError: true };
    if (stat.isDirectory()) return { content: `${input.path} is a folder. Use shell to list it.`, isError: true };
    const isImage = IMAGE_EXTENSIONS.has(extname(file).toLowerCase());
    if (isImage) {
      context.readStamps.set(file, stat.mtimeMs);
      const { block, width, height, large } = await encodeImage(file, stat.size);
      return {
        content: [block],
        full: `[image ${input.path}, ${width}×${height}${large ? `, sent as ${MAX_IMAGE_EDGE}px webp` : ""}]`,
        note: `${width}×${height}${large ? " → resized" : ""}`,
      };
    }
    context.readStamps.set(file, stat.mtimeMs);
    const start = Math.max(1, input.offset ?? 1);
    const wanted = start - 1 + (input.limit ?? DEFAULT_READ_LINES);
    // A big file with the window near the top: read the bytes it needs, not all 20 MB.
    if (stat.size > LARGE_FILE_BYTES && wanted <= HEAD_WINDOW_LINES) {
      const head = await readHead(file, stat.size, wanted);
      const last = Math.min(head.lines.length, wanted);
      const text = numberLines(head.lines, start, last);
      const more = head.complete
        ? last < head.lines.length
          ? `\n\n[${head.lines.length - last} more lines. Continue with offset ${last + 1}.]`
          : ""
        : `\n\n[More lines follow. Continue with offset ${last + 1}.]`;
      return {
        content: withNestedInstructions(context, file, (text || "(empty file)") + more),
        note: `${Math.max(0, last - start + 1)} lines`,
      };
    }
    const text = await Bun.file(file).text();
    const lines = text.split("\n");
    const end = Math.min(lines.length, wanted);
    const numbered = numberLines(lines, start, end);
    const more = end < lines.length ? `\n\n[${lines.length - end} more lines. Continue with offset ${end + 1}.]` : "";
    return {
      content: withNestedInstructions(context, file, (numbered || "(empty file)") + more),
      note: `${end - start + 1} lines`,
    };
  },
};

// A unified-style diff of one replacement, with a little context.
// One replacement as a hunk. Line numbers come from the text around it in each version.
function replacementDiff(before: string, after: string, span: Span, afterIndex: number) {
  const oldStart = before.slice(0, span.start).split("\n").length;
  const newStart = after.slice(0, afterIndex).split("\n").length;
  const oldLines = before.slice(span.start, span.end).split("\n");
  const newLines = span.text.split("\n");
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const CONTEXT = 2;
  const out: string[] = [];
  for (let line = Math.max(1, oldStart - CONTEXT); line < oldStart; line++)
    out.push(`  ${line} ${beforeLines[line - 1]}`);
  oldLines.forEach((text, offset) => out.push(`- ${oldStart + offset} ${text}`));
  newLines.forEach((text, offset) => out.push(`+ ${newStart + offset} ${text}`));
  const resume = newStart + newLines.length;
  for (let line = resume; line < resume + CONTEXT && line <= afterLines.length; line++)
    out.push(`  ${line} ${afterLines[line - 1]}`);
  return { lines: out, added: newLines.length, removed: oldLines.length };
}

export const writeFile: Tool<{ path: string; content: string }> = {
  name: "write_file",
  description:
    "Create a file, or replace a whole file you have already read. Prefer edit_file for changes to existing files.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "The complete file contents." },
    },
    required: ["path", "content"],
    additionalProperties: false,
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
    const previous = snapshotFile(file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, input.content);
    context.undo.record(file, previous);
    context.readStamps.set(file, mtime(file));
    const added = input.content.split("\n").length;
    const removed = exists ? before.split("\n").length : 0;
    const diff = input.content
      .split("\n")
      .map((line, index) => `+ ${index + 1} ${line}`)
      .join("\n");
    return {
      content: withNestedInstructions(
        context,
        file,
        `${exists ? "Replaced" : "Created"} ${input.path} (${added} lines).`,
      ),
      diff,
      added,
      removed,
    };
  },
};

type Edit = { old_string: string; new_string: string };
// A range of the original file and the text that replaces it.
type Span = { start: number; end: number; text: string };

// Where one edit applies in the file, or why it can't.
function locate(before: string, edit: Edit, path: string): Span | string {
  if (edit.old_string === "") return "old_string is empty.";
  if (edit.old_string === edit.new_string) return "old_string and new_string are the same.";
  const start = before.indexOf(edit.old_string);
  if (start === -1) return `old_string was not found in ${path}. Check whitespace and read the file again.`;
  const count = before.split(edit.old_string).length - 1;
  if (count > 1) return `old_string appears ${count} times in ${path}. Add surrounding lines to make it unique.`;
  return { start, end: start + edit.old_string.length, text: edit.new_string };
}

export const editFile: Tool<{ path: string; edits: Edit[] }> = {
  name: "edit_file",
  description:
    "Replace exact text in a file. Put every change to one file in one call. Each old_string must match the file exactly, including whitespace, and must be unique. Each edit matches against the original file, so edits can't overlap or build on each other. If one edit fails, the file stays unchanged.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        description: "The replacements to make.",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to replace." },
            new_string: { type: "string", description: "Replacement text." },
          },
          required: ["old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  },
  kind: "edit",
  label: (input, done) => `${done ? "Edited" : "Editing"} ${input.path}`,
  validate: (input) => {
    const problem = checkFields(input, { path: "string", edits: "array" });
    if (problem) return problem;
    const edits = fieldOf(input, "edits") as unknown[];
    if (edits.length === 0) return "edits needs at least one edit.";
    for (const edit of edits) {
      const invalid = checkFields(edit, { old_string: "string", new_string: "string" });
      if (invalid) return invalid;
    }
    return null;
  },
  async run(input, context) {
    const file = absolute(context.cwd, input.path);
    if (!existsSync(file)) return { content: `No file at ${input.path}. Use write_file to create it.`, isError: true };
    // old_string shows Claude knows the text, so a plain edit needs no read. write_file does.
    const current = context.readStamps.get(file) === mtime(file);
    const before = readFileSync(file, "utf8");
    const spans: Span[] = [];
    for (const [index, edit] of input.edits.entries()) {
      const located = locate(before, edit, input.path);
      if (typeof located === "string") {
        return { content: input.edits.length > 1 ? `Edit ${index + 1}: ${located}` : located, isError: true };
      }
      spans.push(located);
    }
    spans.sort((a, b) => a.start - b.start);
    if (spans.some((span, index) => index > 0 && span.start < spans[index - 1].end)) {
      return { content: `Edits overlap in ${input.path}. Merge them into one edit.`, isError: true };
    }
    let after = "";
    let position = 0;
    const starts = spans.map((span) => {
      after += before.slice(position, span.start);
      const start = after.length;
      after += span.text;
      position = span.end;
      return start;
    });
    after += before.slice(position);
    const previous = snapshotFile(file);
    writeFileSync(file, after);
    context.undo.record(file, previous);
    // Without a current read, this edit doesn't show Claude knows the rest of the file.
    if (current) context.readStamps.set(file, mtime(file));
    const hunks = spans.map((span, index) => replacementDiff(before, after, span, starts[index]));
    const places = spans.length > 1 ? ` (${spans.length} places)` : "";
    return {
      content: withNestedInstructions(context, file, `Edited ${input.path}${places}.`),
      diff: hunks.flatMap((hunk) => hunk.lines).join("\n"),
      added: hunks.reduce((sum, hunk) => sum + hunk.added, 0),
      removed: hunks.reduce((sum, hunk) => sum + hunk.removed, 0),
    };
  },
};

import type { UndoStack } from "../agent/undo";
import type Anthropic from "@anthropic-ai/sdk";
import type { Session } from "../session";
import type { McpManager } from "../mcp/manager";
import type { Skill } from "./skills";

export type ToolResultContent =
  string | Array<Anthropic.Beta.Messages.BetaTextBlockParam | Anthropic.Beta.Messages.BetaImageBlockParam>;

export type ToolOutput = {
  content: ToolResultContent;
  isError?: boolean;
  // Full text kept in the session file for ctrl+o and read_tool_result.
  full?: string;
  diff?: string;
  added?: number;
  removed?: number;
  // Short outcome appended to the transcript line, such as "12 matches".
  note?: string;
};

export type Question = { question: string; options: { label: string; description?: string }[]; multiple?: boolean };

export type ToolContext = {
  cwd: string;
  session: Session;
  signal: AbortSignal;
  mcp: McpManager;
  skills: () => Skill[];
  // Modification time of each file when the model last read it.
  readStamps: Map<string, number>;
  undo: UndoStack;
  seenInstructions: Set<string>;
  ask: (question: Question) => Promise<string | null>;
  progress: (text: string) => void;
  subagent: (task: string, description: string, signal: AbortSignal) => Promise<ToolOutput>;
  interactive: boolean;
};

// Categories for the folded summary line: "3 tool calls  1 read  2 commands".
export type ToolKind =
  "read" | "search" | "edit" | "write" | "command" | "web" | "subagent" | "skill" | "mcp" | "question" | "result";

export type Tool<Input = any> = {
  name: string;
  description: string;
  schema: Anthropic.Beta.Messages.BetaTool.InputSchema;
  kind: ToolKind | ((input: Input) => ToolKind);
  // Runs without permission checks in every mode.
  readOnly?: boolean;
  // Present-tense label while running and past-tense label once done.
  label: (input: Input, done: boolean) => string;
  // Returns an error message when the input is unusable.
  validate: (input: any) => string | null;
  run: (input: Input, context: ToolContext) => Promise<ToolOutput>;
};

export const toolKind = (tool: Tool, input: unknown) =>
  typeof tool.kind === "function" ? tool.kind(input) : tool.kind;

// Checks that every required field exists and has the declared primitive type.
export function checkFields(
  input: any,
  fields: Record<
    string,
    "string" | "number" | "boolean" | "object" | "array" | "string?" | "number?" | "boolean?" | "object?" | "array?"
  >,
) {
  if (!input || typeof input !== "object") return "Input must be a JSON object.";
  for (const [key, spec] of Object.entries(fields)) {
    const optional = spec.endsWith("?");
    const type = spec.replace("?", "");
    const value = input[key];
    if (value === undefined || value === null) {
      if (optional) continue;
      return `Missing required field "${key}".`;
    }
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual !== type) return `Field "${key}" must be a ${type}.`;
  }
  return null;
}

export const MAX_RESULT_CHARS = 30_000;

// Keeps the head and tail of long output and says how to read the rest.
export function clip(text: string, toolUseId: string, max = MAX_RESULT_CHARS) {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.35));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n[… ${omitted} characters omitted. Read them with read_tool_result id="${toolUseId}" and an offset.]\n\n${tail}`;
}

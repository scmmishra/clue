import type Anthropic from "@anthropic-ai/sdk";
import { modelInfo } from "../agent/models";
import { editFile, globFiles, grepFiles, readFile, writeFile } from "./files";
import { capabilitySearch, mcpCall } from "./mcp";
import { askUser, readToolResult, subagent } from "./misc";
import { shell } from "./shell";
import { installSkill, skillTool } from "./skills";
import type { Tool } from "./types";

// Fixed order: the tool list is part of the cached request prefix.
export const TOOLS: Tool[] = [
  globFiles,
  grepFiles,
  readFile,
  writeFile,
  editFile,
  shell,
  subagent,
  skillTool,
  installSkill,
  capabilitySearch,
  mcpCall,
  askUser,
  readToolResult,
];

const SUBAGENT_EXCLUDED = new Set(["subagent", "ask_user_question"]);

export const findTool = (name: string) => TOOLS.find((tool) => tool.name === name);

// Server-side tools run on Anthropic's side and come back as result blocks.
export const SERVER_TOOL_NAMES = new Set(["web_search", "web_fetch"]);

export function toolDefinitions(
  model: string,
  options: { subagent?: boolean } = {},
): Anthropic.Beta.Messages.BetaToolUnion[] {
  const tools = options.subagent ? TOOLS.filter((tool) => !SUBAGENT_EXCLUDED.has(tool.name)) : TOOLS;
  const client: Anthropic.Beta.Messages.BetaToolUnion[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema,
    // Large inputs, such as file contents, stream as they are generated.
    eager_input_streaming: true,
  }));
  const dynamic = modelInfo(model)?.dynamicWebTools ?? false;
  const server = (
    dynamic
      ? [
          { type: "web_search_20260209", name: "web_search" },
          { type: "web_fetch_20260209", name: "web_fetch" },
        ]
      : [
          { type: "web_search_20250305", name: "web_search" },
          { type: "web_fetch_20250910", name: "web_fetch" },
        ]
  ) as Anthropic.Beta.Messages.BetaToolUnion[];
  return [...client, ...server];
}

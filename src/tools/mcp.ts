import { checkFields, type Tool } from "./types";

const MAX_MATCHES = 12;

const score = (query: string[], text: string) => {
  const haystack = text.toLowerCase();
  return query.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
};

export const capabilitySearch: Tool<{ query: string }> = {
  name: "capability_search",
  description:
    "Search installed skills and the tools of connected MCP servers by keywords. MCP results include each tool's input schema; call one with mcp_call.",
  schema: {
    type: "object",
    properties: { query: { type: "string", description: "Keywords, such as \"slack post message\" or \"database query\"." } },
    required: ["query"],
  },
  kind: "search",
  readOnly: true,
  label: (input, done) => `${done ? "Searched" : "Searching"} capabilities for "${input.query}"`,
  validate: (input) => checkFields(input, { query: "string" }),
  async run(input, context) {
    await context.mcp.settle();
    const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    const tools = context.mcp
      .tools()
      .map((tool) => ({ tool, score: score(words, `${tool.server} ${tool.name} ${tool.description}`) }))
      .filter((item) => item.score > 0 || words.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHES);
    const skills = context
      .skills()
      .map((skill) => ({ skill, score: score(words, `${skill.name} ${skill.description}`) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const parts: string[] = [];
    for (const { tool } of tools) {
      parts.push(`mcp tool: server="${tool.server}" tool="${tool.name}"\n${tool.description}\ninput schema: ${JSON.stringify(tool.inputSchema)}`);
    }
    for (const { skill } of skills) parts.push(`skill: ${skill.name}\n${skill.description}`);
    const unavailable = [...context.mcp.servers.values()].filter((state) => state.status !== "ready" && state.status !== "disabled");
    if (unavailable.length) {
      parts.push(`Not available: ${unavailable.map((state) => `${state.entry.name} (${state.status}${state.error ? `: ${state.error}` : ""})`).join(", ")}`);
    }
    return {
      content: parts.length ? parts.join("\n\n") : "Nothing matched. No connected MCP server or skill covers this.",
      note: `${tools.length} tools, ${skills.length} skills`,
    };
  },
};

export const mcpCall: Tool<{ server: string; tool: string; arguments?: Record<string, unknown> }> = {
  name: "mcp_call",
  description: "Call a tool on a connected MCP server. Find the server, tool name and input schema with capability_search first.",
  schema: {
    type: "object",
    properties: {
      server: { type: "string" },
      tool: { type: "string" },
      arguments: { type: "object", description: "Arguments matching the tool's input schema." },
    },
    required: ["server", "tool"],
  },
  kind: "mcp",
  label: (input) => `${input.server}.${input.tool}`,
  validate: (input) => checkFields(input, { server: "string", tool: "string", arguments: "object?" }),
  async run(input, context) {
    const result = await context.mcp.call(input.server, input.tool, input.arguments ?? {}, context.signal);
    const blocks = (result.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    const text = blocks
      .map((block) => (block.type === "text" ? block.text : `[${block.type}${block.mimeType ? ` ${block.mimeType}` : ""}]`))
      .join("\n");
    const structured = result.structuredContent ? `\n${JSON.stringify(result.structuredContent, null, 2)}` : "";
    return { content: (text || "(no content)") + structured, isError: result.isError === true };
  },
};

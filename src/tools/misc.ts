import { checkFields, type Tool } from "./types";

const PAGE_CHARS = 20_000;

export const readToolResult: Tool<{ id: string; offset?: number; length?: number; pattern?: string }> = {
  name: "read_tool_result",
  description:
    "Read the full stored output of an earlier tool call, including calls from before a compaction or a resume. Use offset and length to page through it, or pattern to show only matching lines.",
  schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The tool_use id of the earlier call." },
      offset: { type: "number", description: "Character offset to start at." },
      length: { type: "number", description: `Characters to return. Default ${PAGE_CHARS}.` },
      pattern: { type: "string", description: "Only return lines containing this text." },
    },
    required: ["id"],
  },
  kind: "result",
  readOnly: true,
  label: (input, done) => `${done ? "Read" : "Reading"} stored output ${input.id.slice(-6)}`,
  validate: (input) => checkFields(input, { id: "string", offset: "number?", length: "number?", pattern: "string?" }),
  async run(input, context) {
    const record = context.session.tools.get(input.id);
    if (!record) return { content: `No stored result with id ${input.id}.`, isError: true };
    let text = record.output;
    if (input.pattern) {
      text = text
        .split("\n")
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => line.includes(input.pattern!))
        .map(([number, line]) => `${number}: ${line}`)
        .join("\n");
    }
    const offset = Math.max(0, input.offset ?? 0);
    const length = Math.max(100, input.length ?? PAGE_CHARS);
    const page = text.slice(offset, offset + length);
    const rest = text.length - offset - page.length;
    return {
      content:
        (page || "(nothing at this offset)") +
        (rest > 0 ? `\n\n[${rest} more characters. Continue at offset ${offset + page.length}.]` : ""),
    };
  },
};

export const askUser: Tool<{
  question: string;
  options?: { label: string; description?: string }[];
  multiple?: boolean;
}> = {
  name: "ask_user_question",
  description:
    "Ask the user a question and wait for the answer. Offer 2 to 5 options when the choices are known; the user can always type their own answer. Use only for decisions you cannot settle from the workspace.",
  schema: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, description: { type: "string" } },
          required: ["label"],
        },
      },
      multiple: { type: "boolean", description: "Allow picking more than one option." },
    },
    required: ["question"],
  },
  kind: "question",
  readOnly: true,
  label: (input, done) => `${done ? "Asked" : "Asking"}: ${input.question}`,
  validate: (input) => checkFields(input, { question: "string", options: "array?", multiple: "boolean?" }),
  async run(input, context) {
    if (!context.interactive)
      return {
        content: "No one can answer: clue is running non-interactively. Decide yourself and say what you assumed.",
        isError: true,
      };
    const answer = await context.ask({
      question: input.question,
      options: input.options ?? [],
      multiple: input.multiple,
    });
    if (answer === null) return { content: "The user dismissed the question without answering.", isError: true };
    return { content: `The user answered: ${answer}`, note: answer.slice(0, 60) };
  },
};

export const subagent: Tool<{ task: string; description: string }> = {
  name: "subagent",
  description:
    "Hand a self-contained task to another agent with a fresh context, such as a broad search across the codebase or researching one question. It has the same tools except subagent and ask_user_question. You get back only its final answer, so say exactly what to return.",
  schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Three to six words for the transcript." },
      task: { type: "string", description: "The complete task, with everything the agent needs to know." },
    },
    required: ["description", "task"],
  },
  kind: "subagent",
  label: (input, done) => `${done ? "Subagent finished" : "Subagent"}: ${input.description}`,
  validate: (input) => checkFields(input, { task: "string", description: "string" }),
  run: (input, context) => context.subagent(input.task, input.description, context.signal),
};

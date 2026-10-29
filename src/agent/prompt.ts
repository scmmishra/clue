// clue's system prompt lives in prompts/system.md. Bun embeds it in the binary
// at build time, so nothing is read from disk at launch.
//
// It must stay byte-identical across sessions so Claude caches it. Anything that
// changes (folder, git state, date, instructions) goes in the first user message
// instead. See context.ts.
//
// Adapted from fx's system_prompt.md (https://github.com/vercel-labs/fx),
// licensed under Apache-2.0. See NOTICE.

import systemPrompt from "../../prompts/system.md" with { type: "text" };

export const SYSTEM_PROMPT = systemPrompt.trimEnd();

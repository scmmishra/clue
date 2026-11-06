import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, paths } from "../config";
import { projectKey } from "../session";

// A repo's dream lives in two files under ~/.clue/dreams. The JSON file holds everything: the
// approved memories with their evidence, proposals waiting for review, rejected proposals, and
// how far each session was read. The Markdown file lists only the approved memories, and clue
// writes it from the JSON file. Nothing loads either file into a session yet.

// A message that supports a memory, as the review screen shows it.
export type Evidence = { at: number | null; text: string };

export type Memory = { text: string; evidence: Evidence[]; approvedAt: number };

// `replaces` is the text of an approved memory this one would take the place of.
export type Proposal = { text: string; evidence: Evidence[]; replaces: string | null };

export type Dream = {
  repo: string;
  memories: Memory[];
  pending: Proposal[];
  // The text of each rejected proposal, so later dreams don't propose it again.
  rejected: string[];
  // Per session file, the index of the last typed message a dream read.
  read: Record<string, number>;
};

const files = (repo: string) => {
  const key = projectKey(repo);
  return { json: join(paths.dreams, `${key}.json`), markdown: join(paths.dreams, `${key}.md`) };
};

export function loadDream(repo: string): Dream {
  const { json } = files(repo);
  const empty: Dream = { repo, memories: [], pending: [], rejected: [], read: {} };
  if (!existsSync(json)) return empty;
  return { ...empty, ...(JSON.parse(readFileSync(json, "utf8")) as Partial<Dream>), repo };
}

export function dreamMarkdown(dream: Dream) {
  const lines = [`# Dream for ${dream.repo}`, "", ...dream.memories.map((memory) => `- ${memory.text}`)];
  return `${lines.join("\n")}\n`;
}

export function saveDream(dream: Dream) {
  ensureDir(paths.dreams);
  const { json, markdown } = files(dream.repo);
  writeFileSync(json, `${JSON.stringify(dream, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(markdown, dreamMarkdown(dream), { mode: 0o600 });
  return markdown;
}

// Applies the user's verdict on the first pending proposal.
export function decide(dream: Dream, verdict: "approve" | "reject" | "skip", text?: string) {
  const proposal = dream.pending.shift();
  if (!proposal) return;
  if (verdict === "skip") return dream.pending.push(proposal);
  if (verdict === "reject") return dream.rejected.push(proposal.text);
  if (proposal.replaces) dream.memories = dream.memories.filter((memory) => memory.text !== proposal.replaces);
  dream.memories.push({ text: text ?? proposal.text, evidence: proposal.evidence, approvedAt: Date.now() });
}

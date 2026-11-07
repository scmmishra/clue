import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, paths } from "../config";
import { projectKey } from "../session";

// A repo's dream lives in two files under ~/.clue/dreams. The JSON file holds everything: the
// approved memories with their evidence, proposals waiting for review, rejected proposals, and
// how far each session was read. The Markdown file lists only the approved memories, and clue
// writes it from the JSON file. A session in the repo loads the Markdown file's list.

// A message that supports a memory, as the review screen shows it, with the end of what the
// agent said before it. Dreams before the review screen showed it have no `before`.
export type Evidence = { at: number | null; text: string; before?: string };

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

// The approved memories, as the Markdown file lists them, for a session's context.
export function dreamMemories(repo: string): string[] {
  try {
    return readFileSync(files(repo).markdown, "utf8")
      .split("\n")
      .flatMap((line) => (line.startsWith("- ") && line.slice(2).trim() ? [line.slice(2).trim()] : []));
  } catch {
    return [];
  }
}

export function saveDream(dream: Dream) {
  ensureDir(paths.dreams);
  const { json, markdown } = files(dream.repo);
  writeFileSync(json, `${JSON.stringify(dream, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(markdown, dreamMarkdown(dream), { mode: 0o600 });
  return markdown;
}

export type Verdict = "approve" | "reject" | "skip";

// Applies the user's verdicts on pending proposals. A skipped proposal, or one with no verdict,
// stays pending for the next review.
export function settle(dream: Dream, verdicts: Map<Proposal, Verdict>) {
  const pending: Proposal[] = [];
  for (const proposal of dream.pending) {
    const verdict = verdicts.get(proposal);
    if (verdict === "reject") dream.rejected.push(proposal.text);
    else if (verdict !== "approve") pending.push(proposal);
    else {
      if (proposal.replaces) dream.memories = dream.memories.filter((memory) => memory.text !== proposal.replaces);
      dream.memories.push({ text: proposal.text, evidence: proposal.evidence, approvedAt: Date.now() });
    }
  }
  dream.pending = pending;
}

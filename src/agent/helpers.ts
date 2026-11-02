import type { HelperSetting } from "../config";
import { advisorOf, KNOWN_MODELS, modelLabel, resolveModel } from "./models";

// A helper is the model behind a small side task: the auto-mode reviewer, or picking
// what /copy copies. Its setting picks a decision model on OpenRouter or a Claude model.
// Without a setting, the helper uses its default decision model when OPENROUTER_API_KEY
// is set, and Claude Haiku otherwise. Haiku also takes over when a helper fails.

export type Helper = { provider: "anthropic" | "openrouter"; model: string };

// Short names that settings accept for decision models. Each points to the latest version.
export const DECISION_ALIASES: Record<string, string> = {
  jev: "typesafe/jev-1.14",
  decider: "perplexity/pplx-decider-v1.2",
};

// Each helper's decision model when its setting names none. Benchmarks picked them:
// for review, the model that held none of the user's actions and caught every planted
// bad one; for copy, the one that picked exactly the right blocks most often.
export const DEFAULT_DECISION_MODELS = {
  review: DECISION_ALIASES.jev,
  copy: DECISION_ALIASES.decider,
} as const;

export const FALLBACK_MODEL = "claude-haiku-5-5";

// Throws when the setting can't work, which counts as a broken helper.
// An OpenRouter model id has a vendor before a slash, and a Claude model doesn't.
export function chooseHelper(setting: HelperSetting = {}, decisionModel: string, openrouterKey?: string): Helper {
  const model = setting.model && (DECISION_ALIASES[setting.model] ?? setting.model);
  const onOpenRouter = model?.includes("/");
  const provider = setting.provider ?? (onOpenRouter || (!model && openrouterKey) ? "openrouter" : "anthropic");
  if (provider === "openrouter") {
    if (!openrouterKey) throw new Error("OPENROUTER_API_KEY isn't set");
    if (model && !onOpenRouter) throw new Error(`OpenRouter can't run ${model}`);
    return { provider, model: model ?? decisionModel };
  }
  if (provider !== "anthropic") throw new Error(`${provider} isn't a helper provider`);
  const id = resolveModel(model ?? "haiku");
  if (!KNOWN_MODELS.includes(id) || advisorOf(id)) throw new Error(`${model} isn't a Claude model`);
  return { provider, model: id };
}

// The name clue shows for a helper: its alias, the model after the vendor, or the Claude short name.
export function helperName({ provider, model }: Helper) {
  if (provider === "anthropic") return modelLabel(model).split(" ")[0];
  return Object.keys(DECISION_ALIASES).find((alias) => DECISION_ALIASES[alias] === model) ?? model.split("/").at(-1)!;
}

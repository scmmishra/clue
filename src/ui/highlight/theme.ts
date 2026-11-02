import { style } from "../ansi";
import type { Token, TokenKind } from "./engine";

// Each token kind's color. Every style resets only what it set, so a token never
// clears the styles around the code block.
const COLORS: Record<TokenKind, (text: string) => string> = {
  keyword: style.violet,
  literal: style.orange,
  number: style.orange,
  string: style.green,
  comment: style.faint,
  type: style.blue,
  tag: style.blue,
  attribute: style.orange,
  meta: style.muted,
  inserted: style.green,
  deleted: style.red,
};

export type Paint = (tokens: Token[]) => string;

export const paint: Paint = (tokens) => tokens.map(([kind, text]) => (kind ? COLORS[kind](text) : text)).join("");

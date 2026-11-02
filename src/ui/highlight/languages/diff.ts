import type { Language } from "../engine";
import { words } from "./common";

// A diff is colored by whole lines: headers, added lines and removed lines.
const diff: Language = {
  names: words("diff patch udiff"),
  lines: [
    ["meta", /^(?:diff |index |@@|\+\+\+ |--- |new file|deleted file|similarity|rename )/],
    ["inserted", /^\+/],
    ["deleted", /^-/],
  ],
};

export const DIFF = [diff];

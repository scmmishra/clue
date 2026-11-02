import type { Language } from "../engine";
import { C_LIKE } from "./c-like";
import { DATA } from "./data";
import { DIFF } from "./diff";
import { MARKUP } from "./markup";
import { SCRIPTING } from "./scripting";

// Every language clue colors. Each one's first name keys its entry in precompiled.ts.
export const LANGUAGES: Language[] = [...C_LIKE, ...SCRIPTING, ...DATA, ...MARKUP, ...DIFF];

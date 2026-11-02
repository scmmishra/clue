import { compile, lexLine, type Compiled, type Language, type LineResult } from "./engine";
import { LANGUAGES } from "./languages";
import { PRECOMPILED } from "./precompiled";
import { paint as ansi, type Paint } from "./theme";

// Highlights code for the terminal. Each language compiles the first time it appears,
// so languages a reply never uses cost nothing at startup.

const byName = new Map<string, Language>();
for (const language of LANGUAGES) for (const name of language.names) byName.set(name, language);

const compiled = new Map<Language, Compiled>();

function find(name: string): Compiled | undefined {
  const key = name.toLowerCase();
  // A fence can name a file, such as `app/models/user.rb`. Its extension picks the language.
  const language = byName.get(key) ?? byName.get(key.slice(key.lastIndexOf(".") + 1));
  if (!language) return undefined;
  let result = compiled.get(language);
  if (!result) {
    result = compile(language, PRECOMPILED[language.names[0]]);
    compiled.set(language, result);
  }
  return result;
}

// While a reply streams, its open code block is lexed again on every update. The cache
// keeps finished lines, so only the line still arriving is lexed again.
const CACHE_LIMIT = 5000;
const cache = new Map<string, LineResult>();

// Returns one colored string per line of `code`. An unknown language comes back uncolored.
export function highlight(code: string, language: string | undefined, paint: Paint = ansi): string[] {
  const lines = code.split("\n");
  const lexer = language ? find(language) : undefined;
  if (!lexer) return lines;
  const name = lexer.language.names[0];
  let state = "";
  return lines.map((line) => {
    const key = `${name}\0${state}\0${line}`;
    let result = cache.get(key);
    if (!result) {
      result = lexLine(lexer, line, state, find);
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(key, result);
    }
    state = result.state;
    return paint(result.tokens);
  });
}

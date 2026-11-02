// A small rule-based lexer. Each language is data (see languages/). compile() joins its
// patterns into one sticky regex, so each token costs one regex call. Lines are lexed one
// at a time, and a state string carries open comments and strings to the next line.

export type TokenKind =
  | "keyword"
  | "literal"
  | "number"
  | "string"
  | "comment"
  | "type"
  | "tag"
  | "attribute"
  | "meta"
  | "inserted"
  | "deleted";

// A token that can run to a later line, such as a block comment or a multi-line string.
export type Region = {
  kind: TokenKind;
  start: RegExp;
  end: RegExp;
  // A backslash hides the next character from `end`.
  escapes?: boolean;
  // Without this, an unclosed region ends with its line.
  multiline?: boolean;
  // The text between `start` and `end` is lexed as this language, such as JS in <script>.
  embed?: string;
};

export type Language = {
  names: string[];
  keywords?: string[];
  literals?: string[];
  types?: string[];
  // A word that starts with a capital letter is a type, such as a class or a constant.
  capitalTypes?: boolean;
  // Keywords and rules match in any case. SQL uses this.
  ignoreCase?: boolean;
  // Patterns tried before words, in order. Each colors its whole match.
  rules?: [TokenKind, RegExp][];
  regions?: Region[];
  // A line that matches one of these is colored whole. In a language with nothing
  // else, such as diff, other lines stay uncolored.
  lines?: [TokenKind, RegExp][];
  word?: RegExp;
};

export type Token = [kind: TokenKind | null, text: string];
export type LineResult = { tokens: Token[]; state: string };

type Piece = { group: number; region?: number; kind?: TokenKind; word?: true; number?: true };

export type Compiled = {
  language: Language;
  scanner: RegExp;
  pieces: Piece[];
  closers: RegExp[];
  lines: [TokenKind, RegExp][];
  linesOnly: boolean;
  words: Map<string, TokenKind>;
};

export type Resolve = (name: string) => Compiled | undefined;

const DEFAULT_WORD = /[A-Za-z_$][\w$]*/;
// Hex, binary, octal, decimal and exponent forms. A trailing unit or suffix (10px, 1u8, 2n) stays with the number.
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[A-Za-z%]*/;
// One whitespace run or one other character. Single characters keep region starts reachable.
const OTHER = /\s+|[\s\S]/;
const CAPITAL = /^[A-Z]/;

const groupCount = (source: string) => new RegExp(`${source}|`).exec("")!.length - 1;

// The regexes a language compiles to. precompiled.ts holds them as literals, written by
// scripts/highlight.ts. An AOT build compiles a literal to machine code, but a regex built
// with new RegExp() runs in its interpreter, and resume is slower by about 3 ms for a
// session with 3,600 lines of code.
export type Patterns = Pick<Compiled, "scanner" | "closers" | "pieces">;

// Builds a language's regexes from its definition. Only the generator, the test that
// keeps precompiled.ts current and a language missing from it use this.
export function build(language: Language): Patterns {
  const sources: string[] = [];
  const pieces: Piece[] = [];
  let group = 1;
  const add = (source: string, piece: Omit<Piece, "group">) => {
    sources.push(`(${source})`);
    pieces.push({ group, ...piece });
    group += 1 + groupCount(source);
  };
  (language.regions ?? []).forEach((region, index) => add(region.start.source, { region: index }));
  for (const [kind, pattern] of language.rules ?? []) add(pattern.source, { kind });
  add(NUMBER.source, { number: true });
  add((language.word ?? DEFAULT_WORD).source, { word: true });
  add(OTHER.source, {});
  return {
    scanner: new RegExp(sources.join("|"), language.ignoreCase ? "iy" : "y"),
    pieces,
    closers: (language.regions ?? []).map(
      (region) => new RegExp(`${region.escapes ? "\\\\[\\s\\S]|" : ""}(?:${region.end.source})`, "g"),
    ),
  };
}

export function compile(language: Language, patterns: Patterns = build(language)): Compiled {
  const words = new Map<string, TokenKind>();
  const fold = (word: string) => (language.ignoreCase ? word.toLowerCase() : word);
  for (const word of language.types ?? []) words.set(fold(word), "type");
  for (const word of language.literals ?? []) words.set(fold(word), "literal");
  for (const word of language.keywords ?? []) words.set(fold(word), "keyword");

  return {
    language,
    ...patterns,
    lines: language.lines ?? [],
    linesOnly: Boolean(language.lines) && !language.regions && !language.rules && words.size === 0,
    words,
  };
}

// Finds where a region's end starts and stops, from `from`, skipping escaped characters.
function findEnd(compiled: Compiled, region: number, line: string, from: number, to: number) {
  const closer = compiled.closers[region];
  const escapes = compiled.language.regions![region].escapes;
  closer.lastIndex = from;
  for (let match = closer.exec(line); match && match.index < to; match = closer.exec(line)) {
    if (escapes && match[0].length === 2 && match[0][0] === "\\") continue;
    return { start: match.index, end: Math.min(match.index + match[0].length, to) };
  }
  return null;
}

// Lexes line[from, to) starting in `state`. Returns the tokens and the state for the next line.
export function lexLine(compiled: Compiled, line: string, state: string, resolve: Resolve, from = 0, to = line.length) {
  const tokens: Token[] = [];
  const push = (kind: TokenKind | null, text: string) => {
    if (!text) return;
    const last = tokens.at(-1);
    if (last && last[0] === kind) last[1] += text;
    else tokens.push([kind, text]);
  };

  if (from === 0 && to === line.length && !state) {
    for (const [kind, pattern] of compiled.lines) {
      if (pattern.test(line)) return { tokens: [[kind, line] as Token], state: "" };
    }
    if (compiled.linesOnly) return { tokens: [[null, line] as Token], state: "" };
  }

  let position = from;
  // Continues a region left open by the line before, then returns to normal lexing.
  const resume = (open: string): string => {
    const split = open.indexOf(":");
    const index = Number(split === -1 ? open : open.slice(0, split));
    const region = compiled.language.regions![index];
    if (region.embed) {
      const inner = resolve(region.embed);
      const end = findEnd(compiled, index, line, position, to);
      const stop = end ? end.start : to;
      const innerState = split === -1 ? "" : open.slice(split + 1);
      if (inner) {
        const result = lexLine(inner, line, innerState, resolve, position, stop);
        for (const [kind, text] of result.tokens) push(kind, text);
        if (!end) return `${index}:${result.state}`;
      } else {
        push(null, line.slice(position, stop));
        if (!end) return `${index}:`;
      }
      push(region.kind, line.slice(end.start, end.end));
      position = end.end;
      return "";
    }
    const end = findEnd(compiled, index, line, position, to);
    if (!end) {
      push(region.kind, line.slice(position, to));
      position = to;
      return region.multiline ? String(index) : "";
    }
    push(region.kind, line.slice(position, end.end));
    position = end.end;
    return "";
  };

  if (state) {
    const next = resume(state);
    if (next) return { tokens, state: next };
  }

  const { scanner, pieces, words } = compiled;
  while (position < to) {
    scanner.lastIndex = position;
    const match = scanner.exec(line)!;
    const piece = pieces.find((candidate) => match[candidate.group] !== undefined)!;
    const text = match[0].slice(0, to - position);
    // A pattern that matches nothing would never move forward.
    if (!text) {
      push(null, line[position]);
      position += 1;
      continue;
    }
    if (piece.region !== undefined) {
      const region = compiled.language.regions![piece.region];
      push(region.kind, text);
      position += text.length;
      const next = resume(region.embed ? `${piece.region}:` : String(piece.region));
      if (next) return { tokens, state: next };
      continue;
    }
    if (piece.word) {
      const kind = words.get(compiled.language.ignoreCase ? text.toLowerCase() : text);
      push(kind ?? (compiled.language.capitalTypes && CAPITAL.test(text) ? "type" : null), text);
    } else if (piece.number) push("number", text);
    else push(piece.kind ?? null, text);
    position += text.length;
  }
  return { tokens, state: "" };
}

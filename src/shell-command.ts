// Reads a shell command the way the shell does, for the permission check. It handles
// only plain words, quotes, the separators below and redirects that discard output.
// Anything else, such as a redirect to a file or a substitution, returns null: the
// check can't know what such a command does.

const SEPARATORS = ["&&", "||", ";", "|"];

// 2>&1, >&2, >/dev/null, 2>/dev/null and &>/dev/null. They only move output to the
// screen or drop it, so they're left out of the words.
const HARMLESS_REDIRECT = /(?:[12]?>&[12]|(?:[12]|&)?>>?[ \t]*\/dev\/null)(?=[ \t;&|]|$)/y;

// Outside quotes. Includes zsh's ^ and # globs and a single &, which runs what follows.
const UNSUPPORTED = /[\x00-\x08\x0a-\x1f\x7f<>()$`\\{}^#!&]/;
const UNSUPPORTED_IN_DOUBLE_QUOTES = /[$`!]/;
// Inside double quotes, a backslash escapes only these. Before any other character it stays.
const ESCAPABLE_IN_DOUBLE_QUOTES = '$`"\\';
// The last exit code. It's always a number, so it can't hide what a command does.
const EXIT_CODE = "$?";
// What may follow a ~ at the start of a word for it to mean the home folder.
const HOME_PATH_END = /^([/ \t;&|]|)$/;

// The text of the double-quoted string that starts at `start`, and the index of its closing
// quote. Null when the string doesn't close or holds a substitution.
function readDoubleQuoted(text: string, start: number): { text: string; end: number } | null {
  let quoted = "";
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '"') return { text: quoted, end: index };
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined || next === "\n") return null;
      if (ESCAPABLE_IN_DOUBLE_QUOTES.includes(next)) {
        quoted += next;
        index += 1;
      } else quoted += char;
      continue;
    }
    if (text.startsWith(EXIT_CODE, index)) {
      quoted += EXIT_CODE;
      index += EXIT_CODE.length - 1;
      continue;
    }
    if (UNSUPPORTED_IN_DOUBLE_QUOTES.test(char)) return null;
    quoted += char;
  }
  return null;
}

// The words of each command, or null when the text can't be read with certainty.
export function parseCommand(text: string): string[][] | null {
  const commands: string[][] = [[]];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) commands.at(-1)!.push(word);
    word = "";
    inWord = false;
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "'") {
      const end = text.indexOf(char, index + 1);
      if (end === -1) return null;
      word += text.slice(index + 1, end);
      inWord = true;
      index = end;
      continue;
    }
    if (char === '"') {
      const quoted = readDoubleQuoted(text, index);
      if (!quoted) return null;
      word += quoted.text;
      inWord = true;
      index = quoted.end;
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    HARMLESS_REDIRECT.lastIndex = index;
    if (!inWord && HARMLESS_REDIRECT.test(text)) {
      index = HARMLESS_REDIRECT.lastIndex - 1;
      continue;
    }
    if (text.startsWith(EXIT_CODE, index)) {
      word += EXIT_CODE;
      inWord = true;
      index += EXIT_CODE.length - 1;
      continue;
    }
    const separator = SEPARATORS.find((item) => text.startsWith(item, index));
    if (separator) {
      endWord();
      if (commands.at(-1)!.length === 0) return null;
      commands.push([]);
      index += separator.length - 1;
      continue;
    }
    // At the start of a word, zsh reads = as a path lookup. ~ is the home folder, and the
    // word keeps it unexpanded. Other forms, such as ~user or zsh's ~+ and ~1, name other folders.
    if (UNSUPPORTED.test(char) || (char === "=" && !inWord)) return null;
    if (char === "~" && !inWord && !HOME_PATH_END.test(text[index + 1] ?? "")) return null;
    word += char;
    inWord = true;
  }

  endWord();
  if (commands.at(-1)!.length > 0) return commands;
  return commands.length === 1 ? [] : null;
}

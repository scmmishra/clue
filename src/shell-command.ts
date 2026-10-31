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
const UNSUPPORTED_IN_DOUBLE_QUOTES = /[$`\\!]/;
// The last exit code. It's always a number, so it can't hide what a command does.
const EXIT_CODE = "$?";

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
    if (char === "'" || char === '"') {
      const end = text.indexOf(char, index + 1);
      if (end === -1) return null;
      const quoted = text.slice(index + 1, end);
      if (char === '"' && UNSUPPORTED_IN_DOUBLE_QUOTES.test(quoted.replaceAll(EXIT_CODE, ""))) return null;
      word += quoted;
      inWord = true;
      index = end;
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
    // At the start of a word, ~ is a home path and zsh reads = as a path lookup.
    if (UNSUPPORTED.test(char) || ((char === "~" || char === "=") && !inWord)) return null;
    word += char;
    inWord = true;
  }

  endWord();
  if (commands.at(-1)!.length > 0) return commands;
  return commands.length === 1 ? [] : null;
}

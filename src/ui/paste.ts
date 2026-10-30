// Finds image paths in pasted text, such as a file dragged into the terminal or copied in
// Finder. Other files stay as text: the model reads them with its tools.

export type PathToken = { start: number; end: number; path: string };

const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;
const SENTENCE_END = ",.;:!?";

// Where the word at `start` ends, reading quotes and backslash escapes.
function wordEnd(text: string, start: number) {
  let quote = "";
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (quote) quote = char === quote ? "" : quote;
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) return index;
  }
  return text.length;
}

// The path in one word, without its quotes and escapes, and where sentence punctuation starts.
function readWord(word: string) {
  let path = "";
  let quote = "";
  let keptPath = 0;
  let keptEnd = 0;
  for (let index = 0; index < word.length; index++) {
    const char = word[index];
    const escaped = char === "\\" && index + 1 < word.length;
    if (escaped) path += word[++index];
    else if (quote) {
      if (char === quote) quote = "";
      else path += char;
    } else if (char === '"' || char === "'") quote = char;
    else path += char;
    if (escaped || quote || !SENTENCE_END.includes(char)) {
      keptPath = path.length;
      keptEnd = index + 1;
    }
  }
  return { path: path.slice(0, keptPath), end: keptEnd };
}

export function findImagePaths(text: string): PathToken[] {
  const found: PathToken[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index += 1;
      continue;
    }
    const end = wordEnd(text, index);
    const lead = text[index] === "@" ? 1 : 0;
    const word = readWord(text.slice(index + lead, end));
    if (word.path && !word.path.startsWith("@") && IMAGE_PATH.test(word.path)) {
      found.push({ start: index, end: index + lead + word.end, path: word.path });
    }
    index = end;
  }
  return found;
}

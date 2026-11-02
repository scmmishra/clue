import type { Region, TokenKind } from "../engine";

// Splits a space-separated word list, so keyword lists stay readable.
export const words = (list: string) => list.split(/\s+/).filter(Boolean);

export const DOUBLE_QUOTED: Region = { kind: "string", start: /"/, end: /"/, escapes: true };
export const SINGLE_QUOTED: Region = { kind: "string", start: /'/, end: /'/, escapes: true };
export const BLOCK_COMMENT: Region = { kind: "comment", start: /\/\*/, end: /\*\//, multiline: true };
export const TRIPLE_DOUBLE: Region = { kind: "string", start: /"""/, end: /"""/, escapes: true, multiline: true };

export const SLASH_COMMENT: [TokenKind, RegExp] = ["comment", /\/\/.*/];
// A # that starts a word, so ${#x} and $# in shells are not comments.
export const HASH_COMMENT: [TokenKind, RegExp] = ["comment", /(?<!\S)#.*/];
export const ANNOTATION: [TokenKind, RegExp] = ["meta", /@[A-Za-z_][\w.]*/];

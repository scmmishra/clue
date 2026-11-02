import type { Language, Region, TokenKind } from "../engine";
import { BLOCK_COMMENT, DOUBLE_QUOTED, SINGLE_QUOTED, SLASH_COMMENT, words } from "./common";

// HTML, XML, Vue, ERB and stylesheets. A tag is a region, and the text inside it is lexed
// as `tag-attributes`, so attribute names only get colored inside tags.

const attributes: Language = {
  names: ["tag-attributes"],
  word: /[^\s"'=<>\/]+/,
  regions: [
    { ...DOUBLE_QUOTED, escapes: false, multiline: true },
    { ...SINGLE_QUOTED, escapes: false, multiline: true },
  ],
  rules: [["attribute", /[^\s"'=<>\/]+(?=\s*=)/]],
};

const COMMENT: Region = { kind: "comment", start: /<!--/, end: /-->/, multiline: true };
const TAG: Region = {
  kind: "tag",
  start: /<\/?[A-Za-z][\w:.-]*/,
  end: /\/?>/,
  multiline: true,
  embed: "tag-attributes",
};
const DOCTYPE: Region = { kind: "meta", start: /<!(?:DOCTYPE|doctype)/, end: />/ };
const ENTITY: ["literal", RegExp] = ["literal", /&(?:#\d+|#x[\da-fA-F]+|\w+);/];

// <script> and <style> bodies are lexed as code. Vue and Svelte use TypeScript and SCSS,
// since those also read plain JS and CSS.
const blocks = (script: string, stylesheet: string): Region[] => [
  { kind: "tag", start: /<script\b[^>]*>/, end: /<\/script\s*>/, multiline: true, embed: script },
  { kind: "tag", start: /<style\b[^>]*>/, end: /<\/style\s*>/, multiline: true, embed: stylesheet },
];

const html: Language = {
  names: words("html htm xhtml"),
  regions: [COMMENT, DOCTYPE, ...blocks("js", "css"), TAG],
  rules: [ENTITY],
};

const vue: Language = {
  names: words("vue svelte"),
  regions: [
    COMMENT,
    ...blocks("ts", "scss"),
    { kind: "meta", start: /\{\{/, end: /\}\}/, multiline: true, embed: "ts" },
    TAG,
  ],
  rules: [ENTITY],
};

const erb: Language = {
  names: words("erb rhtml html+erb eruby"),
  regions: [
    { kind: "meta", start: /<%[=#-]?/, end: /-?%>/, multiline: true, embed: "ruby" },
    COMMENT,
    DOCTYPE,
    ...blocks("js", "css"),
    TAG,
  ],
  rules: [ENTITY],
};

const xml: Language = {
  names: words("xml svg xsd xsl xslt plist rss atom wsdl"),
  regions: [
    COMMENT,
    { kind: "string", start: /<!\[CDATA\[/, end: /\]\]>/, multiline: true },
    { ...TAG, start: /<[?\/]?[A-Za-z][\w:.-]*/, end: /[?\/]?>/ },
  ],
  rules: [ENTITY],
};

const STYLESHEET_RULES: [TokenKind, RegExp][] = [
  ["keyword", /@[\w-]+/],
  ["keyword", /!important/],
  ["number", /#[\da-fA-F]{3,8}\b/],
  ["type", /[.#][A-Za-z_-][\w-]*/],
  ["attribute", /--?[A-Za-z_][\w-]*(?=\s*:)|[A-Za-z_][\w-]*(?=\s*:(?!:))/],
];

const css: Language = {
  names: words("css"),
  word: /-?[A-Za-z_][\w-]*/,
  regions: [BLOCK_COMMENT, { kind: "string", start: /url\(/, end: /\)/ }, DOUBLE_QUOTED, SINGLE_QUOTED],
  rules: STYLESHEET_RULES,
};

const scss: Language = {
  ...css,
  names: words("scss sass less"),
  rules: [SLASH_COMMENT, ["attribute", /\$[\w-]+/], ...STYLESHEET_RULES],
};

export const MARKUP = [attributes, html, vue, erb, xml, css, scss];

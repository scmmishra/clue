import type { Language } from "../engine";
import { BLOCK_COMMENT, DOUBLE_QUOTED, HASH_COMMENT, SLASH_COMMENT, words } from "./common";

// Data and query languages: JSON, YAML, TOML, SQL.

const json: Language = {
  names: words("json jsonc json5 jsonl ndjson geojson"),
  literals: words("true false null"),
  regions: [BLOCK_COMMENT],
  rules: [["attribute", /"(?:[^"\\]|\\.)*"(?=\s*:)/], ["string", /"(?:[^"\\]|\\.)*"?/], SLASH_COMMENT],
};

// A YAML quote only opens a string at the start of a value, so the apostrophe in don't stays text.
const YAML_QUOTE_START = /(?<![^\s[{,:-])/.source;

const yaml: Language = {
  names: words("yaml yml"),
  literals: words("true false null yes no on off True False Null TRUE FALSE NULL"),
  word: /[A-Za-z_][\w-]*/,
  regions: [
    { ...DOUBLE_QUOTED, start: new RegExp(`${YAML_QUOTE_START}"`) },
    { kind: "string", start: new RegExp(`${YAML_QUOTE_START}'`), end: /'/ },
  ],
  rules: [
    HASH_COMMENT,
    ["meta", /^(?:---|\.\.\.)(?=\s|$)/],
    ["attribute", /[\w.\/$-]+(?=\s*:(?:\s|$))/],
    ["meta", /[&*][\w-]+|!!?[\w\/]+/],
  ],
};

const toml: Language = {
  names: words("toml ini cfg conf properties editorconfig"),
  literals: words("true false"),
  regions: [
    { kind: "string", start: /"""/, end: /"""/, escapes: true, multiline: true },
    { kind: "string", start: /'''/, end: /'''/, multiline: true },
    DOUBLE_QUOTED,
    { kind: "string", start: /'/, end: /'/ },
  ],
  rules: [
    ["comment", /[#;].*/],
    ["type", /^\s*\[\[?[^\]]*\]\]?/],
    ["attribute", /[\w.-]+(?=\s*=)/],
  ],
};

const sql: Language = {
  names: words("sql psql postgres postgresql pgsql plpgsql mysql sqlite tsql"),
  ignoreCase: true,
  keywords: words(`
    add all alter and as asc begin between by cascade case check column commit constraint create cross
    database default delete desc distinct drop else end exists explain foreign from full function grant group
    having if ilike in index inner insert intersect into is join key left like limit materialized natural not
    offset on or order outer over partition primary procedure recursive references rename replace returning
    returns revoke right rollback schema select set table then to transaction trigger truncate union unique
    update using values view when where window with`),
  literals: words("true false null"),
  types: words(`
    bigint bigserial boolean bool bytea char date decimal double float int integer interval json jsonb numeric
    real serial smallint text time timestamp timestamptz uuid varchar`),
  regions: [BLOCK_COMMENT, { kind: "string", start: /'/, end: /'/ }, { kind: "attribute", start: /"/, end: /"/ }],
  rules: [
    ["comment", /--.*/],
    ["attribute", /\$\d+/],
  ],
};

export const DATA = [json, yaml, toml, sql];

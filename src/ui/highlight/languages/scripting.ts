import type { Language } from "../engine";
import { ANNOTATION, DOUBLE_QUOTED, HASH_COMMENT, SINGLE_QUOTED, TRIPLE_DOUBLE, words } from "./common";

// Languages with # comments, plus Lua, shells and build files.

const ruby: Language = {
  names: words("ruby rb rake gemspec podspec rbi"),
  keywords: words(`
    alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo
    rescue retry return super then undef unless until when while yield
    attr_accessor attr_reader attr_writer extend include lambda loop prepend private proc protected public
    raise require require_relative`),
  literals: words("true false nil self __FILE__ __LINE__ __method__"),
  capitalTypes: true,
  word: /[A-Za-z_][\w]*[?!]?/,
  regions: [
    { kind: "comment", start: /^=begin\b/, end: /^=end\b.*/, multiline: true },
    DOUBLE_QUOTED,
    SINGLE_QUOTED,
    { kind: "string", start: /`/, end: /`/, escapes: true },
  ],
  rules: [
    ["comment", /#.*/],
    ["string", /%[qQwWiI]?(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|<[^>]*>)/],
    // Symbols, but not the second colon of Foo::Bar.
    ["literal", /(?<![:\w]):[A-Za-z_]\w*[?!=]?/],
    // Hash keys written as `key:`.
    ["literal", /[A-Za-z_]\w*[?!]?:(?!:)/],
    ["attribute", /@@?[A-Za-z_]\w*|\$[A-Za-z_]\w*/],
  ],
};

const python: Language = {
  names: words("python py py3 pyw pyi gyp"),
  keywords: words(`
    and as assert async await break case class continue def del elif else except finally for from global if
    import in is lambda match nonlocal not or pass raise return try while with yield`),
  literals: words("True False None self cls"),
  types: words("int float str bool list dict set tuple bytes object type"),
  capitalTypes: true,
  regions: [
    { kind: "string", start: /[rRbBfFuU]{0,2}"""/, end: /"""/, escapes: true, multiline: true },
    { kind: "string", start: /[rRbBfFuU]{0,2}'''/, end: /'''/, escapes: true, multiline: true },
    { ...DOUBLE_QUOTED, start: /[rRbBfFuU]{0,2}"/ },
    { ...SINGLE_QUOTED, start: /[rRbBfFuU]{0,2}'/ },
  ],
  rules: [["comment", /#.*/], ANNOTATION],
};

const SHELL_VARIABLE = /\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[0-9@#?$!*-]/;

const shell: Language = {
  names: words("bash sh shell zsh ksh console shellsession terminal"),
  keywords: words(`
    alias break case continue declare do done elif else esac eval exec exit export fi for function if in local
    readonly return select set shift source then time trap unset until while`),
  literals: words("true false"),
  word: /[A-Za-z_][\w-]*/,
  regions: [
    { ...DOUBLE_QUOTED, multiline: true },
    { kind: "string", start: /'/, end: /'/, multiline: true },
  ],
  rules: [["meta", /^\$(?= )/], HASH_COMMENT, ["attribute", SHELL_VARIABLE]],
};

const elixir: Language = {
  names: words("elixir ex exs"),
  keywords: words(`
    after alias and catch cond def defimpl defmacro defmacrop defmodule defp defprotocol defstruct do else end
    fn for if import in not or quote raise receive require rescue try unless unquote use when with`),
  literals: words("true false nil"),
  capitalTypes: true,
  word: /[A-Za-z_][\w]*[?!]?/,
  regions: [TRIPLE_DOUBLE, DOUBLE_QUOTED, SINGLE_QUOTED],
  rules: [
    ["comment", /#.*/],
    ["literal", /(?<![:\w]):[A-Za-z_]\w*[?!]?/],
    ["literal", /[A-Za-z_]\w*[?!]?:(?!:)/],
    ["attribute", /@[A-Za-z_]\w*/],
  ],
};

const lua: Language = {
  names: words("lua luau"),
  keywords: words(`
    and break do else elseif end for function goto if in local not or repeat return then until while`),
  literals: words("true false nil self"),
  regions: [
    { kind: "comment", start: /--\[=*\[/, end: /\]=*\]/, multiline: true },
    { kind: "string", start: /\[=*\[/, end: /\]=*\]/, multiline: true },
    DOUBLE_QUOTED,
    SINGLE_QUOTED,
  ],
  rules: [["comment", /--.*/]],
};

const dockerfile: Language = {
  names: words("dockerfile docker containerfile"),
  keywords: words("AS as"),
  regions: [DOUBLE_QUOTED, SINGLE_QUOTED],
  rules: [
    ["comment", /^\s*#.*/],
    [
      "keyword",
      /^\s*(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|MAINTAINER)\b/i,
    ],
    ["attribute", SHELL_VARIABLE],
  ],
};

const makefile: Language = {
  names: words("makefile make mk mak"),
  keywords: words("ifeq ifneq ifdef ifndef else endif include define endef export override"),
  word: /[A-Za-z_][\w-]*/,
  regions: [DOUBLE_QUOTED, SINGLE_QUOTED],
  rules: [
    HASH_COMMENT,
    ["type", /^[^\s:#=][^:#=]*(?=:(?!=))/],
    ["attribute", /^[\w.-]+(?=\s*[:+?]?=)/],
    ["attribute", /\$[({][^)}]*[)}]|\$[@<^?*%]/],
  ],
};

export const SCRIPTING = [ruby, python, shell, elixir, lua, dockerfile, makefile];

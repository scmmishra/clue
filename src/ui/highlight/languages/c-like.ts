import type { Language } from "../engine";
import { ANNOTATION, BLOCK_COMMENT, DOUBLE_QUOTED, SINGLE_QUOTED, SLASH_COMMENT, TRIPLE_DOUBLE, words } from "./common";

// Languages with // and /* */ comments. Keyword lists come from each language's reference.

const javascript: Language = {
  names: words("js javascript jsx mjs cjs ts typescript tsx mts cts node"),
  keywords: words(`
    abstract as async await break case catch class const continue debugger declare default delete do else
    enum export extends finally for from function get if implements import in infer instanceof interface
    is keyof let namespace new of override private protected public readonly return satisfies set static
    switch throw try type typeof var void while with yield`),
  literals: words("true false null undefined NaN Infinity this super"),
  types: words("string number boolean any unknown never object symbol bigint"),
  capitalTypes: true,
  regions: [
    BLOCK_COMMENT,
    { kind: "string", start: /`/, end: /`/, escapes: true, multiline: true },
    DOUBLE_QUOTED,
    SINGLE_QUOTED,
  ],
  rules: [SLASH_COMMENT, ANNOTATION],
};

const go: Language = {
  names: words("go golang"),
  keywords: words(`
    break case chan const continue default defer else fallthrough for func go goto if import interface map
    package range return select struct switch type var`),
  literals: words("true false nil iota"),
  types: words(`
    any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string
    uint uint8 uint16 uint32 uint64 uintptr`),
  regions: [BLOCK_COMMENT, { kind: "string", start: /`/, end: /`/, multiline: true }, DOUBLE_QUOTED, SINGLE_QUOTED],
  rules: [SLASH_COMMENT],
};

const rust: Language = {
  names: words("rust rs"),
  keywords: words(`
    as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move
    mut pub ref return static struct super trait type unsafe use where while`),
  literals: words("true false self Self None Some Ok Err"),
  types: words("bool char str u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64"),
  capitalTypes: true,
  regions: [
    BLOCK_COMMENT,
    { kind: "string", start: /b?r#+"/, end: /"#+/, multiline: true },
    { kind: "string", start: /b?r?"/, end: /"/, escapes: true, multiline: true },
  ],
  rules: [
    SLASH_COMMENT,
    ["meta", /#!?\[[^\]]*\]/],
    // A character literal, checked before a lifetime such as 'a.
    ["string", /b?'(?:[^'\\]|\\[^']{1,8})'/],
    ["meta", /'[A-Za-z_]\w*/],
    ["meta", /[A-Za-z_]\w*!/],
  ],
};

const java: Language = {
  names: words("java"),
  keywords: words(`
    abstract assert break case catch class const continue default do else enum extends final finally for goto
    if implements import instanceof interface native new non-sealed package permits private protected public
    record return sealed static strictfp super switch synchronized throw throws transient try var void
    volatile while yield`),
  literals: words("true false null this"),
  types: words("boolean byte char double float int long short"),
  capitalTypes: true,
  regions: [BLOCK_COMMENT, TRIPLE_DOUBLE, DOUBLE_QUOTED, SINGLE_QUOTED],
  rules: [SLASH_COMMENT, ANNOTATION],
};

const kotlin: Language = {
  names: words("kotlin kt kts"),
  keywords: words(`
    abstract as break by catch class companion constructor continue data do else enum final finally for fun
    get if import in init inline interface internal is lateinit object open operator out override package
    private protected public reified return sealed set super suspend throw try typealias val var vararg when
    while`),
  literals: words("true false null this it"),
  capitalTypes: true,
  regions: [BLOCK_COMMENT, TRIPLE_DOUBLE, DOUBLE_QUOTED, SINGLE_QUOTED],
  rules: [SLASH_COMMENT, ANNOTATION],
};

const swift: Language = {
  names: words("swift"),
  keywords: words(`
    actor any as associatedtype async await break case catch class continue default defer deinit do else enum
    extension fallthrough fileprivate final for func guard if import in init inout internal is lazy let
    mutating open operator override private protocol public repeat rethrows return some static struct
    subscript switch throw throws try typealias var weak where while`),
  literals: words("true false nil self Self super"),
  capitalTypes: true,
  regions: [BLOCK_COMMENT, TRIPLE_DOUBLE, DOUBLE_QUOTED],
  rules: [SLASH_COMMENT, ANNOTATION, ["meta", /#[A-Za-z_]\w*/]],
};

const c: Language = {
  names: words("c h cpp c++ cc cxx hpp hh objc objective-c"),
  keywords: words(`
    auto break case catch class const constexpr continue default delete do else enum explicit extern for
    friend goto if inline mutable namespace new noexcept operator private protected public register return
    sizeof static struct switch template throw try typedef typename union using virtual volatile while
    static_cast dynamic_cast reinterpret_cast const_cast decltype override final`),
  literals: words("true false NULL nullptr this"),
  types: words(`
    bool char double float int long short signed unsigned void size_t int8_t int16_t int32_t int64_t uint8_t
    uint16_t uint32_t uint64_t`),
  regions: [BLOCK_COMMENT, DOUBLE_QUOTED, SINGLE_QUOTED],
  rules: [SLASH_COMMENT, ["meta", /^\s*#\s*include\s*<[^>]*>/], ["meta", /^\s*#\s*\w+/]],
};

const csharp: Language = {
  names: words("cs csharp c#"),
  keywords: words(`
    abstract as async await base break case catch checked class const continue default delegate do else enum
    event explicit extern finally fixed for foreach get goto if implicit in init interface internal is lock
    namespace new operator out override params private protected public readonly record ref return sealed set
    sizeof stackalloc static struct switch throw try typeof unchecked unsafe using var virtual void volatile
    when where while yield`),
  literals: words("true false null this"),
  types: words("bool byte char decimal double float int long object sbyte short string uint ulong ushort"),
  capitalTypes: true,
  regions: [
    BLOCK_COMMENT,
    { kind: "string", start: /\$?@"/, end: /"/, multiline: true },
    { ...DOUBLE_QUOTED, start: /\$?"/ },
    SINGLE_QUOTED,
  ],
  rules: [SLASH_COMMENT, ["meta", /^\s*#\w+/]],
};

const php: Language = {
  names: words("php"),
  keywords: words(`
    abstract and as break callable case catch class clone const continue declare default do echo else elseif
    empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach
    function global goto if implements include include_once instanceof insteadof interface isset list match
    namespace new or print private protected public readonly require require_once return static switch throw
    trait try unset use var while xor yield`),
  literals: words("true false null TRUE FALSE NULL"),
  capitalTypes: true,
  regions: [BLOCK_COMMENT, { ...DOUBLE_QUOTED, multiline: true }, { ...SINGLE_QUOTED, multiline: true }],
  rules: [SLASH_COMMENT, ["comment", /#(?!\[).*/], ["meta", /<\?(?:php|=)?|\?>/], ["attribute", /\$[A-Za-z_]\w*/]],
};

const zig: Language = {
  names: words("zig"),
  keywords: words(`
    addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const
    continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline
    nosuspend opaque or orelse packed pub resume return struct suspend switch test threadlocal try union
    unreachable usingnamespace var volatile while`),
  literals: words("true false null undefined"),
  types: words("i8 u8 i16 u16 i32 u32 i64 u64 i128 u128 isize usize f16 f32 f64 bool void anyerror type comptime_int"),
  regions: [DOUBLE_QUOTED, SINGLE_QUOTED],
  rules: [SLASH_COMMENT, ["string", /\\\\.*/], ["meta", /@[A-Za-z_]\w*/]],
};

export const C_LIKE = [javascript, go, rust, java, kotlin, swift, c, csharp, php, zig];

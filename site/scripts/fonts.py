#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools[woff]==4.68.0", "uharfbuzz==0.57.0"]
# ///
"""Cuts Martian Mono down to what the site draws, and writes site/src/fonts/.

Run it by hand. It is not part of the build, and its output is committed:

    uv run site/scripts/fonts.py          # build the site, cut the fonts, check them, write them
    uv run site/scripts/fonts.py --check  # build the site and fail if the committed fonts are out of date

Rerun it when:
- a page starts to use a character that the fonts do not have (--check fails and names it),
- the CSS turns on an OpenType feature, a width or a language that the cut drops (the script fails and says which),
- you change UPSTREAM, CORE or EXTENDED below.

What it writes:
- martian-mono-core.woff2: ASCII, common punctuation, and every other character the built site uses.
  src/layouts/Base.astro preloads it.
- martian-mono-extended.woff2: the rest of Latin-1 and Latin Extended-A. Its unicode-range keeps it off
  every page that does not use one of its characters.
- martian-mono.css: the two @font-face rules. Each unicode-range lists only the characters its file has.

The glyphs are the ones the site drew from @fontsource-variable/martian-mono 5.3.0: the Google Fonts
file with the width axis pinned at 100 and IUP-optimized weight deltas. The script checks every outline
at every 50 units of weight against that, and checks shaping, metrics and tables.
"""

import argparse
import hashlib
import html
import io
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

import uharfbuzz as hb
from fontTools import subset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont

SITE = Path(__file__).resolve().parent.parent
OUT = SITE / "src" / "fonts"
DIST = SITE / "dist"

# The variable font from Google Fonts, at the last commit that changed it. Fontsource builds from this file.
COMMIT = "1386d6284a09c9c25d8c1db08717d6e42a44867d"
UPSTREAM = f"https://raw.githubusercontent.com/google/fonts/{COMMIT}/ofl/martianmono/MartianMono%5Bwdth%2Cwght%5D.ttf"
UPSTREAM_SHA256 = "c3467843ec1c2574b05fbcfd7147c7bfbcf63ddca8fc2bcb9d117f1bfb1b22e7"
LICENSE = f"https://raw.githubusercontent.com/google/fonts/{COMMIT}/ofl/martianmono/OFL.txt"
LICENSE_SHA256 = "ddafd2c3f37ef1d83ef284ca63e159befd3820850c5e9eded14ca52eee92c256"

FAMILY = "Martian Mono Variable"
# Fontsource's wght files pin the width here. Nothing on the site sets font-stretch, so it stays pinned.
WIDTH = 100
# The weight axis keeps its full range. Limiting it to the weights in use (290 to 700) saves 876 bytes
# on the core and 1,108 on the extended file, but it rescales the deltas: outline points move by up to
# 1.1 units per 1000, and most text pixels change by up to 5 levels of 255, headings by up to 39.
# check_outlines requires exact outlines, so it fails with a limited range.
WEIGHTS = (100, 800)

# The characters that the site drew with Martian Mono before this script: the unicode-range of
# Fontsource's four faces. Characters outside these, such as ← → ≡ and box drawing, render in the
# fallback font, so the cut leaves them out even where the font has a glyph.
DRAWN_BEFORE = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,"
    "U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD,"  # latin
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,"
    "U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF,"  # latin-ext
    "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116,"  # cyrillic
    "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F"  # cyrillic-ext
)

# ASCII, a no-break space, curly quotes, dashes, the ellipsis, and the bullet of disc list markers.
CORE = "U+0020-007E,U+00A0,U+2018-2019,U+201C-201D,U+2013-2014,U+2026,U+2022"
EXTENDED = "U+00A0-00FF,U+0100-017F"  # Latin-1 Supplement and Latin Extended-A.

# The features browsers turn on by default that the font has. locl is left out: its rules are for
# Turkish, Catalan, Romanian and others, and the site is in English. The script fails if a page uses
# one of those languages, or if the CSS turns on a feature the font has that is not in this list.
FEATURES = ["calt", "ccmp", "rvrn", "mark", "mkmk"]
LOCL_LANGUAGES = {"az": "AZE", "ca": "CAT", "crh": "CRT", "kk": "KAZ", "mo": "MOL", "nl": "NLD", "ro": "ROM", "tt": "TAT", "tr": "TRK"}
CSS_FEATURES = {
    "tabular-nums": ["tnum"], "proportional-nums": ["pnum"], "oldstyle-nums": ["onum"], "lining-nums": ["lnum"],
    "diagonal-fractions": ["frac"], "stacked-fractions": ["afrc"], "ordinal": ["ordn"], "slashed-zero": ["zero"],
    "small-caps": ["smcp"], "all-small-caps": ["smcp", "c2sc"], "petite-caps": ["pcap"], "all-petite-caps": ["pcap", "c2pc"],
    "unicase": ["unic"], "titling-caps": ["titl"], "super": ["sups"], "sub": ["subs"], "historical-forms": ["hist"],
    "discretionary-ligatures": ["dlig"], "historical-ligatures": ["hlig"],
}
# CoreText (Safari, and Chrome on macOS) rasterizes a glyph differently depending on three things outside
# its outline: the font's head bounding box, a .notdef glyph with an outline, and real glyph names (it
# looks for the glyph named o). A plain subset changes all three, and text renders up to 136 of 255
# levels different. So the cut keeps glyph names and the .notdef outline, and sets the bounding box of
# the Fontsource file that drew the characters before. CoreText clips glyphs to the box, so a box
# smaller than before visibly cuts the edges of heavy or accented glyphs, and a larger box moves
# edge pixels by 1 or 2 levels of 255.
BOUNDING_BOXES = {
    # Fontsource's latin file drew ASCII and the punctuation.
    "martian-mono-core.woff2": (3, -251, 712, 1082),
    # Latin-1 came from the latin file and Latin Extended-A from latin-ext, whose box is larger. The box
    # of latin-ext contains both, so nothing is clipped. Latin-1 edges move by up to 2 levels.
    "martian-mono-extended.woff2": (-19, -251, 779, 1088),
}
HINTING_TABLES = ("fpgm", "prep", "cvt ", "cvar", "hdmx", "VDMX", "LTSH")
# Names a browser can show or that the license asks for: copyright, family and style names, version, license.
NAME_IDS = [0, 1, 2, 3, 4, 5, 6, 13, 14]
CHECK_WEIGHTS = sorted({*range(WEIGHTS[0], WEIGHTS[1] + 1, 50), 290, 540, 650})


def codepoints(ranges: str) -> set[int]:
    out = set()
    for part in ranges.split(","):
        lo, _, hi = part.strip().removeprefix("U+").partition("-")
        out.update(range(int(lo, 16), int(hi or lo, 16) + 1))
    return out


def unicode_range(cps: set[int]) -> str:
    runs, ordered = [], sorted(cps)
    start = prev = ordered[0]
    for cp in ordered[1:] + [None]:
        if cp is not None and cp == prev + 1:
            prev = cp
            continue
        runs.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
        if cp is not None:
            start = prev = cp
    return ",".join(runs)


def fetch(url: str, sha256: str) -> bytes:
    cache = Path(tempfile.gettempdir()) / "clue-fonts" / sha256
    if cache.exists():
        data = cache.read_bytes()
    else:
        with urllib.request.urlopen(url) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != sha256:
        sys.exit(f"{url} does not match its pinned SHA-256. Check the file, then update the hash in this script.")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(data)
    return data


def fail(message: str):
    sys.exit(f"error: {message}")


# The built site ------------------------------------------------------------------------------------


def read_site():
    """Returns the characters the built site can draw, the text of each page, and the CSS and HTML."""
    subprocess.run(["bun", "run", "build"], cwd=SITE, check=True, stdout=subprocess.DEVNULL)
    used, pages, styles = set(), {}, []
    for path in sorted(DIST.rglob("*.html")):
        raw = path.read_text(encoding="utf-8")
        styles.append(raw)
        body = re.sub(r"<head>.*?</head>|<script\b.*?</script>|<style\b.*?</style>", " ", raw, flags=re.S)
        # Attributes stay in: placeholders are drawn with the page font.
        used.update(html.unescape(body))
        pages[str(path.relative_to(DIST))] = html.unescape(re.sub(r"<[^>]+>", " ", body))
    # Strings that client scripts add (search snippets use … and ›), CSS content, and the search index.
    for path in [*DIST.rglob("*.js"), *DIST.rglob("*.css"), DIST / "search.json"]:
        text = path.read_text(encoding="utf-8")
        used.update(text)
        if path.suffix == ".css":
            styles.append(text)
    css = "\n".join(styles)
    if re.search(r"hyphens\s*:\s*auto", css):
        used.add(0x2010)  # Automatic hyphenation draws U+2010 HYPHEN.
    if re.search(r"text-overflow\s*:\s*ellipsis", css):
        used.add(0x2026)
    return {c if isinstance(c, int) else ord(c) for c in used}, pages, css


def check_css(css: str, font: TTFont):
    """Fails if the site asks for a width, feature or language that the cut drops."""
    for match in re.finditer(r"font-(?:stretch|width)\s*:\s*([^;}\"]+)", css):
        if match.group(1).strip() not in ("normal", "100%"):
            fail(f"the CSS sets {match.group(0)!r}, but the width axis is pinned at {WIDTH}.")
    if re.search(r"['\"]wdth['\"]", css):
        fail("the CSS sets the wdth axis, but it is pinned.")
    in_font = {r.FeatureTag for t in ("GSUB", "GPOS") for r in font[t].table.FeatureList.FeatureRecord}
    asked = set(re.findall(r"font-feature-settings\s*:[^;}]*?['\"](\w{4})['\"]", css))
    for value in re.findall(r"font-variant(?:-\w+)?\s*:\s*([^;}\"]+)", css):
        for word in value.split():
            asked.update(CSS_FEATURES.get(word, []))
    dropped = (asked & in_font) - set(FEATURES)
    if dropped:
        fail(f"the CSS turns on {sorted(dropped)}, which the cut drops. Add them to FEATURES.")
    langs = {lang.lower().split("-")[0] for lang in re.findall(r"\blang=[\"']?([\w-]+)", css)}
    if langs & LOCL_LANGUAGES.keys():
        fail(f"a page is in {sorted(langs & LOCL_LANGUAGES.keys())}, which has locl rules. Add locl to FEATURES.")
    return sorted(asked - in_font)


# Cutting -------------------------------------------------------------------------------------------


def pin_width(upstream: bytes) -> TTFont:
    """Pins the width the way Fontsource's files were made: HarfBuzz, with IUP-optimized deltas."""
    face = hb.Face(upstream)
    plan = hb.SubsetInput()
    plan.keep_everything()
    plan.pin_axis_location(face, "wdth", WIDTH)
    if WEIGHTS != (100, 800):
        plan.set_axis_range(face, "wght", WEIGHTS[0], WEIGHTS[1], 400)
    plan.flags |= hb.SubsetFlags.OPTIMIZE_IUP_DELTAS | hb.SubsetFlags.GLYPH_NAMES
    return TTFont(io.BytesIO(hb.subset(face, plan).blob.data))


def cut(reference: TTFont, cps: set[int], box: tuple[int, int, int, int]) -> bytes:
    """Returns the WOFF2 file for these characters."""
    font = TTFont(io.BytesIO(save(reference, "ttf")))
    # Named instances and STAT only name styles for font menus. Browsers do not read them.
    font["fvar"].instances = []
    del font["STAT"]
    options = subset.Options()
    options.layout_features = FEATURES
    options.hinting = False
    options.name_IDs = NAME_IDS
    options.notdef_outline = True
    options.glyph_names = True
    # The subsetter adds the mirror image of brackets and quotes, such as ‹ for ›, for right-to-left
    # text. The site is left to right, and the unicode-range must list only what the file draws.
    options.bidi_closure = False
    options.drop_tables += list(HINTING_TABLES)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=cps)
    subsetter.subset(font)
    font["head"].xMin, font["head"].yMin, font["head"].xMax, font["head"].yMax = box
    return save(font, "woff2")


def save(font: TTFont, flavor: str) -> bytes:
    font.flavor = None if flavor == "ttf" else flavor
    font.recalcBBoxes = False  # Keep BOUNDING_BOXES. fontTools would recompute it from the glyphs left.
    font.recalcTimestamp = False  # Keep head.modified, so a rerun writes the same bytes.
    buffer = io.BytesIO()
    font.save(buffer)
    return buffer.getvalue()


# Checks --------------------------------------------------------------------------------------------


def outlines(font: TTFont, weight: float):
    glyphs = font.getGlyphSet(location={"wght": weight})
    cache = {}

    def draw(name):
        if name not in cache:
            pen = DecomposingRecordingPen(glyphs)
            glyphs[name].draw(pen)
            cache[name] = (glyphs[name].width, tuple(pen.value))
        return cache[name]

    return draw


def check_outlines(font: TTFont, reference: TTFont, label: str):
    """Every character: same advance and same points as the reference, at every checked weight."""
    cmap, ref_cmap = font.getBestCmap(), reference.getBestCmap()
    for weight in CHECK_WEIGHTS:
        mine, theirs = outlines(font, weight), outlines(reference, weight)
        for cp, name in cmap.items():
            if mine(name) != theirs(ref_cmap[cp]):
                fail(f"{label}: U+{cp:04X} at weight {weight} differs from the reference.")


def check_shaping(font: TTFont, data: bytes, reference: TTFont, ref_data: bytes, texts: list[str], label: str):
    """Shapes each text with both fonts and compares the drawn glyphs and positions. This covers calt, ccmp and rvrn."""
    order, ref_order = font.getGlyphOrder(), reference.getGlyphOrder()
    mine_font, ref_font = hb.Font(hb.Face(data)), hb.Font(hb.Face(ref_data))
    for weight in (290, 540, 650, 700):
        mine_font.set_variations({"wght": weight})
        ref_font.set_variations({"wght": weight})
        mine_draw, ref_draw = outlines(font, weight), outlines(reference, weight)
        for text in texts:
            runs = []
            for hb_font, draw, names in ((mine_font, mine_draw, order), (ref_font, ref_draw, ref_order)):
                buffer = hb.Buffer()
                buffer.add_str(text)
                buffer.guess_segment_properties()
                buffer.language = "en"
                hb.shape(hb_font, buffer)
                glyphs = [(draw(names[i.codepoint]), p.x_advance, p.x_offset, p.y_offset) for i, p in zip(buffer.glyph_infos, buffer.glyph_positions)]
                # Compare what is drawn. HarfBuzz shows an invisible character, such as a soft hyphen, as a
                # zero-width space when the font has a space glyph, and drops it when it does not.
                runs.append([g for g in glyphs if g[0][1] or g[1]])
            if runs[0] != runs[1]:
                fail(f"{label}: {text[:40]!r} shapes differently from the reference at weight {weight}.")


def check_tables(font: TTFont, reference: TTFont, cps: set[int], label: str):
    if set(font.getBestCmap()) != cps:
        extra, missing = set(font.getBestCmap()) - cps, cps - set(font.getBestCmap())
        fail(f"{label}: the cmap does not match the planned characters. Extra: {sorted(map(hex, extra))}, missing: {sorted(map(hex, missing))}.")
    if found := [t for t in HINTING_TABLES if t in font]:
        fail(f"{label}: hinting tables are left: {found}.")
    if any(getattr(g, "program", None) and g.program.getBytecode() for g in font["glyf"].glyphs.values()):
        fail(f"{label}: glyphs still have hinting instructions.")
    features = {r.FeatureTag for t in ("GSUB", "GPOS") if t in font for r in font[t].table.FeatureList.FeatureRecord}
    if features - set(FEATURES):
        fail(f"{label}: unexpected features {sorted(features - set(FEATURES))}.")
    axes = [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in font["fvar"].axes]
    if axes != [("wght", WEIGHTS[0], 400, WEIGHTS[1])]:
        fail(f"{label}: unexpected axes {axes}.")
    if "avar" not in font:
        fail(f"{label}: the avar table is gone, so weights would map differently.")
    if not font["name"].getDebugName(font["fvar"].axes[0].axisNameID):
        fail(f"{label}: the name of the weight axis is gone.")
    # What CoreText reads besides the outlines. See BOUNDING_BOXES.
    head = font["head"]
    if (head.xMin, head.yMin, head.xMax, head.yMax) != BOUNDING_BOXES[label]:
        fail(f"{label}: the head bounding box is not {BOUNDING_BOXES[label]}.")
    if font["post"].formatType != 2.0 or "o" not in font.getGlyphOrder():
        fail(f"{label}: the glyph names, or the glyph named o, are gone.")
    if font["glyf"][".notdef"].numberOfContours <= 0:
        fail(f"{label}: the .notdef glyph has no outline.")

    # Line height, underline and strike position come from these. They must not move.
    def metrics(f):
        o, h, p = f["OS/2"], f["hhea"], f["post"]
        return (f["head"].unitsPerEm, h.ascent, h.descent, h.lineGap, o.sTypoAscender, o.sTypoDescender, o.sTypoLineGap,
                o.usWinAscent, o.usWinDescent, o.fsSelection & 128, o.sxHeight, o.sCapHeight, p.underlinePosition,
                p.underlineThickness, o.yStrikeoutPosition, o.yStrikeoutSize, o.usWeightClass, o.usWidthClass)

    if metrics(font) != metrics(reference):
        fail(f"{label}: vertical metrics differ from the reference.")


def check_license(text: str):
    # Under the OFL, a modified font must not use a Reserved Font Name. Martian Mono declares none,
    # so the cut keeps its names. If a future version declares one, rename the font before shipping.
    header = text.split("This Font Software is licensed", 1)[0]
    if "Reserved Font Name" in header:
        fail("OFL.txt now declares a Reserved Font Name. The cut font must be renamed internally.")


# Output --------------------------------------------------------------------------------------------


def css(files: list[tuple[str, set[int]]]) -> str:
    rules = [
        "/* Generated by site/scripts/fonts.py. Do not edit; run `uv run site/scripts/fonts.py`. */",
        "/* Martian Mono, cut to what the site draws. The core is preloaded in src/layouts/Base.astro. */",
    ]
    for name, cps in files:
        rules.append(
            "@font-face {\n"
            f"\tfont-family: '{FAMILY}';\n"
            "\tfont-style: normal;\n"
            "\tfont-display: swap;\n"
            f"\tfont-weight: {WEIGHTS[0]} {WEIGHTS[1]};\n"
            f"\tsrc: url(./{name}) format('woff2-variations');\n"
            f"\tunicode-range: {unicode_range(cps)};\n"
            "}"
        )
    return "\n\n".join(rules) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="fail if the committed fonts are out of date")
    args = parser.parse_args()

    upstream = fetch(UPSTREAM, UPSTREAM_SHA256)
    license_text = fetch(LICENSE, LICENSE_SHA256).decode()
    check_license(license_text)
    reference = pin_width(upstream)
    ref_data = save(reference, "ttf")
    in_font = set(reference.getBestCmap())
    drawable = codepoints(DRAWN_BEFORE) & in_font

    used, pages, site_css = read_site()
    no_op = check_css(site_css, reference)
    printable = {cp for cp in used if cp >= 0x20 and cp not in (0x7F, 0xFEFF)}
    core = (codepoints(CORE) | (printable & drawable)) & in_font
    extended = (codepoints(EXTENDED) & drawable) - core
    fallback = sorted(cp for cp in printable - drawable if cp > 0x7E)

    files = [("martian-mono-core.woff2", core), ("martian-mono-extended.woff2", extended)]
    stylesheet = css(files)
    if args.check:
        committed = (OUT / "martian-mono.css").read_text()
        if committed != stylesheet:
            had = [codepoints(r) for r in re.findall(r"unicode-range: ([^;]+);", committed)]
            changes = []
            for (name, cps), old in zip(files, had):
                if cps - old:
                    changes.append(f"{name} needs {''.join(map(chr, sorted(cps - old)))}")
                if old - cps:
                    changes.append(f"{name} no longer needs {''.join(map(chr, sorted(old - cps)))}")
            fail(f"the committed fonts are out of date: {'; '.join(changes) or 'the CSS differs'}. Run `uv run site/scripts/fonts.py`.")
        print("The committed fonts are up to date.")
        return

    print(f"Upstream: Martian Mono at google/fonts {COMMIT[:7]}, width pinned at {WIDTH}, weights {WEIGHTS[0]} to {WEIGHTS[1]}.")
    added = sorted(core - codepoints(CORE))
    print(f"Core: {len(core)} characters. Added because the site uses them: {''.join(map(chr, added)) or 'none'}")
    print(f"Extended: {len(extended)} characters.")
    if fallback:
        print(f"Left to the fallback font, as before: {''.join(map(chr, fallback))}")
    if no_op:
        print(f"The CSS asks for {no_op}, which the font does not have. Browsers ignore them, as before.")

    OUT.mkdir(parents=True, exist_ok=True)
    for name, cps in files:
        data = cut(reference, cps, BOUNDING_BOXES[name])
        font = TTFont(io.BytesIO(data))  # Check the file as written, after WOFF2 compression.
        check_tables(font, reference, cps, name)
        check_outlines(font, reference, name)
        texts = ["".join(map(chr, sorted(cps)))]
        # calt raises : - – — + − × ÷ = between digits and capitals. Test it inside this file's characters.
        context = [c for c in "0123456789AEHMOXZ" + "ÀÉÖÜĀĚŐŰ" if ord(c) in cps]
        marks = [c for c in ":-–—+−×÷=≠" if ord(c) in cps]
        texts += [a + m + b for a in context for m in marks for b in context] + [a + "::" + b for a in context for b in context]
        # rvrn swaps $ ¢ Ķ from weight 500, and ccmp splits Ŀ.
        texts.append("$5 ¢ Ķ Ŀ ŀ")
        # The real text of every page.
        texts += pages.values()
        # A browser shapes each font's characters on their own, so test runs of this file's characters.
        outside = f"[^{re.escape(''.join(map(chr, sorted(cps))))}]+"
        texts = [run for text in texts for run in re.split(outside, text) if run.strip()]
        check_shaping(font, save(font, "ttf"), reference, ref_data, texts, name)
        (OUT / name).write_bytes(data)
        print(f"  {name}: {len(data):,} bytes, {font['maxp'].numGlyphs} glyphs, features {sorted({r.FeatureTag for t in ('GSUB', 'GPOS') for r in font[t].table.FeatureList.FeatureRecord})}")
    (OUT / "martian-mono.css").write_text(stylesheet)
    (OUT / "OFL.txt").write_text(license_text)
    print(f"Checked outlines at weights {CHECK_WEIGHTS[0]} to {CHECK_WEIGHTS[-1]}, shaping, metrics and tables. Wrote {OUT.relative_to(SITE.parent)}/.")


if __name__ == "__main__":
    main()

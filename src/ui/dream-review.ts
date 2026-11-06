import { columns, homePath, style, truncate, wrapLine } from "./ansi";
import { Editor } from "./editor";
import { Keyboard, Screen, type Key, type LiveFrame } from "./screen";
import { settle, type Dream, type Proposal, type Verdict } from "../dream/store";

// The review screen of `clue dream`. A list of the pending proposals, where space sets each
// one's verdict, `e` edits its text and `s` splits it into one proposal per sentence. `→`
// opens a read-only view of its evidence. The verdicts apply when the review ends.

// Space moves a proposal through these. A proposal starts with none.
const NEXT: Record<Verdict | "none", Verdict> = { none: "approve", approve: "reject", reject: "skip", skip: "approve" };
const MARK: Record<Verdict | "none", string> = {
  none: style.faint("○"),
  approve: style.green("✓"),
  reject: style.red("✗"),
  skip: style.muted("–"),
};
const LABEL: Record<Verdict | "none", string> = {
  none: style.faint("to review"),
  approve: style.green("approve"),
  reject: style.red("reject"),
  skip: style.muted("skip"),
};
const BAR = style.brand("┃");
// The agent's text before a quote shows in full, up to this many rows.
const AGENT_ROWS = 4;
const MAX_WIDTH = 100;
// The date column and the space after it, under which a quote's rows line up.
const QUOTE_INDENT = "            ";
// A quote's left margin: two spaces, then the selection bar or two more spaces.
const QUOTE_MARGIN = 4;

type Mode =
  | { kind: "list" }
  | { kind: "detail"; quote: number }
  | { kind: "edit"; editor: Editor }
  | { kind: "split"; parts: string[] };

export type ReviewResult = Record<Verdict, number> & { waiting: number };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const sentences = (text: string) => text.split(/(?<=\.)\s+/).filter(Boolean);
const dateOf = (at: number | null) => (at === null ? "          " : new Date(at).toISOString().slice(0, 10));

// Key hints: the key stands out, its action stays quiet.
const hints = (pairs: [string, string][]) =>
  pairs.map(([key, action]) => `${style.accent(key)} ${style.faint(action)}`).join("   ");

export async function reviewProposals(dream: Dream): Promise<ReviewResult> {
  const screen = new Screen();
  const keyboard = new Keyboard();
  const verdicts = new Map<Proposal, Verdict>();
  let selected = 0;
  let mode: Mode = { kind: "list" };

  const width = () => Math.min(columns() - 2, MAX_WIDTH);
  const current = () => dream.pending[selected];
  const verdictOf = (proposal: Proposal) => verdicts.get(proposal) ?? "none";
  const count = (verdict: Verdict | "none") =>
    dream.pending.filter((proposal) => verdictOf(proposal) === verdict).length;
  const header = (title: string, detail = "") => ["", `${style.bold(style.accent(title))}  ${style.muted(detail)}`, ""];

  function list(): string[] {
    const tally = `${count("approve")} approve · ${count("reject")} reject · ${count("skip")} skip · ${count("none")} to review`;
    const lines = header(`Dream  ${homePath(dream.repo)}`, tally);
    dream.pending.forEach((proposal, index) => {
      const isSelected = index === selected;
      const lead = isSelected ? `${BAR} ` : "  ";
      const verdict = verdictOf(proposal);
      const tone = isSelected ? style.accent : verdict === "none" ? (text: string) => text : style.muted;
      const rows = wrapLine(proposal.text, width() - 6);
      lines.push(`${lead}${MARK[verdict]}  ${tone(rows[0])}`);
      for (const row of rows.slice(1)) lines.push(`${lead}   ${tone(row)}`);
      const meta = [LABEL[verdict], style.faint(plural(proposal.evidence.length, "quote"))];
      if (proposal.replaces) meta.push(style.orange("replaces a memory"));
      lines.push(`${lead}   ${meta.join(style.faint(" · "))}`, "");
    });
    lines.push(
      hints([
        ["space", "approve / reject / skip"],
        ["e", "edit"],
        ["s", "split"],
      ]),
      hints([
        ["↑↓", "move"],
        ["→", "open"],
        ["q", "done"],
      ]),
    );
    return lines;
  }

  function detail(quote: number): string[] {
    const proposal = current();
    const room = width() - 4;
    const lines = header(`Proposal ${selected + 1} of ${dream.pending.length}`);
    lines.push(...wrapLine(proposal.text, room).map((row) => `  ${style.bold(style.accent(row))}`), "");
    if (proposal.replaces)
      lines.push(
        `  ${style.orange("Replaces")}`,
        ...wrapLine(proposal.replaces, room).map((row) => `  ${style.muted(row)}`),
        "",
      );
    lines.push(`  ${style.muted(`Evidence · ${plural(proposal.evidence.length, "quote")}`)}`, "");
    proposal.evidence.forEach((item, index) => {
      const lead = index === quote ? `  ${BAR} ` : "    ";
      const tone = index === quote ? style.accent : (text: string) => text;
      const quoteRoom = width() - QUOTE_MARGIN - QUOTE_INDENT.length;
      const said = wrapLine(`"${item.text.replace(/\s+/g, " ")}"`, quoteRoom);
      lines.push(`${lead}${style.faint(dateOf(item.at))}  ${tone(said[0])}`);
      for (const row of said.slice(1)) lines.push(`${lead}${QUOTE_INDENT}${tone(row)}`);
      if (item.before) {
        const agent = wrapLine(`after the agent said: ${item.before.replace(/\s+/g, " ").trim()}`, quoteRoom);
        const shown = agent.slice(0, AGENT_ROWS);
        if (agent.length > AGENT_ROWS)
          shown[AGENT_ROWS - 1] = `${truncate(shown[AGENT_ROWS - 1].trimEnd(), quoteRoom - 1, "")}…`;
        for (const row of shown) lines.push(`${lead}${QUOTE_INDENT}${style.faint(row)}`);
      }
      lines.push("");
    });
    lines.push(
      hints([
        ["↑↓", "quote"],
        ["←", "back"],
      ]),
    );
    return lines;
  }

  function edit(editor: Editor): LiveFrame {
    const top = header(`Edit proposal ${selected + 1}`);
    const frame = editor.frame(
      hints([
        ["enter", "save"],
        ["esc", "cancel"],
      ]),
    );
    return {
      lines: [...top, ...frame.lines],
      cursor: frame.cursor && { ...frame.cursor, row: frame.cursor.row + top.length },
    };
  }

  function split(parts: string[]): string[] {
    return [
      ...header(`Split proposal ${selected + 1}`, `into ${parts.length}, each with the same quotes`),
      ...parts.flatMap((part, index) => [
        ...wrapLine(part, width() - 6).map(
          (row, rowIndex) => `  ${rowIndex ? " " : style.brand(String(index + 1))}  ${row}`,
        ),
        "",
      ]),
      hints([
        ["enter", "split"],
        ["esc", "cancel"],
      ]),
    ];
  }

  screen.setRenderer(() => {
    if (mode.kind === "edit") return edit(mode.editor);
    if (mode.kind === "detail") return { lines: detail(mode.quote) };
    if (mode.kind === "split") return { lines: split(mode.parts) };
    return { lines: list() };
  });

  return new Promise((resolve) => {
    const finish = () => {
      keyboard.stop();
      screen.setRenderer(() => ({ lines: [] }));
      screen.refresh();
      const decided = dream.pending.filter((proposal) => verdicts.has(proposal));
      screen.commit([
        "",
        ...decided.map((proposal) => `${MARK[verdictOf(proposal)]} ${truncate(proposal.text, width() - 2)}`),
      ]);
      screen.flush();
      const result = {
        approve: count("approve"),
        reject: count("reject"),
        skip: count("skip"),
        waiting: count("none"),
      };
      settle(dream, verdicts);
      resolve(result);
    };

    const onList = (key: Key) => {
      if (key.name === "up") selected = Math.max(0, selected - 1);
      else if (key.name === "down") selected = Math.min(dream.pending.length - 1, selected + 1);
      else if (key.text === " ") verdicts.set(current(), NEXT[verdictOf(current())]);
      else if (key.name === "right") mode = { kind: "detail", quote: 0 };
      else if (key.text === "e") {
        const editor = new Editor([]);
        editor.text = current().text;
        editor.cursor = editor.text.length;
        mode = { kind: "edit", editor };
      } else if (key.text === "s") {
        const parts = sentences(current().text);
        if (parts.length > 1) mode = { kind: "split", parts };
      } else if (key.text === "q" || key.name === "escape") return finish();
    };

    const onKey = (key: Key) => {
      if (key.ctrl && key.name === "c") return finish();
      if (mode.kind === "list") onList(key);
      else if (mode.kind === "detail") {
        const last = current().evidence.length - 1;
        if (key.name === "up") mode.quote = Math.max(0, mode.quote - 1);
        else if (key.name === "down") mode.quote = Math.min(last, mode.quote + 1);
        else if (key.name === "left" || key.name === "escape") mode = { kind: "list" };
      } else if (mode.kind === "edit") {
        // Up and down would browse the prompt history, which has nothing to do with a memory.
        if (key.name === "up" || key.name === "down") return;
        if (key.name === "escape") mode = { kind: "list" };
        else if (mode.editor.handle(key) === "submit") {
          const text = mode.editor.text.trim();
          if (text) current().text = text;
          mode = { kind: "list" };
        }
      } else if (mode.kind === "split") {
        if (key.name === "escape") mode = { kind: "list" };
        else if (key.name === "enter") {
          const original = current();
          const parts = mode.parts.map((text) => ({ ...original, text }));
          dream.pending.splice(selected, 1, ...parts);
          verdicts.delete(original);
          mode = { kind: "list" };
        }
      }
      screen.refresh();
    };

    keyboard.set(onKey);
    keyboard.start();
    screen.refresh();
  });
}

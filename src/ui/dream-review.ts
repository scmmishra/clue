import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { columns, style, wrapLine } from "./ansi";
import { openEditor } from "./open-editor";
import { Keyboard, type Key } from "./screen";
import { decide, saveDream, type Dream, type Proposal } from "../dream/store";

// Shows each pending proposal of a dream, one at a time, and records the user's verdict.
// Every verdict is saved at once, so quitting keeps the ones already made.

const EVIDENCE_CHARS = 220;
const KEYS = "a approve · e edit · r reject · s skip · q quit";

const write = (lines: string[]) => process.stdout.write(`${lines.join("\n")}\n`);

const wrapped = (text: string, indent: string) =>
  text.split("\n").flatMap((line) => wrapLine(line, columns() - indent.length - 1).map((part) => indent + part));

function show(proposal: Proposal, text: string, position: string) {
  const lines = ["", style.muted(position), ...wrapped(style.accent(text), "  ")];
  if (proposal.replaces) lines.push("", style.orange("  Replaces"), ...wrapped(style.muted(proposal.replaces), "    "));
  if (proposal.evidence.length) lines.push("", style.muted("  Evidence"));
  for (const item of proposal.evidence) {
    const date = item.at === null ? "" : `${new Date(item.at).toISOString().slice(0, 10)}  `;
    const quote = item.text.replace(/\s+/g, " ").slice(0, EVIDENCE_CHARS);
    lines.push(...wrapped(style.faint(`${date}"${quote}"`), "    "));
  }
  lines.push("", style.faint(`  ${KEYS}`));
  write(lines);
}

function readKey(keyboard: Keyboard): Promise<Key> {
  return new Promise((resolve) => keyboard.set(resolve));
}

// Opens the memory's text in the editor. Returns the edited text, or the old text if it came back empty.
async function editText(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "clue-dream-"));
  const file = join(dir, "memory.md");
  writeFileSync(file, `${text}\n`);
  const { editor, code } = await openEditor(file);
  const edited = readFileSync(file, "utf8").trim();
  rmSync(dir, { recursive: true, force: true });
  if (code !== 0) write([style.red(`  ${editor} didn't save the edit.`)]);
  return code === 0 && edited ? edited : text;
}

export async function reviewProposals(dream: Dream) {
  const keyboard = new Keyboard();
  const total = dream.pending.length;
  let reviewed = 0;
  // Each proposal comes up once per review. A skipped one goes to the end and waits for the next.
  for (let index = 1; index <= total; index++) {
    const proposal = dream.pending[0];
    let text = proposal.text;
    show(proposal, text, `Proposal ${index} of ${total}`);
    let verdict: "approve" | "reject" | "skip" | "quit" | null = null;
    while (!verdict) {
      keyboard.start();
      const key = await readKey(keyboard);
      keyboard.stop();
      if (key.ctrl && key.name === "c") verdict = "quit";
      else if (key.text === "a") verdict = "approve";
      else if (key.text === "r") verdict = "reject";
      else if (key.text === "s") verdict = "skip";
      else if (key.text === "q" || key.name === "escape") verdict = "quit";
      else if (key.text === "e") {
        text = await editText(text);
        show(proposal, text, `Proposal ${index} of ${total}, edited`);
      }
    }
    if (verdict === "quit") break;
    decide(dream, verdict, text);
    saveDream(dream);
    reviewed += 1;
    const said = {
      approve: style.green("  Approved."),
      reject: style.red("  Rejected."),
      skip: style.muted("  Skipped."),
    };
    write([said[verdict]]);
  }
  return reviewed;
}

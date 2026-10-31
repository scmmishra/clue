import { basename } from "node:path";
import { listSessions, type SessionMeta } from "../session";
import { columns, pad, rows, style, truncate, width } from "./ansi";
import type { Key, Keyboard, Screen } from "./screen";

const MAX_ROWS = 12;
const LABEL_WIDTH = 24;
const FOLDER_WIDTH = 16;

export function ago(at: number) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// One row of the list. The name or ID comes first, because it is what tells sessions apart, and
// what `clue -r <id or name>` takes. The folder is only its last part, so the title gets the room.
export function sessionRow(meta: SessionMeta, widths: { label: number; folder: number }, max: number, active: boolean) {
  const label = pad(truncate(meta.name ?? meta.id, widths.label), widths.label);
  const folder = pad(truncate(basename(meta.cwd), widths.folder), widths.folder);
  const right = `${pad(ago(meta.updated), 9)} ${String(meta.prompts).padStart(4)}`;
  const titleWidth = Math.max(10, max - widths.label - widths.folder - width(right) - 10);
  const title = pad(truncate(meta.title || "(empty)", titleWidth), titleWidth);
  const marker = active ? style.accent("›") : " ";
  const shown = active ? style.bold(label) : style.muted(label);
  return ` ${marker} ${shown}  ${active ? title : style.muted(title)}  ${style.muted(folder)}  ${style.faint(right)}`;
}

// Lists every past session, current folder first. Typing searches folders,
// titles and prompts through the SQLite index.
export function pickSession(screen: Screen, keyboard: Keyboard, cwd: string): Promise<SessionMeta | null> {
  return new Promise((resolve) => {
    let query = "";
    let selected = 0;
    let offset = 0;
    let items: SessionMeta[] = [];
    const load = () => {
      const all = listSessions(query);
      items = [...all.filter((meta) => meta.cwd === cwd), ...all.filter((meta) => meta.cwd !== cwd)];
      selected = Math.min(selected, Math.max(0, items.length - 1));
    };
    load();

    const visible = () => Math.min(MAX_ROWS, Math.max(3, rows() - 6));

    screen.setRenderer(() => {
      const max = columns() - 1;
      const lines = [`  ${style.muted("filter")} ${style.accent("›")} ${query}${style.inverse(" ")}`, ""];
      if (items.length === 0) lines.push(`  ${style.muted(query ? "No session matches." : "No saved sessions yet.")}`);
      const height = visible();
      if (selected < offset) offset = selected;
      if (selected >= offset + height) offset = selected - height + 1;
      const shown = items.slice(offset, offset + height);
      const widths = {
        label: Math.min(LABEL_WIDTH, Math.max(...shown.map((meta) => width(meta.name ?? meta.id)), 8)),
        folder: Math.min(FOLDER_WIDTH, Math.max(...shown.map((meta) => width(basename(meta.cwd))), 6)),
      };
      for (const [index, meta] of shown.entries())
        lines.push(sessionRow(meta, widths, max, offset + index === selected));
      if (items.length > height) lines.push(`  ${style.faint(`${items.length - height} more`)}`);
      lines.push("", `  ${style.faint("↑↓ pick   type to filter   enter resume   esc cancel")}`);
      return { lines };
    });

    const finish = (choice: SessionMeta | null) => {
      screen.setRenderer(() => ({ lines: [] }));
      screen.flush();
      resolve(choice);
    };

    keyboard.set((key: Key) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(null);
      if (key.name === "enter") return finish(items[selected] ?? null);
      if (key.name === "up" || (key.ctrl && key.name === "p")) selected = Math.max(0, selected - 1);
      else if (key.name === "down" || (key.ctrl && key.name === "n"))
        selected = Math.min(items.length - 1, selected + 1);
      else if (key.name === "backspace") {
        query = query.slice(0, -1);
        load();
      } else if (key.name === "char" || key.name === "paste") {
        query += key.text ?? "";
        selected = 0;
        load();
      }
      screen.refresh();
    });
  });
}

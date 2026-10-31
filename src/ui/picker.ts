import { listSessions, type SessionMeta } from "../session";
import { columns, homePath, pad, rows, style, truncate, width } from "./ansi";
import type { Key, Keyboard, Screen } from "./screen";

const MAX_ROWS = 12;

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
      const folderWidth = Math.min(
        28,
        Math.max(...items.slice(offset, offset + height).map((meta) => width(homePath(meta.cwd))), 8),
      );
      for (const [index, meta] of items.slice(offset, offset + height).entries()) {
        const active = offset + index === selected;
        // Cut long folders from the left, so the project name stays visible.
        const path = homePath(meta.cwd);
        const folder = pad(
          width(path) > folderWidth ? Bun.sliceAnsi(path, -folderWidth, undefined, "…") : path,
          folderWidth,
        );
        const right = `${pad(ago(meta.updated), 9)} ${String(meta.prompts).padStart(4)}`;
        const titleWidth = Math.max(10, max - folderWidth - width(right) - 8);
        const title = pad(
          truncate(meta.name ? `${meta.name} · ${meta.title}` : meta.title || "(empty)", titleWidth),
          titleWidth,
        );
        const line = `${active ? style.accent("›") : " "} ${active ? style.bold(folder) : style.muted(folder)}  ${active ? title : style.muted(title)}  ${style.faint(right)}`;
        lines.push(` ${line}`);
      }
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

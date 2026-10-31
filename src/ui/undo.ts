import type { UndoResult } from "../agent/undo";
import { display } from "../tools/files";
import { style } from "./ansi";

export function undoReport(result: UndoResult, cwd: string) {
  if (result.kind === "empty") return [`  ${style.muted("Nothing to undo.")}`, ""];
  const show = (paths: string[]) => paths.map((path) => display(cwd, path));
  if (result.kind === "changed") {
    return [
      `  ${style.orange("These files changed after that turn, so nothing was undone:")}`,
      ...show(result.paths).map((path) => `  ${style.muted(path)}`),
      `  ${style.faint("Run /undo force to overwrite them.")}`,
      "",
    ];
  }
  return [
    ...show(result.restored).map((path) => `  ${style.muted(`Restored ${path}`)}`),
    ...show(result.deleted).map((path) => `  ${style.muted(`Deleted ${path} (the turn created it)`)}`),
    ...show(result.failed).map((path) => `  ${style.red(`Could not undo ${path}`)}`),
    ...(result.ranShell ? [`  ${style.faint("Shell commands from that turn weren't undone.")}`] : []),
    "",
  ];
}

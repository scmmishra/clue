import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const MAX_TURNS = 20;

export type FileSnapshot = { content: Buffer; mode: number };

type TrackedFile = {
  // The path the tool wrote to, which is the key of its read stamp.
  file: string;
  // What the file held before the turn first changed it. Null means the turn created it.
  previous: FileSnapshot | null;
  // Hash of what the turn left, so a later change by someone else isn't overwritten.
  after: bigint | number;
};

type TurnChanges = { files: Map<string, TrackedFile>; ranShell: boolean };

export type UndoResult =
  | { kind: "empty" }
  | { kind: "changed"; paths: string[] }
  | { kind: "done"; restored: string[]; deleted: string[]; failed: string[]; ranShell: boolean };

export function snapshotFile(file: string): FileSnapshot | null {
  if (!existsSync(file)) return null;
  return { content: readFileSync(file), mode: statSync(file).mode & 0o7777 };
}

const contentHash = (file: string) => (existsSync(file) ? Bun.hash(readFileSync(file)) : null);

// Writes to a temporary file first, so a failed restore leaves the file as it was.
function restore(path: string, previous: FileSnapshot | null) {
  // Tracked paths are real paths, so a difference here means a symlink appeared since.
  if (realpathSync(dirname(path)) !== dirname(path)) throw new Error("its folder moved");
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("it is now a symlink");
  if (!previous) return rmSync(path, { force: true });
  const temporary = `${path}.clue-undo-${process.pid}`;
  try {
    writeFileSync(temporary, previous.content);
    chmodSync(temporary, previous.mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// The file changes of recent turns, in memory. Each /undo reverses one turn.
export class UndoStack {
  private turns: TurnChanges[] = [];
  private current: TurnChanges = { files: new Map(), ranShell: false };

  constructor(private readStamps = new Map<string, number>()) {}

  beginTurn() {
    this.current = { files: new Map(), ranShell: false };
  }

  noteShell() {
    this.current.ranShell = true;
  }

  // Call after a tool writes `file`, with the snapshot taken before the write.
  record(file: string, previous: FileSnapshot | null) {
    const path = realpathSync(file);
    const after = Bun.hash(readFileSync(path));
    const tracked = this.current.files.get(path);
    if (tracked) {
      tracked.after = after;
      return;
    }
    this.current.files.set(path, { file, previous, after });
    if (this.turns.at(-1) === this.current) return;
    this.turns.push(this.current);
    if (this.turns.length > MAX_TURNS) this.turns.shift();
  }

  undo(force = false): UndoResult {
    const turn = this.turns.at(-1);
    if (!turn) return { kind: "empty" };
    const files = [...turn.files];
    const changed = files.filter(([path, { after }]) => contentHash(path) !== after).map(([path]) => path);
    if (changed.length && !force) return { kind: "changed", paths: changed };
    this.turns.pop();
    const result = {
      kind: "done" as const,
      restored: [] as string[],
      deleted: [] as string[],
      failed: [] as string[],
      ranShell: turn.ranShell,
    };
    for (const [path, { file, previous }] of files) {
      // A timestamp alone can't show the change, because a coarse clock may give the restore the same one.
      this.readStamps.delete(file);
      try {
        restore(path, previous);
        (previous ? result.restored : result.deleted).push(path);
      } catch {
        result.failed.push(path);
      }
    }
    return result;
  }
}

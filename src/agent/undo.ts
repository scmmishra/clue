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

type TurnChanges = { id: number; files: Map<string, TrackedFile>; ranShell: boolean };

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

// The file changes of recent turns, in memory. /undo reverses one turn, and a rewind reverses several.
export class UndoStack {
  private turns: TurnChanges[] = [];
  private current: TurnChanges = { id: 0, files: new Map(), ranShell: false };
  // Turns before this one have no snapshots, such as turns from before a resume.
  private floor = 0;

  constructor(private readStamps = new Map<string, number>()) {}

  startAt(id: number) {
    this.floor = id;
  }

  // `id` is the position of the turn's prompt in the transcript.
  beginTurn(id = 0) {
    this.current = { id, files: new Map(), ranShell: false };
  }

  private track() {
    if (this.turns.at(-1) === this.current) return;
    this.turns.push(this.current);
    if (this.turns.length <= MAX_TURNS) return;
    this.turns.shift();
    this.floor = this.turns[0].id;
  }

  noteShell() {
    this.current.ranShell = true;
    this.track();
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
    this.track();
  }

  // Whether clue can restore everything changed since the turn with this id.
  covers(id: number) {
    return id >= this.floor;
  }

  summary(id: number) {
    const turn = this.turns.find((candidate) => candidate.id === id);
    return { files: turn?.files.size ?? 0, ranShell: turn?.ranShell ?? false };
  }

  // Drops the snapshots of a turn and those after it, and leaves the files alone.
  forgetFrom(id: number) {
    this.turns = this.turns.filter((turn) => turn.id < id);
  }

  undo(force = false): UndoResult {
    const turn = this.turns.findLast((candidate) => candidate.files.size > 0);
    return turn ? this.reverse([turn], force) : { kind: "empty" };
  }

  // Reverses the turn with this id and every turn after it.
  rewindTo(id: number, force = false) {
    return this.reverse(
      this.turns.filter((turn) => turn.id >= id),
      force,
    );
  }

  private reverse(turns: TurnChanges[], force: boolean): UndoResult {
    // Oldest first: each file goes back to its first snapshot, and is compared with its last write.
    const files = new Map<string, TrackedFile>();
    for (const turn of turns) {
      for (const [path, tracked] of turn.files) {
        const first = files.get(path);
        files.set(path, first ? { ...first, after: tracked.after } : tracked);
      }
    }
    const entries = [...files];
    const changed = entries.filter(([path, { after }]) => contentHash(path) !== after).map(([path]) => path);
    if (changed.length && !force) return { kind: "changed", paths: changed };
    this.turns = this.turns.filter((turn) => !turns.includes(turn));
    const result = {
      kind: "done" as const,
      restored: [] as string[],
      deleted: [] as string[],
      failed: [] as string[],
      ranShell: turns.some((turn) => turn.ranShell),
    };
    for (const [path, { file, previous }] of entries) {
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

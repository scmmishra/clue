// Every test runs against a throwaway clue home, never the user's ~/.clue.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLUE_HOME = mkdtempSync(join(tmpdir(), "clue-home-"));

import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

// The file a tool names. A leading ~/ is the home folder, as the shell reads it.
export const absolute = (cwd: string, path: string) => {
  const expanded = path.replace(/^~(?=\/)/, homedir());
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
};

// True for the root itself and for anything below it. A sibling such as /proj-other is not inside /proj.
export function isInside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

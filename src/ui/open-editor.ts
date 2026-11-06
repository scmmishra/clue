// Opens a file in the user's editor and waits for it to close. Returns the editor's exit code,
// or null when it could not start.
export async function openEditor(file: string, chosen?: string) {
  const editor = chosen ?? process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  try {
    const proc = Bun.spawn([...editor.trim().split(/\s+/), file], { stdio: ["inherit", "inherit", "inherit"] });
    return { editor, code: await proc.exited };
  } catch {
    return { editor, code: null };
  }
}

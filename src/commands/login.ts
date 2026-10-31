import { antInstalled, removeKey, resolveAuth, storeKey } from "../auth";
import { style } from "../ui/ansi";

// With `ant` installed, `clue login` runs `ant auth login`, and the SDK reads
// the profile it saves. Without it, clue asks for an API key and stores it in
// the OS keychain.

function readHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    let value = "";
    const onData = (data: string) => {
      for (const char of data) {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.off("data", onData);
          process.stdin.pause();
          process.stdout.write("\n");
          return resolve(value.trim());
        }
        if (char === "\x03") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\x7f") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
      process.stdout.write(`\r${question}${"•".repeat(Math.min(value.length, 40))}\x1b[K`);
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

export async function login() {
  if (antInstalled()) {
    console.log(style.muted("Signing in with `ant auth login`…"));
    const proc = Bun.spawn(["ant", "auth", "login"], { stdio: ["inherit", "inherit", "inherit"] });
    process.exit(await proc.exited);
  }
  if (!process.stdin.isTTY) {
    console.error("clue login needs a terminal. Set ANTHROPIC_API_KEY instead.");
    process.exit(2);
  }
  console.log(`Paste a Claude API key. Create one at ${style.blue("https://platform.claude.com/settings/keys")}`);
  const key = await readHidden(`${style.accent("›")} `);
  if (!key.startsWith("sk-ant-")) {
    console.error(style.red("That doesn't look like a Claude API key (they start with sk-ant-)."));
    process.exit(1);
  }
  const where = await storeKey(key);
  console.log(`${style.green("Saved")} in ${where}.`);
  const auth = await resolveAuth();
  if (auth.source !== "clue-login") {
    console.log(
      style.muted(
        `Note: clue uses ${auth.source === "env" ? "ANTHROPIC_API_KEY from your environment" : "your ant profile"} first, before this key.`,
      ),
    );
  }
}

export async function logout() {
  await removeKey();
  console.log("Removed the key saved by clue login.");
  if (antInstalled()) console.log(style.muted("To sign out of ant too, run `ant auth logout`."));
}

# Changelog

All notable changes to clue are listed here. The release workflow publishes the section for the version in `package.json` as that release's notes.

## Unreleased

- `/fast` and `--fast` turn on fast mode for Opus 5.5 and Opus 5: faster replies at twice the token price. The line under the input and the footer of each reply show `fast`. Set `"fast": true` in `settings.json` to start with it on.
- The line under the input shows what the session has cost so far, the same total as `/cost`.
- Deny and ask shell rules now also match a command behind `time`, `env`, `timeout` or a leading `NAME=value`, a bare command (`git push` for `git push *`), multi-line commands and lines clue can't parse. Allow rules stay strict.
- In `auto` mode, input that Claude sends to a running shell process now goes to review, deny and ask rules match it, and the approval prompt shows it.
- clue asks you before running an action too long for the reviewer to read in full. Before, the reviewer read only the first part and its approval covered the rest.
- `auto` mode reviews writes that reach a sensitive or outside file through a link or a different letter case, and `.mcp.json` counts as sensitive. Permission rules for file paths match `./`, absolute, relative and linked spellings of the same file.
- A path that starts with `~/` now means your home folder in the file tools. Before, it made a folder named `~` in the project.
- `auto` mode sends build and test commands to review when their flags load code or config from elsewhere, or point outside the project, such as `make -f`, `go test -exec`, `bun test --preload` or `prettier --write ~/file`.
- An "always allow" answer on a command such as `time cargo publish` now covers `cargo`, not every program behind `time`, `env` or `timeout`.
- The permission prompt ignores `y`, `enter` and `a` for 300 ms after it opens, so keys typed for a steering message can't approve an action. `n` and `esc` work at once.
- clue warns about permission rules with a value other than `allow`, `ask` or `deny`, or with an unknown tool name, and ignores those rules. An invalid `CLUE_PERMISSION_MODE` now stops clue with status 2.
- Approving a project MCP server now covers its command, arguments, environment, URL and headers. If `.mcp.json` changes any of them, the server waits for approval again. Project servers need one new approval after this update.
- clue no longer overwrites an MCP file it can't read. It warns at startup and in `clue doctor`, and `clue mcp add`, `remove` and `approve` stop with an error.
- `clue mcp login` shows a connection error at once instead of waiting five minutes for the browser, and it says when a server needs no sign-in.
- Inside a subagent, the reviewer now gets the prompt you wrote. Before, it treated the task Claude wrote for the subagent as your request.
- Commands now get the environment of the current launch, plus what your startup files add. Before, they got the variables saved at an earlier launch, so `AWS_PROFILE=dev clue` could still run with `prod`.
- Shell commands and MCP servers no longer get `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `OPENROUTER_API_KEY`, and `~/.clue/shell-env.json` no longer stores them. A project whose tests call those APIs needs its key set another way.
- A background process started by a shell startup file no longer holds up commands.
- Closing the terminal now stops running commands, and so does `SIGTERM` or `SIGHUP` to `clue ask`. A command that ignores `SIGTERM` gets `SIGKILL` when clue exits.
- `/undo` and rewind now say when a turn ran shell commands. The `shell` tag in rewind never appeared before.
- The session cost is more complete. It now counts automatic compactions, turns that failed partway, and the request that warms the cache on resume. `/cost` still shows the total after a rewind to the first prompt.
- Resuming a session warms the cache on the first key you type, so opening a session only to read it costs nothing. `/` commands don't trigger it.
- A turn that loses fast mode partway pays the fast price only for its fast requests.
- A session whose first request failed can be resumed with the id clue printed.
- A missing turn record, such as after a crash, no longer shifts footers and rewind points onto the wrong prompts. Typing `Continue with the task.` or starting a first prompt with `<context>` no longer hides that prompt.
- After a compaction during a long run, Claude gets your project instructions and git state again. The prompt after a `/compact` no longer runs a second compaction.
- Rewind now restores the files of a turn that followed a crash.
- Finding a session no longer depends on the session index. If the index is broken or has lost a session, clue reads the session files, so ids, names and `clue -r` keep working. `clue doctor` reports a broken index.
- A session opens in one clue at a time. A second clue stops with a message, because two processes writing one file could leave it unable to resume.
- `clue -c` no longer picks up a session from another folder whose path maps to the same key.
- `clue -r <prefix>` lists every session that matches an id prefix instead of picking the newest.
- `clue ask --resume` is gone. `clue ask` always starts a new session, and it stops with a message if you pass `--resume`. `clue -r <id>` still continues a session in the interactive shell, and `--json` still reports `session_id`.

## 0.8.1

- Pasting an image from the clipboard is about 9x faster, around 30 ms instead of 290 ms. clue reads the image directly instead of starting `osascript`.
- `auto` mode runs more everyday commands without a review: `cd` into the project, `find` without `-exec` or `-delete`, `sed -n '1,20p'`, `test`, `seq`, checksums, version checks such as `node --version`, `bun check` and `bun fmt`. A command can also end with `2>&1` or `>/dev/null`, or start with `timeout 60`, `time`, `env -u NAME` or a variable such as `NO_COLOR=1`.
- Claude Haiku reviews actions by default, even when `OPENROUTER_API_KEY` is set. To keep Jev, set `"review": { "provider": "openrouter" }` in `settings.json`.

## 0.8.0

- Rewind lists prompts oldest first, like the scrollback. The cursor starts on the newest prompt at the bottom, and `up` goes further back.
- Rewind shows when each prompt was sent: minutes ago for the last 30 minutes, then the time, and the date too for an earlier day. Before, prompts from the same hours all read `3h ago`.
- `clue -r` and `/resume` list only the sessions of the current folder, without a folder column. `clue -r <id or name>` still resumes a session from any folder.
- `Enter` during a run steers the turn. clue sends the message with the next tool results, so Claude reads it before its next step, and the message shows where Claude got it. If the turn ends first, it goes as the next prompt. `Tab` still queues a message for after the turn. Before, both keys queued.
- A pasted image path that the terminal sent in pieces, as Ghostty can for a CleanShot capture, showed the path after `[Image #1]`. clue now waits for the whole paste, so only the placeholder shows.
- When the reviewer flags an action, or can't finish the review, clue asks you with the reviewer's reason instead of holding it. `clue ask` still holds it.
- The reviewer treats deleting temporary files, such as `rm -rf` under `/tmp`, as routine cleanup.
- The approval prompt shows the whole command, wrapped, instead of cutting it at the edge. A reviewer's reason shows on its own line.
- Claude writes checks that exit 0 when they pass, such as `test ! -e` after a deletion, so a successful check no longer shows as failed.
- `ctrl+v` with text on the clipboard pastes the text, instead of saying `No image on the clipboard.`
- A dragged macOS screenshot attaches. Its name has a narrow space before `AM` or `PM`, which cut the path short, so it stayed as text.

## 0.7.4

- `/model`, `/effort` and `/permissions` with no argument open a list you can choose from.
- `clue -r` leads each row with the session's name or ID, and shows only the folder's name.

## 0.7.3

- A key pressed while clue read your shell startup files could suspend it with `suspended (tty input)`. The read no longer touches your terminal.

## 0.7.2

- Shell commands can use your aliases and functions in zsh and bash. An alias or function named after a real program, such as `grep`, stays out, so standard tools behave the same.
- clue reruns your shell startup files after more kinds of change, such as a new `ZDOTDIR` or an edit to a file in `/etc`.
- `esc esc` at an idle prompt opens rewind. Pick an earlier prompt to restore the files and cut the conversation back to it, or press `tab` to keep the files.

## 0.7.1

- `/compact` replaces the conversation with a summary when you ask. Images and file contents don't survive it, so Claude reads files again when it needs them.

## 0.7.0

- `/undo` restores the files that clue changed in the last turn. It refuses if those files changed since, unless you run `/undo force`. It keeps the conversation, and it can't undo shell commands.
- `glob_files` no longer blocks the screen while it walks a large folder, and the `@` picker lists files faster outside git.
- `shift+tab` switches between the `ask`, `auto` and `full-access` permission modes.
- `/usage` shows how full the context is, plus cost, tokens and cache use. `/cost` shows the same report.
- `clue doctor` checks the version, credentials, API access, settings, tools, terminal and MCP servers.

## 0.6.0

- `shift+enter` adds a new line in terminals that can report it.
- Arrow keys, `home`, `end` and `delete` work in terminals that report caps lock or num lock with each key.
- `@` opens a file picker. Type to search files and folders, then press `enter` to add the path to your message. `tab` opens a folder and searches inside it.

## 0.5.1

- The stream an MCP server keeps open while clue is idle is no longer compressed. A broken compressed stream could print a `ZlibError` line over your input.
- Resuming a session restores the conversation into your scrollback, up to the last 1 MB, instead of only the last screen.
- `clue config unset` removes a setting, so it goes back to its default.

## 0.5.0

- `clue config` shows, opens and changes settings, with `show`, `path`, `edit` and `set`.
- clue warns at startup if `settings.json` has a problem, such as broken JSON that turns your permission rules off.
- A multi-line command takes one row in the tool tree, and no longer repeats the row in the scrollback while it runs.
- In a short terminal, a long prompt or reply no longer leaves duplicate rows in the scrollback.
## 0.4.1

- The `review` setting chooses the reviewer, with `provider` and `model`. It replaces `review_model`.
- If a reviewer fails, Claude Haiku at low effort reviews instead, so one provider's outage or limit no longer holds every action.
- `$?` no longer sends a command to review.

## 0.4.0

- Releases are compressed, so a download is about 58% smaller.
- `clue upgrade` compares versions, so it never replaces a newer build with an older release.
- `install.sh` and `clue upgrade` run the new binary before they install it, and keep the old one if it doesn't start.
- `clue upgrade` refuses to replace a local build.
## 0.3.0

- `clue "prompt"` runs the prompt as the first turn. It also works with `-c`.
- `--name` now opens the session with that name in this folder, or creates it. An existing session is resumed and the prompt isn't sent, so a tool can run the same command every time. It no longer fails on a taken name.
- `install.sh` and `clue upgrade` show each step and a download progress bar.

## 0.2.0

- `clue upgrade` installs the latest release.
- Sessions can have a name. `clue --name <name>` starts a named session, `/rename` changes the name, and `clue -r <name>` resumes it. The ID stays, and `clue ask --resume` still takes only an ID.
- In a multiple-choice question, a typed answer now adds to the picked options instead of replacing them.
- The prompt bar, the tool dot and the spinner are blue, and secondary text is one even grey. Prompts are no longer bold.
- Copying a sent prompt no longer picks up the `┃` bar or extra line breaks. The bar shows on its first line only, and the terminal wraps the rest.
- Pasting or dragging an image file adds it to the prompt as `[Image #1]`. `ctrl+v` and `/paste` attach an image from the clipboard on macOS.
- You can type while clue works. `Tab` or `Enter` queues one message, and `↑` takes it back to edit.
- A message that starts with a path, such as `/tmp/a.png`, is no longer read as a slash command.
- `auto` mode now parses shell commands instead of matching them with a regex. A background `&`, a newline, or a program that runs other programs, such as `env`, `find` or `node`, now goes to review. The list of routine commands is shorter, so some commands that used to run directly are now reviewed.
- Allow rules, deny rules and "always allow" answers now apply to each command in a chain. Deny rules also apply to read-only tools.
- clue rings the terminal bell when it needs you, and when a turn ends after 30 seconds or more without input from you. Set `"bell": false` in `settings.json` to turn it off.
- clue tells the terminal when it is idle, working, waiting for you, finished or failed, through the Program Status Protocol (OSC 7501).
- The footer after each reply shows tokens in and out. Tokens in include cached input.
- `clue mcp add <name> -- <command>`, `clue mcp add --project` and `clue mcp approve --all` now work as they do in `/mcp`.
- A session that crashed during a tool call can continue. clue records the unfinished calls as failed before the next message.
- A half-written line in a session file no longer hides the records after it.
- A 400 from the API turns off an optional feature only when the error names that feature. A 400 that names none is reported as an error.

## 0.1.0

The first release.

- An interactive terminal agent on Claude's Messages API. It starts with Claude Opus 5.5 at medium effort.
- `clue ask` runs one request without the interactive screen. `--json` prints the result as JSON.
- Sessions are saved per project. `clue -c` resumes the last one and `clue -r` picks one. A resumed session sends its history to the cache while you type.
- Tools: read, find, search, write and edit files, shell commands with a terminal, web search, web fetch, subagents, skills and questions to the user.
- MCP servers over stdio, HTTP and SSE, with OAuth sign-in. Claude finds their tools through `capability_search`, so the tool list stays the same and stays cached.
- Permission modes `ask`, `auto` and `full-access`. In `auto`, a reviewer model checks risky actions before they run.
- Sign in with `ant auth login`, or store an API key with `clue login`.
- A single binary for macOS and Linux, on arm64 and x86_64, installed with `install.sh`. It starts in about 7 ms.

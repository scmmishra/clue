# Changelog

All notable changes to clue are listed here. The release workflow publishes the section for the version in `package.json` as that release's notes.

## 0.16.2

- clue no longer has the `glob_files` and `grep_files` tools. Claude already ran `rg`, `grep`, `find` and `ls` through `shell` about 5 times as often, and `glob_files` was called 19 times across 128 sessions. A `permission.glob_files` or `permission.grep_files` rule in your settings now shows as "isn't a tool" in `clue doctor`.

## 0.16.1

- Skills now show in the `/` menu after the built-in commands. `/skill-name some task` starts a turn that tells Claude to use that skill. A skill can't replace a built-in command of the same name, and only names made of letters, digits, `_` and `-` show up.
- Before Claude quotes tool output into an issue, pull request, comment or anything else that leaves your machine, the system prompt tells it to remove API keys, tokens, passwords and your home folder path.
- clue marks its tools as strict, so the API only lets Claude write tool input that matches each tool's schema. Before, Claude could write a call that wasn't valid JSON, and the same broken call came back on every retry. `mcp_call` isn't strict, because its arguments follow each MCP tool's own schema. The first request after a schema changes can take about 20 seconds while the API compiles the schemas. The API keeps a compiled schema for 24 hours after its last use.

## 0.16.0

- Sessions now load the memories you approved with `clue dream`. They go in the context with the first prompt, after the repository's instruction files, in every worktree of the repository. Proposals you haven't reviewed and ones you rejected don't load. clue finds the repository by reading its `.git` files, without running git.

## 0.15.0

- `clue dream` is an experiment that proposes memories from this repository's past sessions. It reads the messages you typed after each session's first prompt. Jev keeps the ones that guide the agent, such as corrections, and Sonnet turns them into at most 10 proposals, each with your quotes as evidence. You review them in a list: `space` approves, rejects or skips, `e` edits, `s` splits a proposal into one per sentence, and `→` shows the quotes with what the agent said before each one. Approved memories go to `~/.clue/dreams/`. Nothing loads them into a session yet. A later dream reads only new messages, and doesn't propose what you rejected. `--include-cc` also reads Claude Code's transcripts for the repository. It needs `OPENROUTER_API_KEY`.
- When Claude writes a tool call that isn't valid JSON, such as one with a raw tab inside a string, clue asks again instead of ending the turn with `Unable to parse tool parameter JSON`. clue had this retry before, but it never matched the error the SDK throws.

## 0.14.2

- `clue doctor` names the models that review actions in `auto` mode and pick what `/copy` copies. Without `OPENROUTER_API_KEY`, it says the key would switch them from Haiku to Jev and Decider. A `review` or `copy` setting that can't work shows as a warning.

## 0.14.1

- The install command is shorter: `curl -fsSL https://clue.shivam.dev/install | bash`. The old URL still works.
- Resuming a long session is a little faster. clue matched each prompt to its turn by searching every turn, and now looks it up once per pass. On a 120-prompt session that saves about 0.4 ms.

## 0.14.0

- In a long session, each request sends only the messages since Claude's last reply, not the whole conversation. Claude's API keeps the conversation for a few minutes as a message thread, so it has less to read before the first token. Tokens and cost don't change. If the API can't continue the thread, clue sends the whole conversation, as before.
- Reads and searches start as soon as Claude finishes writing each call, while the rest of the reply still streams. Before, every call waited for the whole reply. In a test with three searches spaced 300 ms apart, the wait between the reply's end and the next request went from 239 ms to 88 ms. A call that writes, asks you, or needs approval still waits for the reply, and so does every call after it.
- `clue usage` reports what clue cost across every session: the total, the median and p90 per session and per prompt, the cost per model, how much input came from the cache, how often a pause between prompts outlived the 5-minute cache, what compactions and resume warm-ups cost, and the five most expensive sessions. `--here` limits it to the current folder, and `--since 30d` to recent activity.
- `/effort` says when the next request starts a fresh cache, as `/model` and `/fast` do. A new effort keeps the cache only up to Claude's first reply, so the next request writes almost the whole conversation again. The note shows only once the session has a reply and the effort changed.

## 0.13.0

- Claude can run a subagent on a different model or effort, such as Haiku for a simple search. Each subagent row shows its model, its tool calls and how long it ran, with a mark when it finishes. The model is grey when the subagent uses yours. Its effort shows only when it differs from yours. A subagent that waits for the one before it says `waiting`. A tree of only subagents reads `3 subagents · 1 running`, without `Subagent:` on each row.
- One `esc` interrupts a running turn. Before, it took two. `esc esc` during a run interrupts it and then opens rewind, the same as `esc esc` at an idle prompt.
- Conversations compact at 80% of the window left after the longest reply, about 749k tokens of 1M, instead of the API's default of 150k. Long sessions keep more of their history. A model clue doesn't know still compacts at 150k.
- clue compacts conversations itself, with its own summary prompt, instead of the API's compaction. The latest messages, about 20k tokens of them, stay word for word, and Claude summarizes the rest. The summary keeps your instructions and exact errors, and leaves out file contents Claude can read again. Sessions the API compacted before still resume.
- Claude Sonnet 5.5 cache reads are priced at $0.10 per million tokens, not $0.20. Costs shown for Sonnet 5.5 sessions were too high.
- `/copy` works on Linux and over SSH. clue asks the terminal to set the clipboard with an OSC 52 code, so the copy lands on the computer in front of you, not on the server. On a local Mac it still uses `pbcopy`. The first copy in a session says how to allow clipboard access if nothing arrived.
- The input and running tools at the bottom no longer flicker while they redraw, in terminals with synchronized output, such as Ghostty, kitty, WezTerm, iTerm2 and Alacritty. Each redraw reaches the screen whole. Other terminals ignore it.
- The path in a `Read`, `Wrote` or `Edited` row links to the file, so a terminal with OSC 8 links opens it on click. Resumed sessions get the links too. The row looks the same.
- If clue exits partway through a redraw, it ends synchronized output, so the terminal can't be left waiting for the rest of the frame.
- A quick `esc esc` always opens rewind. When both presses reached clue together, such as over SSH or while clue was busy, they read as one alt+esc and did nothing.
- A web search row shows its query again. With the newer Claude models, the query arrived in a form clue did not read, so rows said `Searched the web for ""`. The code Claude writes to run those searches no longer shows as a search row.
- A prompt you send has the bar on every row, wrapped and blank lines included. Before, only the first line had it. clue wraps the prompt at the current width, so it does not reflow when you resize the window, and copying it includes the bars.

## 0.12.0

- Code blocks in replies are colored in more languages: Ruby, Python, Go, Rust, Java, Kotlin, Swift, C and C++, C#, PHP, Zig, shell, SQL, JSON, YAML, TOML, HTML, Vue, ERB, CSS, SCSS, Elixir, Lua, Dockerfile, Makefile and diffs. Before, only JavaScript and TypeScript were colored.
- A code block sits between two rules as long as its longest line, with the language in the top rule. Code lines have no `│` gutter, so a mouse selection of them copies only the code.
- clue marks each prompt you send with OSC 133, so a terminal's jump-to-prompt keys move between prompts in a session. In Ghostty on macOS, these are `cmd+↑` and `cmd+↓`. Resumed sessions are marked too.

## 0.11.0

- `/copy` puts the last reply on the clipboard as Markdown, without the gutters and line wraps on screen. `/copy <request>` copies only the parts you describe, such as `/copy the sql`. Perplexity's Decider picks them when `OPENROUTER_API_KEY` is set, and Haiku when it isn't. The `copy` setting chooses another model.
- `review.model` accepts any decision model on OpenRouter, such as `perplexity/pplx-decider-v1.2`. `decider` is a new short name next to `jev`. Both point to the latest version clue knows. Other short forms, such as `jev-1.14`, no longer work. Use the full id, such as `typesafe/jev-1.14`.
- New pairs of models in `/model`: `haiku 5.5 + sonnet`, `sonnet 5.5 + opus` and `opus 5.5 + fable`. The first model does the work, and asks the second for advice on hard steps. Start one with `--model sonnet+opus`, for example. Each answer shows as an `Asked <advisor>` row, and the cost of a reply includes it.
- In `/model`, `←` and `→` change the effort of the highlighted model.
- An interrupted reply now counts the tokens the API reported before the interrupt. Its cost shows with a `+`, such as `$0.03+`, because the API bills some output it never reports. `clue ask --json` adds `cost_is_minimum`.
- Haiku 5.5 is priced at its higher rate for a prompt over 100K tokens.
- A history warm-up on resume is priced at the model it ran on, even if you change the model during it.
- The reviewer in `auto` mode also sees your last few messages and the agent's latest tool calls, so it can tell how an action fits the work. Tool output goes only to a Claude reviewer.
- The reviewer clears reads of your own local files and databases, such as a `sqlite3` query on a history file. It still flags reads of credentials, and reads that send data off the machine.
- With no `review` setting, Jev reviews actions when `OPENROUTER_API_KEY` is set, and Haiku when it isn't. To keep Haiku, set `"review": { "provider": "anthropic" }`.

## 0.10.0

- `edit_file` takes a list of edits for one file, so several changes go in one call. If one edit fails, the file stays unchanged.
- `edit_file` no longer needs a `read_file` first, or an unchanged file. The exact `old_string` shows that Claude knows the text. `write_file` is unchanged.
- `edit_file` no longer has `replace_all`. It was unused in session logs. Use several edits, or `sed` through `shell`.
- In `auto` mode, more shell commands run without review. A backslash inside double quotes, as in `grep "a\|b"`, and a `~/` path no longer send a command to review. In past sessions, this covers about 110 of 543 commands.
- In `auto` mode, a shell command that names a file with secrets, such as `cat .env` or `cat ~/.ssh/id_rsa`, goes to review. Before, `cat .env` and absolute paths ran without review.

## 0.9.1

- `↑`, `↓`, `Ctrl+P` and `Ctrl+N` move through the `/` command list, and the list scrolls to show the selected command. Before, these keys browsed history.
- The `@` picker lists the files you're working on first: your changes, new files, then files from the last 50 commits, skipping commits that touch more than 20 files. A closer match still ranks higher.
- `grep_files` reads a pattern as a regular expression, then as literal text if that is invalid or finds nothing. Before, a pattern like `a|b` without the `regex` flag searched for those exact characters, which caused most empty searches in real sessions.

## 0.9.0

- `/fast` and `--fast` turn on fast mode for Opus 5.5 and Opus 5: faster replies at twice the token price. The line under the input and the footer of each reply show `fast`. Set `"fast": true` in `settings.json` to start with it on.
- The line under the input shows what the session has cost so far, the same total as `/cost`.
- Deny and ask rules hold in more of the ways a command can be written. They match the command after `time`, `timeout <duration>`, `env` and variable assignments, so `git push *` blocks `CI=1 git push`. They also match inside a loop or an `if`, across lines, and in a line clue can't parse, such as one with `$(...)`. A pattern that ends in ` *` also matches the bare command, so `git push *` blocks `git push`.
- A file rule for a path in the project also matches it with a leading `./` or as an absolute path.
- Text typed into a running process meets the rules for shell commands, so a deny on `git push *` also blocks typing `git push` into a shell that clue started.
- "Always allow" on `time cargo publish` allows `cargo *`, not every command that starts with `time`.
- `auto` mode reviews writes to `.mcp.json`, and to sensitive files whatever their case, such as `.ENV`.
- Startup warns about a rule for a tool that doesn't exist, or a value other than `allow`, `ask` or `deny`. A mistyped value no longer cancels an earlier deny. A bad `CLUE_PERMISSION_MODE` stops clue with an error instead of falling back to `auto`.
- Approving a project MCP server covers its current config. When the server's entry in `.mcp.json` changes, such as a new command after a `git pull`, clue asks again. Servers approved by an earlier version need approval once more.
- `clue ask --resume` is gone. `clue ask` always starts a new session, and it stops with a message if you pass `--resume`. `clue -r <id>` continues a session in the interactive shell, and `--json` still reports `session_id`.
- Commands now get the environment of the current launch, plus what your startup files add. Before, they got the variables saved at an earlier launch, so `AWS_PROFILE=dev clue` could still run with `prod`, and a venv or direnv folder could get the wrong `PATH`.
- Closing the terminal now stops running commands, and so does `SIGTERM` or `SIGHUP` to `clue ask`. A command that ignores `SIGTERM` gets `SIGKILL` when clue exits.
- `/undo` and rewind now say when a turn ran shell commands, which clue can't undo. The `shell` tag in rewind never appeared before.
- The session cost is more complete. It now counts automatic compactions, turns that failed partway, and the request that warms the cache on resume. `/cost` still shows the total after a rewind to the first prompt.
- Resuming a session warms the cache on the first key you type, so opening a session only to read it costs nothing.
- A failed turn no longer shifts footers and rewind points onto the wrong prompts, and a session whose first request failed can be resumed with the id clue printed.
- A turn that loses fast mode partway pays the fast price only for its fast requests.
- The prompt after a `/compact` no longer runs a second compaction, and rewind restores the files of a turn that followed a crash.
- `/new` and `/resume` in the same folder keep MCP servers running instead of restarting each one.
- An image is labelled by its contents, not its extension, so a JPEG named `.png` no longer blocks the session. Image formats the API doesn't take are converted.

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

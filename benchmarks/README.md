# Benchmarks

`bun run bench` measures clue's three waits: start, resume and first token. Each case runs 30 times after 3 warmups, in a pseudo-terminal, the way a person starts clue. Times come from `Bun.nanoseconds()`.

Results from 4 November 2026: an Apple silicon Mac (darwin-arm64), Bun 1.4.4, clue 0.14.0, the compiled `dist/clue` binary unless a row says otherwise.

## Start

|                                                    | median  | p90     |
| -------------------------------------------------- | ------- | ------- |
| `clue --version`, start to exit                    | 8.8 ms  | 9.3 ms  |
| `clue --version` from source (`bun src/main.ts`)   | 22.2 ms | 25.4 ms |
| Start to ready prompt, measured inside the process | 7.5 ms  | 8.5 ms  |
| Start to ready prompt, wall clock including exit   | 13.8 ms | 14.9 ms |
| Start to ready prompt from source                  | 32.3 ms | 33.3 ms |

## Resume

A seeded session of 120 prompts, each with two tool calls. The benchmark first checks that `clue -c` really shows the session. Before the prompt is ready, clue prints the whole session into the scrollback, up to its last 1 MB.

|                                                                | median  | p90     |
| -------------------------------------------------------------- | ------- | ------- |
| `clue -c` to ready prompt, session printed, inside the process | 13.8 ms | 14.6 ms |
| `clue -c` wall clock including exit                            | 20.2 ms | 21.1 ms |

Warming the prompt cache runs after the prompt is ready, so it is not part of these numbers.

## First token

These rows use a local stand-in for the API that answers at once, so they measure clue's own overhead, not the model.

|                                          | median  | p90     |
| ---------------------------------------- | ------- | ------- |
| Prompt sent to first streamed token      | 5.4 ms  | 5.7 ms  |
| `clue ask` with one tool call, whole run | 24.7 ms | 29.6 ms |

With the real API, the model's own time to first token is added on top.

## Hot paths

|                                                 | median | p90     |
| ----------------------------------------------- | ------ | ------- |
| Render a Markdown reply (`Bun.markdown.render`) | 9.5 µs | 13.9 µs |
| Load a 120-prompt session file (`Bun.JSONL`)    | 41 µs  | 46 µs   |
| Render all of it for resume                     | 66 µs  | 77 µs   |

A larger session, 610 KB and 120 prompts with long tool results, loads in about 0.65 ms.

## Budgets

`bun run bench:check` builds clue and fails if the p90 inside the process isn't under these limits, which are set in [`budget.ts`](budget.ts). Run it on your own machine. CI doesn't run it, because CI machines are too slow for these limits.

| Wait                                   | Budget      |
| -------------------------------------- | ----------- |
| Start to ready prompt                  | under 10 ms |
| `clue -c` to ready prompt, 120 prompts | under 15 ms |

## In CI

The Performance workflow runs [`compare.ts`](compare.ts) on every pull request and every push to `main`. It builds the base and the head on one runner, and they take turns over 8 rounds of 10 runs: start to a ready prompt, resume, and clue's own time to first token. A shared runner is slower and noisier than a laptop, but it slows both builds alike, so the job compares them instead of checking budgets. A wait fails when the head is more than 15% slower and slower in at least 6 of the 8 rounds. On one Mac, a build compared with itself came within 3%.

The job summary shows the table, and each run's samples stay as an artifact for 90 days. To compare two builds yourself: `bun benchmarks/compare.ts --base <binary> --head <binary>`.

## Method notes

- "Inside the process" is the time from process start to the first paint of the input line, as clue reports it with `CLUE_BENCH_READY=1`.
- "Wall clock" includes spawning the process, the first paint and exiting.
- On a busy machine, the same build varies by about 10% from run to run. To compare two builds, alternate between them in several rounds.
- The binary is built with `--bytecode`, a launch profile (`--bytecode-order`) and a lazy JIT until the first paint.
- `hyperfine` and `mitata` are the tools Bun recommends. The start-to-ready numbers need a terminal, which `hyperfine` doesn't provide, so this runner uses Bun's own spawn, PTY and clock. For commands that run without a terminal, such as `clue --version`, `hyperfine` agrees with it within a millisecond.
- "From source" runs the same Bun that runs the benchmark. A version-manager shim such as mise's adds about 28 ms to every `bun` start, and an earlier version of this benchmark measured that by mistake.

## Tools

`bun run bench:tools` calls each tool's `run()` directly, outside the agent loop, against a generated repository: 1,500 source files, 9,000 files in `node_modules`, a `.git` folder and a 20 MB log. Each row is compared with the fastest simple way to do the same job. 50 runs each, medians.

| Tool and case                                     | Before  | Now         | Floor                            |
| ------------------------------------------------- | ------- | ----------- | -------------------------------- |
| `shell`, `echo hi`                                | 49.4 ms | **7.1 ms**  | 3.6 ms, plain pipes, no terminal |
| `shell`, `git status`                             | 65.4 ms | **23.9 ms** | git's own time                   |
| `read_file`, first 50 lines of the 20 MB log      | 7.77 ms | **94 µs**   | 26 µs, reading the first 16 KB   |
| `read_file`, 100 lines from the middle of the log | 7.71 ms | 7.67 ms     | needs to count 150,000 lines     |
| `read_file`, a 200-line source file               | 102 µs  | 96 µs       | 24 µs, `Bun.file().text()`       |
| `edit_file`, one change in a 200-line file        | 211 µs  | 226 µs      | 110 µs, read, replace, write     |
| `write_file`, a new 5 KB file                     | 171 µs  | 193 µs      | 129 µs, `Bun.write`              |
| `capability_search` over 500 MCP tools            | 161 µs  | 156 µs      |                                  |
| Permission decision for a command                 | 2 µs    | 3 µs        |                                  |
| `buildContext`, first-turn setup                  | 19.4 ms | **2.4 ms**  | git status runs while you type   |

What changed:

- **`shell`** passes Bun a `Terminal` object instead of the inline `terminal: { … }` option, which makes every spawn wait about 16 ms for the PTY to close. It also dropped a fixed 20 ms sleep after each exit, which it replaced with a drain that returns once output stops growing, usually in 1 ms.
- **`read_file`** reads only the bytes a window near the top of a large file needs.
- **`buildContext`** gets git status from a run started at launch, or at `/new`.

What is at its floor:

- **Small file edits and writes** cost about 100 µs more than a raw write: they check that the file is unchanged and build the diff. That is far below anything a person or a model can notice.
- **A read deep inside a huge file** has to count every line before it. Both ways of doing it land near 8 ms.

Two behaviors changed while measuring. `stop` and exit now end a command's child processes, which used to survive and keep running.

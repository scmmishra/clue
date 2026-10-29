# Benchmarks

`bun run bench` measures clue's three waits: start, resume and first token. Each case runs 30 times after 3 warmups, in a pseudo-terminal, the way a person starts clue. Times come from `Bun.nanoseconds()`.

Results from 30 October 2026: an Apple silicon Mac (darwin-arm64), Bun 1.4.3, clue 0.1.0, the compiled `dist/clue` binary unless a row says otherwise.

## Start

| | median | p90 |
|---|---|---|
| `clue --version`, start to exit | 8.6 ms | 10.9 ms |
| `clue --version` from source (`bun src/main.ts`) | 38.2 ms | 40.5 ms |
| Start to ready prompt, measured inside the process | 7.3 ms | 7.8 ms |
| Start to ready prompt, wall clock including exit | 13.8 ms | 15.0 ms |
| Start to ready prompt from source | 38.2 ms | 39.4 ms |

## Resume

A seeded session of 120 prompts, each with two tool calls. The benchmark first checks that `clue -c` really shows the session.

| | median | p90 |
|---|---|---|
| `clue -c` to ready prompt, last screen printed, inside the process | 8.8 ms | 9.3 ms |
| `clue -c` wall clock including exit | 15.2 ms | 16.5 ms |

Warming the prompt cache runs after the prompt is ready, so it is not part of these numbers.

## First token

These rows use a local stand-in for the API that answers at once, so they measure clue's own overhead, not the model.

| | median | p90 |
|---|---|---|
| Prompt sent to first streamed token | 4.3 ms | 5.0 ms |
| `clue ask` with one tool call, whole run | 24.6 ms | 27.8 ms |

With the real API, the model's own time to first token is added on top.

## Hot paths

| | median | p90 |
|---|---|---|
| Render a Markdown reply (`Bun.markdown.ansi`) | 4.2 µs | 4.6 µs |
| Load a 120-prompt session file (`Bun.JSONL`) | 37 µs | 44 µs |
| Render the last screen of it for resume | 52 µs | 62 µs |

A larger session, 610 KB and 120 prompts with long tool results, loads in about 0.65 ms.

## Method notes

- "Inside the process" is the time from process start to the first paint of the input line, as clue reports it with `CLUE_BENCH_READY=1`.
- "Wall clock" includes spawning the process, the first paint and exiting.
- The binary is built with `--bytecode`, a launch profile (`--bytecode-order`) and a lazy JIT until the first paint.
- `hyperfine` and `mitata` are the tools Bun recommends; this runner uses Bun's own spawn, PTY and clock, so it needs nothing installed.

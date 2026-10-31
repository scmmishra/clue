# Contributing

```bash
bun install
bun run dev          # run from source
bun test             # tests, against a local stand-in for the API
bun run fmt          # format src, test, scripts and benchmarks
bun run build        # dist/clue for this machine; --all for every platform
bun run build:watch  # rebuild dist/clue when src or prompts change
bun run bench        # start, resume and first-token benchmarks
bun run bench:check  # build, then fail if start or resume is over budget
bun run bench:tools  # each tool on its own, outside the agent loop
```

CI runs the type check, the tests and a build on macOS and Linux for every push and pull request. It also installs that build with `install.sh`.

## Benchmarks

clue measures three waits: from `clue` to a ready prompt, from `clue -c` to a ready prompt with your last session on screen, and from Enter to the first word of the reply. A change that makes one slower needs a reason. [`benchmarks/`](benchmarks/) holds the benchmark for each wait, and its README has the latest numbers.

## Prompts

The system prompt is in `prompts/system.md` and the reviewer's prompt is in `prompts/review.yaml`. Bun embeds both in the binary at build time. Tool descriptions stay in the code, next to each tool's parameters.

## Release

The version in `package.json` is clue's only version number. `clue --version` reads it at build time.

Changes are listed in [CHANGELOG.md](CHANGELOG.md), under `## Unreleased` until they ship.

To release:

1. Rename `## Unreleased` in `CHANGELOG.md` to the new version, such as `## 0.2.0`.
2. Change the version in `package.json` to match.
3. Push both to `main`.

The release workflow then:

1. Reads the changelog section for the version. If the section is missing or empty, the release stops.
2. Runs the type check and the tests.
3. Builds the binary for each platform.
4. Creates the tag `v<version>` and a GitHub release with the binaries and `SHA256SUMS`. The changelog section becomes the release notes.

CI checks on every push that the version in `package.json` has a changelog section, so a missing entry fails before the release does.

If the tag already exists, the workflow skips the release. A change to `package.json` that keeps the version, such as a dependency update, publishes nothing.

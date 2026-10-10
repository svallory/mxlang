# @mxlang/tsc

`mx-tsc`: real `tsc` with the MX language plugins spliced in through Volar's `runTsc`. Its internals are described in `../typescript-plugin/AGENTS.md`; this file covers only what is specific to this package's tests.

## Tests

From this directory:

```
bunx vitest run --root ../../.. --project @mxlang/tsc
```

Needs `bun install` and `bun run build` first (`dist/` of core, parser, the html target and the plugin). `@mxlang/typescript-plugin`'s `dist` bundles `@mxlang/target-html` (it is not external in its build script), so after editing `packages/targets/html` rebuild the plugin too, or these tests pass on a stale html.

This package's run is slow and sensitive to machine load (TODO `tsc-tests-runtime-2`): the whole project took ~340 s on a busy machine and hit `[vitest-worker]: Timeout calling "onTaskUpdate"`. Run single files with the path filter (`... src/<file>.test.ts`) while iterating.

## The Angular template pass in watch mode (`src/watch-templates.ts`)

`tsc -w` returns from `executeCommandLine` after its first build and rebuilds on its own, so nothing of `index.ts` runs again afterwards: every rebuild needs the template pass of its own. It runs from an interceptor on `process.stdout.write` (`installWatchTemplatePass`), matched on tsc's own watch summary (`Found N errors. Watching for file changes.`): the pass's diagnostics are printed before that line and its errors are counted into it. Only that line is acted on. Under `-b -w` each program's compiles are matched back to a project by root-file overlap (`matchProjects` in `build-templates.ts`), never by path prefix.

Two bounded real-watcher tests cover the watch surfaces, each killing and reaping its watcher in `finally` with a hard lifetime limit (run one at a time; they spawn real watchers): `src/watch-rebuild-diagnostics.test.ts` (TypeScript pass) and `src/watch-ngmx-rebuild-diagnostics.test.ts` (this pass).

## Dispatch goldens (`src/host-dispatch-golden.test.ts`)

For one fixture directory per row under `src/fixtures/host-dispatch/`, the test records what each tool produces today: language-server diagnostics, the TypeScript plugin's `generated` text, `mappings`, compile and host-policy diagnostics, the Vite transform output, and `mx-tsc`'s output. `mx-tsc` runs once, in process, over `fixtures/host-dispatch/tsconfig.json` (with `--astro`, which is a superset of the extension lists); its output is split per row by path. Goldens are JSON in `src/fixtures/host-dispatch/__golden__/`, paths normalised to `<root>`/`<repo>`, ANSI stripped.

- A refactor of the per-target dispatch must leave the goldens unchanged. A golden that changes is a behaviour change: say so in the PR.
- Regenerate with `-u`: `bunx vitest run --root ../../.. --project @mxlang/tsc src/host-dispatch-golden.test.ts -u`. Without `-u` a missing golden is written on a local run (not under `CI=true`, where it fails) and a differing one fails. Review the diff of every rewritten file.
- Adding a row: create the directory under `fixtures/host-dispatch/`, add its name to `ROWS` in the test, run once. The test also fails when a directory is not in `ROWS`.
- Editing a fixture's `package.json` or sources moves positions in the goldens (policy diagnostics point into `package.json`); regenerate, and run Biome with `--write` on the fixture first so formatting is stable. `bad-package-json` is malformed on purpose and is excluded from Biome in the root `biome.json`.
- Rows the plan changes on purpose, and the known disagreements between tools, are listed in the comment above `ROWS` in the test.
- `bad-package-json` pins only the host-policy output: compiling beside a malformed `package.json` throws Marko's Babel "Error while parsing JSON" when vitest runs from the repo root (`bun run test`) and not from this directory, so anything more would make the golden cwd-dependent (TODO `compile-beside-malformed-package-json-cwd`). Its policy warning also embeds this package's own `package.json` (`mx.host` `html`) as the fallback source: adding or changing an `mx` field there changes that golden.
- `console.warn` output (scan warnings the plugin logs) is not captured in the `mx-tsc` leg; the TypeScript plugin leg records it as `logged`.

## Dialect files (`src/data-check.ts`)

No tool checks a dialect file yet. `mx-tsc` reaches `src/data-check.ts` only for a project directory whose own `package.json` says `mx.target: "tree"` (asked through `@mxlang/typescript-plugin`'s `isDataProject`), and since decision 204 removed the tree target no directory qualifies: `mx.target: "tree"` errors with `mx.target "tree" was removed (decision 204); a consumer that reads the tree calls lowerSource from @mxlang/core`, and a project selecting it is an ordinary `tsc` run. The module stays as the seam for the future dialect check (`TODO dialect-check (PR 1)`), which will print its diagnostics as `TS80001`/`TS80002` and exit 1 on an error; only `-p`, `--pretty` and `--noEmit` will qualify, any other argument stays a normal `tsc` run.

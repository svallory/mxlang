# scripts — agent instructions

## Scripts

Run either via bun directly or through moon:

```
bun run typecheck   # or: moon run :typecheck
bun run test        # or: moon run :test
bun run lint        # or: moon run :lint
bun run verify      # or: moon run :verify   -- delegates straight to `bun run verify`, see below
bun run build       # or: moon run parser:build -- builds packages/parser to dist/
```

moon's root `typecheck`/`test` tasks are thin aggregates (`deps: ["^:typecheck"]` / `["^:test"]`) that fan out to each package's own task; `lint` runs once at the root over the whole tree via biome. `bun run typecheck`/`test` take the other layer — a single shell loop/vitest run at the root (the typecheck loop defers to a package's own `typecheck` script when it has one, which is what lets `examples/counter-app` and `examples/todomvc` run `mx-tsc`, and `examples/astro-static` run `mx-tsc --astro`, while everything else runs plain `tsc`) — so pick one command style (bun or moon) per invocation rather than mixing them. An example whose `tsconfig.json` is solution-style (`files: []` plus `references` to the real project configs, Angular CLI's own default shape — see `examples/angular-app/tsconfig.json`) needs its own `typecheck` script for the same reason: the root loop's plain `bunx tsc --noEmit` against that `tsconfig.json` is a silent no-op, since there are no `files` listed to check and `tsc` does not follow `references` without `--build`. `examples/angular-app`'s `typecheck` script runs `tsc -p tsconfig.app.json --noEmit` directly against the real project config instead. `verify` is the one exception: moon's `verify` task is a single `bun run verify` command, not a `deps` list, because `bun run verify`'s own chain (pre-verify must run before test; the coverage script must run last, after everything else) isn't expressible as an unordered `deps` set — delegating keeps the two entry points from silently drifting into two different definitions of "verified".

## Test Coverage Verification (decision 64)

`verify` (`bun run verify` / `moon run :verify`) proves every non-exception
package's tests actually **ran in that invocation** — not merely that some
test wiring exists for it. This chain runs locally without deadlock, including `consumer-check:html` which checks consumer packing behavior. The chain is:

```
scripts/pre-verify.ts && typecheck && lint && build && test && test:bun && test:grammar && scripts/verify-coverage.ts
```

- `scripts/pre-verify.ts` deletes any evidence left over from a previous run
  (`vitest-results.json`, `packages/editors/tree-sitter-solidmx/.test-ran`) and writes
  `.verify-start` with the current time. All three are gitignored.
- `bun run test` runs vitest (over the root `vitest.config.ts`'s `projects`
  list — `scripts`, `packages/core`, `packages/oracle`, `packages/parser`,
  `packages/hosts/*`, `packages/tooling/*`, `packages/editors/*` — which
  auto-discovers a project per matched directory with test files) with
  `--reporter=json --outputFile=vitest-results.json`.
- `bun run test:grammar` runs `moon run tree-sitter-solidmx:test --force`
  (`tree-sitter-solidmx`'s real test is `scripts/test.sh`, not vitest, so it
  can never appear in the JSON report). `scripts/test.sh` writes
  `.test-ran` as its last step, only on success; `--force` bypasses moon's
  own task cache so a cached "already ran, nothing changed" result can't be
  mistaken for evidence from *this* run.
- `scripts/verify-coverage.ts` (the last step) enumerates all workspace
  packages (`packages/*`, `examples/*`, `apps/*`), and for each
  non-exception package reads the evidence directly: a
  **workspace-relative path** (e.g. `packages/hosts/angular`,
  `examples/angular-app`) resolved from `vitest-results.json`'s test file
  paths via `packageKeyOfTestPath`, which finds the **longest discovered
  package path that prefixes the test file's own path** — not a hardcoded
  group list (`hosts`/`tooling`/`editors`/...), so a package nested at any
  depth under `packages/*/*` resolves without a code change. Matching by
  full path rather than basename is load-bearing: an example and a package
  can share a basename (`examples/angular-app` vs `packages/hosts/angular`),
  and a basename-only match let one satisfy the other's coverage requirement
  for free. For `tree-sitter-solidmx`/`tree-sitter-amx` only, evidence is
  the `.test-ran` marker instead. Every evidence file's mtime must be `>=`
  `.verify-start`'s timestamp, or it's treated as stale and the package
  fails — there is no code path that marks a package as tested without
  reading its evidence file. Prints a table: package (full workspace-relative
  path) | test wiring | ran, and exits non-zero if any non-exception package
  has no fresh evidence, or if `NO_TEST_EXCEPTIONS` contains a key naming a
  package that no longer exists (`findStaleExceptions`).

Exception packages (no unit test wiring required; verified elsewhere; keyed
by workspace-relative path):
- `examples/angular-app` — ng build/ng test only, verified manually — no e2e
  suite wired yet
- `examples/astro-static` — e2e only
- `examples/counter-app` — e2e only
- `examples/hono-app` — e2e only
- `examples/mx-site` — e2e only
- `examples/mx-vite` — e2e only
- `examples/preact-app` — e2e only
- `examples/react-app` — e2e only
- `examples/todomvc` — e2e only
- `packages/editors/zed` — grammar and Rust extension (registers
  `@mxlang/language-server`), both build-verified in CI
  (`zed-compile-check`, `zed-compile-check`)
- `apps/docs` — docs site: built in verify

Any new package without test wiring must be added to the exception list
(keyed by its workspace-relative path) with a documented reason, or get a
vitest project (a package under `packages/*` or `examples/*` with its own
test files) that emits into `vitest-results.json`. A stale exception key
(naming a package that no longer exists) fails `verify-coverage.ts` rather
than silently rotting.


## Packaging hygiene (pkg-types-g10)

The defect class of PR #174 (a tarball that ships the wrong files, or a shipped `.d.ts` importing a module the package never declares) is pinned per package by two checks:

- `scripts/pack-hygiene.test.ts` (default unit run, needs a built `dist/`): for every entry of `PACKED_PACKAGES` in `scripts/pack-hygiene.ts` it lists the tarball (`bun pm pack --dry-run`) and asserts it holds only `package.json`, README, `dist/**` and the package's named extras (html: `types/**`); no `src/`, tests, fixtures, `.d.ts.map`, `moon.yml` or tsconfig; every `main`/`types`/`bin`/`exports` target packed and none into `src`. It parses each shipped `.d.ts` (TypeScript AST) and requires every bare specifier to be a declared dependency or peer, with no builtins and no relative escape out of `dist/`. The only specifier alias is html's `bun` <-> optional peer `@types/bun`. A second check (`undeclaredRuntimeImports`) does the same for the shipped runtime JS (`dist/**/*.{js,mjs,cjs}`: static, dynamic and `require` specifiers): every bare import must be a declared dependency or peer, a node builtin, or the package's own name. No allowlist.
- `scripts/pack-probe.ts` (`bun run pack-probe`, in `verify`, heavy: run under the lock): `npm pack`s each package, installs it and its declared deps in a scratch project outside the repo, imports every `exports` subpath with `tsc --noEmit --strict --skipLibCheck false`. Negative case: html without `@types/bun` must fail with TS2307 on `dist/bun.d.ts` (if it passes, the probe fails). It also installs the packed `@mxlang/tsc` and runs `mx-tsc --version`, and reports (does not fail on) a `moduleResolution: node16` consumer. Private workspace deps (D5, `publish-plan-private-deps` in the space TODO) are pinned to tarballs (core, parser, html, angular, typescript-plugin) or empty stubs (hono, preact, react, solid, astro), by name in the script. `npm pack` does not rewrite `workspace:*`, hence the `overrides`.

A new publishable package is added to `PACKED_PACKAGES`. The probe stubs private workspace deps with no `dist` (D5); a stub whose type a probed `.d.ts` imports carries that one type in `STUB_TYPES` (today `@mxlang/astro`, for `@mxlang/typescript-plugin`), and `typescript` is pinned as an extra dep for it because an unpinned install resolves 7.x.

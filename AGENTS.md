# mx — agent instructions

## Package manager

bun (bun workspaces). Do not use npm/pnpm/yarn, with two exceptions. (1) `packages/targets/html/scripts/consumer-check.ts` and `scripts/pack-probe.ts` pack tarballs with `npm pack`, because `bun pm pack` hangs on macOS with bun 1.3.14 (it also hangs from a plain shell; PR #51). (2) `packages/editors/vscode/scripts/stage-vsix.ts` runs `vsce package` in its dependency mode, which shells out to `npm list --production` (`--no-dependencies` cannot ship `node_modules`, so the plugin would be missing from the VSIX). In both, npm is only that tool's packer, never the project's package manager; the node/npm toolchain is pinned in `.prototools` (`node`) and in CI. Toolchain versions are pinned in `.prototools` (`bun`, `moon`, `node`); root `package.json` `packageManager` matches the pinned bun version.

## Scripts

Run either via bun directly or through moon:

```
bun run typecheck   # or: moon run :typecheck
bun run test        # or: moon run :test
bun run lint        # or: moon run :lint
bun run verify      # or: moon run :verify   -- delegates straight to `bun run verify`, see below
bun run build       # or: moon run tsx-bridge:build -- builds packages/tsx-bridge to dist/
```

Pick one command style (bun or moon) per invocation — don't mix them: moon's root tasks fan out to each package's own task, while `bun run typecheck`/`test` run a single loop/vitest pass at the root. Their exact fan-out shapes can drift (an example's own `typecheck` script, a solution-style `tsconfig.json`), so a package needing something non-default documents it in its own `AGENTS.md`; see `examples/AGENTS.md`. `verify`'s two entry points are kept identical on purpose: moon's `verify` task is a single `bun run verify` call, not a `deps` list, because that chain's own ordering (pre-verify before test; coverage last) isn't expressible as an unordered `deps` set.

## Running one package's tests / one test

Per-package vitest runs need the root config:

```
bunx vitest run --root ../.. --project @mxlang/<name>
```

`--root` is the path from the package dir to the repo root, so a nested package (`packages/hosts/*`, `packages/tooling/*`) needs `--root ../../..`; `../..` fails with "references a non-existing file or a directory: …/packages/scripts". A bare `bunx vitest run` inside a package directory fails with "No projects were found", because `projects: ["packages/*"]` is resolved relative to the root. Filter to one test with `-t "<test name>"`, e.g. `bunx vitest run --root ../.. --project @mxlang/core -t "parseFragment"`.

## Build before downstream tests

`@mxlang/tsx-bridge` and `@mxlang/core` resolve to `dist/`, so a freshly created worktree needs `bun install` **and** `bun run build` before any dependent package's tests will run — without `dist/` consumers fail to resolve those packages (the oracle fails the same way).

**A *stale* `dist/` is worse than a missing one, because it fails silently.** Editing `packages/core/src` and then running a host's tests, an oracle, or a one-off `bun run` script exercises the *last built* core, not the edit: the run succeeds and reports the old behavior, so a new diagnostic appears not to fire and a new field reads as `undefined`. (The per-edit typecheck hook does read the sources, so typecheck passing is not evidence the built artifact is current.) Rebuild `@mxlang/core` after editing it — `cd packages/core && bun run build`, or `bun run build` at the root — before running anything downstream. `bun run verify` builds before it tests, so this only bites when running one package's tests directly. The per-edit typecheck hook in `.claude/hyper.json` also expects a prior build for full coverage (it skips checking packages that rely on the built `mx-tsc` wrapper if it isn't built yet).

CI runs `oracle`, `oracle:marko`, `oracle:preact`, `oracle:react`, `oracle:hono`, `oracle:angular`, and `oracle:custom-tags` after `verify`, and all seven must pass locally before a PR. The first five run with `--strict` to fail on mismatches; `oracle:angular` and `oracle:custom-tags` always exit nonzero on any mismatch and ignore the flag (CI passes `--strict` to them for uniformity only).

**Known flake under machine load: `[vitest-worker]: Timeout calling "onTaskUpdate"`.** This is `birpc`'s own hardcoded round-trip RPC timeout (`node_modules/.bun/vitest@3.2.7+.../vitest/dist/chunks/index.B521nVV-.js:3`, `const DEFAULT_TIMEOUT = 6e4` — 60 seconds) — vitest 3.2.7 exposes no config field for it (`teardownTimeout`/`pool` govern different mechanisms entirely and cannot raise it; confirmed by tracing `createRuntimeRpc` → `createThreadsRpcOptions`/`createForksRpcOptions` in `utils.CAioKnHs.js`, neither of which ever sets a `timeout` override). It fires only when a worker's event loop is starved past 60 seconds by real machine load (verified by reproducing it with a synchronous 65-second busy-wait in a scratch test, no config change needed to trigger it). It is harmless to correctness — every test still ran and reported its real result before this fires — so the remedy is to rerun, and to keep heavy jobs (`verify`, the oracles) serialized under the lock rather than run concurrently with other CPU-heavy work on the same machine.

CI's cause, measured with an event-loop-lag sampler (#390): vitest's main process never lagged past 1.3 s; the timeout fired when one *worker* held its event loop for 37-72 s, the whole run time of a file of ~100 synchronous tests (`typescript-plugin/src/index.test.ts`, `hosts/angular/test/event-handler.test.ts`). Vitest awaits only microtasks between tests, so timers and the RPC reply to `onTaskUpdate` waited for the entire file, and under CI contention that passed birpc's fixed 60 s. (Vitest 3's default pool is already `forks`, so a per-project `pool: "forks"` changes nothing; capping `--maxWorkers=2` and splitting shards by project did not stop it either.) The fix is `scripts/vitest-yield.ts`, a `setupFiles` entry for those two projects that hops one macrotask after each test, bounding the longest block to one test (about 1.2 s locally). If you add a project whose files run many synchronous language-service/ngtsc tests, give it the same `setupFiles` entry. CI also preloads `scripts/lag-sampler.cjs` (via `NODE_OPTIONS`, with `MX_LAG_LOG`) and prints each shard's five longest blocks with `scripts/lag-top.cjs`; it is observation only, with no failing threshold. A local `bun run test` is unaffected.

## Test Coverage Verification (decision 64)

`verify` (`bun run verify` / `moon run :verify`) proves every non-exception package's tests actually **ran in that invocation**, not merely that some test wiring exists for it, by checking each package's evidence file (`vitest-results.json`, or `.test-ran` for the two tree-sitter grammars) against a `.verify-start` timestamp written at the top of the chain. `scripts/verify-coverage.ts` prints a package/test-wiring/ran table and fails on any non-exception package with no fresh evidence, or on a stale exception key (naming a package that no longer exists).

Exception packages (no unit test wiring required; verified elsewhere; keyed by workspace-relative path): every `examples/*` app except `angular-app` is e2e-only; `examples/angular-app` is `ng build`/`ng test`-verified manually; `packages/editors/zed` is build-verified in CI; `apps/docs` is built in verify. A new package without test wiring must be added to this list with a documented reason, or get a vitest project.

`apps/docs` builds a landing page whose hero is a real `.mx` file, so its "built in verify" now covers a drift gate. `scripts/build-home.ts` compiles `apps/docs/example/home-example.mx` with `@mxlang/html` (custom tags discovered from `example/tags/` exactly as `packages/targets/html/src/example.ts` does), renders it across every branch, validates `example/home-example.markers.json` and `example/home-example.cards.json` against it, and writes the highlighted block into `docs/index.md` between its two `mx-home:generated` markers. Three consequences:

- The docs build needs `bun install` **and** `bun run build` first (it imports `@mxlang/html`'s `dist/`).
- Editing the example or a marker means `bun run --cwd apps/docs build:home` and committing the regenerated `docs/index.md`. `bun run --cwd apps/docs check:home` is the read-only half: it fails when the committed block is stale **and** when a marker's `#fragment` is not an `id` in the built `site/` — docmd's heading slugs are prefixed with the page title, so they cannot be derived from the markdown. The `build` script runs it last, after `docmd build`, which is why it can read `site/`.
- `bun run --cwd apps/docs check:anchors` (`scripts/anchors.ts`, wired into `build` after `check:home`) walks every `href` with a `#fragment` on the built `site/` and fails with one `page: href -> missing id` line per link that resolves to no `id`. It is the same walk `check:home` does for markers, widened to the whole site: `docmd validate` only checks that a link's *page* exists, so 21 links in pages the atoms docs work did not touch shipped broken (decision: docmd prefixes a heading id with its parent headings and the page's `# Title`, so `#the-idea` is really `#angular-the-idea`). Read the id out of the built HTML to fix one; `scripts/anchors.test.ts` pins the walk's rules against a synthetic tree and re-runs it over the real `site/` when a build exists (skipped on a fresh worktree).
- `bun run --cwd apps/docs test` (vitest, `scripts/home-example.test.ts` and `scripts/mx-highlight.test.ts`) carries the same checks for anyone who runs only the test lane; `verify` and `pack-probe-docs` both run it.

The docs highlight every ```` ```mx ```` fence, and the landing example, with the tree-sitter MX grammar at build time (`@mxlang/tree-sitter-mx/docmd`, `packages/editors/tree-sitter-mx/highlight/mx-highlight.mjs`: a docmd plugin the package publishes, capability `markdown`, overriding `md.options.highlight` for `mx` only; no client-side parsing). Consequences:

- It needs two wasm files, both gitignored, and the docs `build`, `dev` and `test` scripts build them first through `bun run --cwd apps/docs build:wasm`: `packages/editors/tree-sitter-mx/tree-sitter-mx.wasm` (the package's own `build:wasm`) and `packages/editors/tree-sitter-mx/highlight/ts/tree-sitter-typescript.wasm` plus a combined `highlights.scm` (`highlight/build-ts-grammar.sh`, both built by the package's `prepack`, which `apps/docs`' `build:wasm` runs: a blobless clone of tree-sitter-typescript at the pin `packages/editors/tree-sitter-solid` vendors, the plain `typescript` dialect, so a cold build needs network; both builds take the `/tmp/mx-zed-generate.lock` flock). Without either file the docs build **fails** with the build command in the message; there is no plain-text fallback. CI builds them in `pack-probe-docs`.
- Spans are the grammar's `highlights.scm` captures, plus TypeScript captures for the ranges `injections.scm` hands to TypeScript. A capture name becomes a class (`punctuation.bracket` is `ts-punctuation-bracket`; `none` and `embedded` get none; two MX classes are named, not derived: `string.special.symbol`, an atom, is `ts-atom`, and `label`, the `:name` sugar, is `ts-name`), coloured by `--ts-*` tokens in `apps/docs/assets/css/home.css` under `:root[data-theme="dark"]`. A new capture name needs a class rule there; `mx-highlight.test.ts` fails until it has one. CSS and HTML injections render as plain code text until a wasm is added to `injectable` in the plugin.
- The landing block is a file panel with cards beside it (the layout of the Mesh home overview). `example/home-example.cards.json` holds the cards (`id`, `group`, `title`, `text`, optional `jsx` snippet); every marker names its `card`, and its `label` is the chip shown under that card. A marker without a card, or a card without a marker, fails the build (`validateCards`). Which lines a card tints and where it sits on the wide grid are generated into a `<style>` beside the block; the static rules are the `.mxo*` rules in `assets/css/home.css`.
- A marker in `home-example.markers.json` needs `node`, `startsIn` and `endsIn` (and `exact: true` when its range equals its node): the types of the smallest named syntax node around the region and at its first and last character, checked against the tree on every build. Moving a range off its construct fails the build; fix the range, or the node types if the move was deliberate.
- Fence languages: ```` ```mx ```` is MX code and gets the grammar; ```` ```marko ```` is only for a deliberate Marko-vs-MX comparison and is left to docmd's own highlighter.

## Edit check hook

`.claude/hyper.json` runs Biome formatting checks, then TypeScript type checking after every agent edit. The hyper hook gives its check commands no signal about which file was edited (no placeholder, env var, or stdin — only the repo root as cwd), so the typecheck command discovers the changed dirs itself from `git diff --name-only HEAD` plus untracked files under `packages/` and `examples/`, resolves each to its nearest enclosing dir among `packages/*/`, `packages/*/*/`, `examples/*/` that has a `tsconfig.json`, and typechecks only that set of dirs — the package's own `typecheck` script when it has one, the `mx-tsc` not-built fallback, otherwise `tsc --noEmit -p`. A file outside any such dir (root, `scripts/`, `apps/*` — none of which has a `tsconfig.json`) runs no typecheck. Both commands use `./node_modules/.bin` paths directly so they work without shell shims (proto/bun/nvm wrappers).

## Scoped lint exceptions

- `noUnusedImports` and `noUnusedVariables` are disabled for
  `examples/astro-static/**/*.astro`: Biome checks only Astro frontmatter and
  cannot see imports and variables consumed by the template body.
- `noTemplateCurlyInString` is disabled for the exact Astro, core, and
  translator source/test files listed in `biome.json`. Those strings
  intentionally contain Marko `${...}` syntax or generated JavaScript
  template source and must remain ordinary string literals.
- `packages/targets/html/src/translate.test.ts` keeps
  `noTemplateCurlyInString` enabled at info severity because its existing
  occurrence-level suppressions would become stale if the rule were disabled.
  Biome 2.5.12 does not expose `suppressions/unused` as a configurable rule.
- `useNamingConvention` remains enabled only in
  `packages/core/src/compile.ts` and `packages/core/src/core.ts`, keeping their
  existing visitor-key suppressions active; `noExplicitAny` is disabled only
  there for the compiler adapter's intentional `Node = any`. These two files
  are owned by the parallel core-ir refactor and must not be edited here.

## Exact-pin policy

All dependencies in the root `package.json` are pinned to an exact version (no `^`/`~`). `parser`'s output must be byte-reproducible wire format across the parser, the Babel plugin, and the TS plugin's virtual-file generator; an unpinned transitive bump in Babel or TypeScript could silently change AST shape or emitted output. See `README.md` "Pinned versions" for the current set and rationale.

**A published package's `peerDependencies` is the one exception, and `typescript` is the case.** `@mxlang/tsc` and `@mxlang/typescript-plugin` declare `peerDependencies.typescript: ">=5.9.0 <7"`, because a peer is resolved from the *consumer's* project and an exact peer makes the package uninstallable for anyone on a different patch. The exact-pin policy still holds for every `devDependencies`/`dependencies` entry, including those packages' own exact `devDependencies.typescript`. TypeScript must resolve to **one** copy: a nested second copy breaks `instanceof` across the tsserver/Volar boundary and silently mistypes every file — `packages/tooling/tsc/src/peer-typescript.test.ts` asserts this. `@mxlang/language-server` declares no `typescript` peer (build tool only, not runtime). See `packages/tooling/typescript-plugin/AGENTS.md` for the full detail on both.

## Base branch

`main`.

## Commit convention

Conventional commits: `type(scope): summary`.

## Architecture

A `.mx`/`.solid.mx`/`.ng.mx`/`.astro.mx` template flows through the system as follows:

1. **Parse.** For whole-file `.mx`, `@marko/compiler` parses the Marko AST directly. For `.solid.mx` and `.ng.mx`, `@mxlang/tsx-bridge` (a vendored `@babel/parser` fork) finds MX regions inside a TypeScript module. For `.astro.mx`, `@mxlang/astro`'s `lowerAstroMx` (`packages/hosts/astro/src/astro-template.ts`) splits the file's `---` fence from its MX template body itself — no tree-sitter on this path; `packages/editors/tree-sitter-amx` is a separate, editor-only grammar for Zed syntax highlighting.
2. **Lower.** `@mxlang/core` (`packages/core/src/lower.ts`) consumes the Marko AST and resolves it into a host-independent IR (`packages/core/src/ir.ts`) — structural constructs (`<if>`, every `<for>` form, `<define>`, custom tags, `<try>`) become IR nodes, never host-specific code.
3. **Emit.** Each host implements `Emitter<Out>` over that IR: `@mxlang/html` emits plain strings; a shared JSX emitter (`@mxlang/preact`) is reused by `@mxlang/react` and `@mxlang/hono`; `@mxlang/solid` emits Solid 2 JSX text; `@mxlang/astro` emits Astro template syntax; `@mxlang/angular` emits Angular template strings.
4. **Region files (`.<host>.mx`, today `.solid.mx`, `.preact.mx` and `.react.mx`).** `@mxlang/tsx-bridge` finds each MX region and hands it to the region entry of the host whose file kind the suffix names (`HostFileKind.compileRegion`, routed by `@mxlang/target-registry`'s `regionCompileFor`; for `.solid.mx` that is `@mxlang/solid`'s `compileSolidMx`, for `.preact.mx` `@mxlang/preact`'s `compilePreactRegion` and for `.react.mx` `@mxlang/react`'s `compileReactRegion`, both over `@mxlang/preact`'s shared `compileJsxRegion`), which runs it through `@mxlang/core`'s `parseFragment`; the emitted text is spliced back into the surrounding TypeScript AST at the same span. The parser names no host: tools pass `mx: true` and the hook (decision 154).
5. **Tooling.** `@mxlang/vite-plugin` is the primary dev integration; `@mxlang/typescript-plugin`/`mx-tsc` type-check `.mx`/`.solid.mx`/`.ng.mx`/`.astro.mx` (`.ng.mx` gets TypeScript semantics in editors and `mx-tsc`, plus Angular template diagnostics in `mx-tsc` only via `@mxlang/angular-checker` with `@angular/compiler-cli` resolved from the user's project; the editor path and the language server land later) via a Volar virtual-file projection; `@mxlang/language-server` publishes host-policy diagnostics Marko's own LS can't see; editor support lives in `packages/editors/{vscode,zed}`.
6. **Oracle.** `packages/oracle` is the byte/semantic-parity gate — compares MX output against Marko's own render (`oracle:marko`), the JSX hosts' own renderers (`oracle:preact`/`oracle:react`/`oracle:hono`), Solid's compiler (`oracle`), and Angular's compiler (`oracle:angular`).

See `README.md`'s package table for the npm-name-to-dir mapping and each package's own `AGENTS.md` (indexed below) for its internals.

## Decision numbers

Decision numbers (e.g. "decision 72") refer to the hyper space root's `notes/decisions-2026-09-10.md` (outside this repo).

## Design docs

Design docs, specs, and research notes live outside this repo, at the project space root under `notes/` (not inside this worktree). The language spec is the exception: it lives in the repo at `apps/docs/docs/specification.md` (see below).

## Language spec

`apps/docs/docs/specification.md` is the normative MX language specification — one
section per construct, each carrying its syntax, its semantics per host, the
errors core owns, and the decision numbers that fixed it. It is the answer to
"what does this construct mean", where the docs site (`apps/docs/docs/`)
answers "how do I use it" and the decision log answers "when did we choose
this". A PR that changes syntax or semantics updates
`apps/docs/docs/specification.md` in the same change, citing the decision number; a
decision entry that changes the language names the spec section it updates.

## Oracle harness

`packages/oracle` (`@mxlang/oracle`) is the byte/semantic-parity gate across every host. See `packages/oracle/AGENTS.md` for the fixture format, backends, and the `oracle:marko`/`oracle:preact`/`oracle:react`/`oracle:hono`/`oracle:angular`/`oracle:custom-tags` tables.

## Per-package instructions

Packages and examples with their own `AGENTS.md` (each has a sibling `CLAUDE.md` symlink). `packages/hosts/` holds the hosts; `packages/targets/` holds the hostless targets (decision 132): `@mxlang/html` and `@mxlang/data`:

| Path | Covers |
|---|---|
| `packages/tsx-bridge/AGENTS.md` | `@mxlang/tsx-bridge`; `.mx`/`.solid.mx`/`.astro.mx` extension identity; the four Marko facts |
| `packages/babel/AGENTS.md` | `@mxlang/babel`: the vendored Babel fork, the `mxHooks` injection point, re-vendoring |
| `packages/parser/AGENTS.md` | `@mxlang/parser`: the htmljs-parser-derived template parser and the MX AST front end (`src/frontend`, internal until PR 3) |
| `packages/parse-differential/AGENTS.md` | `@mxlang/parse-differential`: private test package of the parser port, the tree differential against today's Marko tree |
| `packages/core/AGENTS.md` | `@mxlang/core`: IR, lowering, custom tags, `<try>`, tag discovery |
| `packages/targets/data/AGENTS.md` | `@mxlang/data`: the hostless data target; static tree, `parseData` |
| `packages/targets/html/AGENTS.md` | `@mxlang/html`: string target, policy table, Bun loader, `.mx` import typing |
| `packages/hosts/solid/AGENTS.md` | `@mxlang/solid` |
| `packages/hosts/preact/AGENTS.md` | `@mxlang/preact` |
| `packages/hosts/react/AGENTS.md` | `@mxlang/react` |
| `packages/hosts/hono/AGENTS.md` | `@mxlang/hono` |
| `packages/hosts/astro/AGENTS.md` | `@mxlang/astro`; `.astro.mx` AstroMX templates |
| `packages/hosts/angular/AGENTS.md` | `@mxlang/angular` (in progress) |
| `packages/target-registry/AGENTS.md` | `@mxlang/target-registry`: the built-in target descriptors and lookup (unstable, nothing consumes it yet) |
| `packages/tooling/vite-plugin/AGENTS.md` | `@mxlang/vite-plugin` |
| `packages/tooling/typescript-plugin/AGENTS.md` | `@mxlang/typescript-plugin` and `@mxlang/tsc` |
| `packages/editors/vscode/AGENTS.md` | VS Code extension; how the VSIX ships `@mxlang/typescript-plugin`, `check-vsix` |
| `packages/tooling/language-server/AGENTS.md` | `@mxlang/language-server` |
| `packages/tooling/angular-checker/AGENTS.md` | `@mxlang/angular-checker` |
| `packages/oracle/AGENTS.md` | `@mxlang/oracle` harness detail |
| `packages/editors/zed/AGENTS.md` | Zed extension (`mxlang`) |
| `packages/editors/tree-sitter-solid/AGENTS.md` | fresh-worktree vendor setup |
| `scripts/AGENTS.md` | full `verify` chain detail (`pre-verify.ts`, `verify-coverage.ts`) and the test-coverage exception list, condensed at root above |
| `examples/AGENTS.md` | all `examples/*` apps; typecheck-loop and solution-style tsconfig detail |

---
title: "Contributing"
description: "Repo layout, verification, the oracle, and how to add a host."
---

# Contributing

## Repo layout

The repository is a Bun workspace with two workspace globs, `packages/*` and `examples/*`, plus a docs app under `apps/*`. Notable packages:

| Package | Purpose |
|---|---|
| `packages/parser` | A `@babel/parser` fork: MX in expression position lowers to JSX, for the Solid host. |
| `packages/core` | The Marko-node consumer every MX host is built on: structural lowerings, the IR, `HostDeclarations`, `Emitter<Out>`, three stateful-tag hooks, two front doors. |
| `packages/targets/html` | The html target: `.mx`/`.marko` compile to a pure `(input) => string` function. |
| `packages/hosts/astro` | The Astro host: components, pages, and `.astro.mx` templates, all rendered to static markup. |
| `packages/tooling/language-server` | A diagnostics-only LSP server for MX hosts. |
| `packages/editors/zed` | The Zed editor extension (three languages plus the language server registration). |
| `packages/oracle` | The parity-checking harness described below. |

Each package publishes its own README with install instructions, API surface, and implementation notes specific to that package — the pages under [Hosts](/hosts/astro/) and [Editors](/editors/zed/) summarize the parts a consumer needs; the READMEs go deeper for a contributor.

## Verify and its rules

`bun run verify` (or `moon run :verify`) is the single command that must pass before anything merges. It chains: a pre-verify step that clears stale test evidence, a build, a typecheck pass, lint, the vitest suite, the Bun-runtime test suite, the tree-sitter grammar test, a consumer-facing smoke check, and a coverage-verification script — in that order, because later steps depend on artifacts earlier steps produce.

Three rules this chain is built around:

- **A check that can never fail is not a check.** Every gate in the chain is expected to be able to fail, and is proven to fail at least once against a deliberately broken input before it's trusted. A script that only prints success is a bug, not a safety net.
- **Evidence, not vibes.** The coverage-verification step doesn't ask "does this package have test files" — it reads the actual output of the test run that just happened (a JSON report, or a marker file written only on success) and checks its timestamp is newer than the start of this verification run. A package can't be marked "tested" by leftover evidence from a previous run.
- **Clean-clone proofs.** Anything that depends on generated or vendored files (a build step, a vendored grammar) is expected to work from a fresh clone with no manual setup step, and CI is what actually proves this — a green run on a contributor's machine with stale local state doesn't count.

## The docs site as a verify step

This site (`apps/docs`) is wired into `verify` and CI the same way: `bun run --cwd apps/docs build` runs as part of the chain, and a broken page — a bad internal link, invalid config, a markdown file that fails to parse — fails the build and fails verify. The generated `site/` output directory is not committed.

## The oracles

Each host is checked against real, working reference code rather than only against expectations recorded in a test file. There are four runners, and they answer two different questions.

| Command | What it compares | Current state |
|---|---|---|
| `bun run oracle` | Each Solid fixture against a hand-written Solid twin, across both Solid 2 backends and both generate variants | 20 rows, all pass |
| `bun run oracle:marko` | Each stock fixture rendered through the real Marko toolchain *and* through the html target | 43 fixtures: 41 pass, 2 reasoned skips, 0 bugs |
| `bun run oracle:preact` | The same 43 fixtures rendered with `preact-render-to-string` | 30 pass, 13 reasoned skips, 0 bugs |
| `bun run oracle:react` | The same 43 fixtures rendered with `react-dom/server` | 30 pass, 13 reasoned skips, 0 bugs |

`oracle` asks *does MX produce what a hand-written component would*. The other three ask *does the structural core still mean what Marko means* — the regression guard for the subset rule itself. A skip is a recorded, reasoned classification in the fixture's `meta.json`, not unfinished work; a run also fails if it processed too few fixtures, so a gate that silently does nothing cannot pass.

The three host oracles are CI jobs rather than part of `verify`: the Marko toolchain is a real install and memory cost.

### Adding a fixture

A Marko-parity fixture is a directory under the html target's `fixtures-marko/` holding `input.marko`, `input.json` (the props) and `expected.html`. **Generate `expected.html` from real Marko; never hand-write it** — a hand-written expectation records what you believed, not what Marko does. If a construct is deliberately out of scope for a host, add a `meta.json` naming the reason instead of deleting the fixture.

A JSX region fixture (`packages/hosts/{react,preact,hono}/src/fixtures/region/<name>/`) holds `input.<host>.mx`, an `expected.html` rendered with the host's own renderer and a `__golden__/output.txt` of the emitted TSX; regenerate goldens with vitest `-u`. A Solid fixture is a directory holding `input.solid.mx` and a hand-written `twin.tsx`. The twin must not introduce whitespace MX drops: MX follows Marko's rule that a whitespace-only run containing a newline disappears, so `text<p>…` goes on one line in the twin wherever the MX source separates them only by indentation.

## How to add a host

A host is a `HostDeclarations` object plus an `Emitter<Out>` over `@mxlang/core`, and whatever integration glue its target ecosystem needs (a bundler plugin, a loader, a framework-specific renderer). Concretely:

1. Decide what your target's "public input language" is — the ordinary source format its own toolchain already knows how to compile (JSX text, a plain string-returning function, etc.).
2. Write the `HostDeclarations`: which names are elements versus components, which tags are inert or errors here, how a modifier or an attribute method is rejected *in your target's own words*, and — if your host wants stateful tags to mean something — the three hooks (claim a tag, hoist a statement, rewrite identifier references).
3. Write the `Emitter<Out>`: one method per IR kind. Throw, naming the construct, for anything your target cannot express — never silently skip a kind.
4. Add fixtures and wire your host into an oracle so its output is checked against real reference code, not only assertions in a test file.

See [Core and hosts](/architecture/core-and-hosts/) and [Policy and hooks](/architecture/policy-and-hooks/) for the interface itself.

## How to add a fixture

A fixture for the Marko-parity oracle lives in its own directory alongside a plain `.marko` input file, a small JSON file of props to render it with, and an `expected.html` file — generated from a real run of Marko's own toolchain, never hand-written, so the comparison is always against ground truth rather than a guess at what Marko would do. A fixture for the framework-parity oracle instead pairs an MX source file with a hand-written twin in the target framework's native syntax; both are compiled and their outputs compared across every backend and variant the target supports.

## Consumer Check

The verification chain includes a consumer smoke check. This step simulates how an end-user would consume the package, building and packing a tarball (via `npm pack`) and running a minimal test project against it. This proves the published artifact is structurally sound.

## Adding a Host to the Shared JSX Emitter

Many targets (React, Preact) share the same JSX structure. To add a new host on the shared JSX emitter:
1. Provide a dialect object containing only the differences (e.g., `className` vs `class`, `htmlFor` vs `for`).
2. Implement your specific runtime boundaries if needed (like `<try>`'s `MxErrorBoundary`).
3. Point the shared emitter at your dialect object.

## The Edit Check Hook

An edit hook (`.claude/hyper.json`) runs up to two checks after an edit, each with its own file extensions:

1. `biome check .` — formatting and lint over the whole tree, after an edit to a `.ts`, `.tsx` **or `.json`** file.
2. A per-package TypeScript check, after an edit to a `.ts` or `.tsx` file only. Each package with a `tsconfig.json` is checked with its own `typecheck` script when it has one (which is what lets the examples run `mx-tsc`), and with plain `tsc --noEmit -p` otherwise.

So editing a `.json` file runs the first check alone.

Both commands use `./node_modules/.bin` paths directly, so they work without shell shims (proto, bun, nvm wrappers). One deliberate exception: a package whose `typecheck` depends on the built `mx-tsc` binary falls back to plain `tsc` when that binary is not built yet, rather than failing — so a fresh worktree still gets useful checks before its first `bun run build`.

# `@mxlang/tsc`

`mx-tsc` — `tsc` with `.solid.mx` and `.mx` files type-checked as
the TypeScript they lower to. `--astro` additionally composes Astro's language
plugin and the AstroMX plugin, so `.astro` and `.amx` files and their MX
imports are checked together.

This is the CI half of decision 81. `tsc` ignores `compilerOptions.plugins`, so
[`@mxlang/typescript-plugin`](../typescript-plugin/README.md) does nothing on
the command line: an editor would report an error that a build silently missed.
`mx-tsc` closes that gap by handing Volar's `runTsc` the *same* language plugin
the tsserver plugin uses, so both halves share one lowering and cannot drift.

## Usage

```
mx-tsc --noEmit
mx-tsc --noEmit -p path/to/tsconfig.json
mx-tsc --astro --noEmit
```

It takes `tsc`'s own arguments and produces `tsc`'s own output and exit codes —
it *is* `tsc`, with Volar's program proxy spliced in. Point a package's
`typecheck` script at it wherever MX files are in the program:

```json
{ "scripts": { "typecheck": "mx-tsc --noEmit" } }
```

`examples/counter-app` and `examples/todomvc` both do. Astro projects pass
`--astro`; `examples/astro-static` runs the built workspace entry as
`node ../../packages/tooling/tsc/dist/bin.cjs --astro --noEmit`. The root `typecheck`
script defers to a package's own `typecheck` script when it has one, so those
three run `mx-tsc` while every other package keeps running plain `tsc`.

`--astro` is an `mx-tsc` flag, removed before TypeScript parses the rest of the
command line. It lazily loads the same optional
`@astrojs/language-server@2.16.16` peer as the tsserver plugin. `.amx` is an
Astro-only format and is intentionally ignored unless this flag is present.

## Angular template diagnostics (`.ng.mx`)

After the type-check, `mx-tsc` runs Angular's own template checker over every
`.ng.mx` that compiled (`mx.angular.diagnostics`, default on; `"off"` skips) and
prints each finding at its `.ng.mx` line and column. A template error fails the
run. `@angular/compiler-cli` is resolved from the project that holds the
`.ng.mx` (`>=22.0.0 <23.0.0`); with `.ng.mx` files present, diagnostics on, and
compiler-cli missing or out of range, `mx-tsc` fails with a message saying how
to install a supported version or turn the diagnostics off. A run with no
`.ng.mx` files never looks for it.

**Promoting a warning (NG8103).** Angular's extended diagnostics keep their
own severity: `*ngIf`/`*ngFor` used without `NgIf`/`NgFor`/`CommonModule`
imported (NG8103, check `missingControlFlowDirective`) is a **warning**, printed
at the directive's `.ng.mx` line and column, and does not change the exit code,
although the directive is inert at runtime. To fail the run on it, set it in the
tsconfig `mx-tsc` runs under, exactly as for `ng build`:

```jsonc
{
  "angularCompilerOptions": {
    "extendedDiagnostics": {
      "checks": { "missingControlFlowDirective": "error" }, // or "warning" | "suppress"
      "defaultCategory": "error" // every extended check; a per-check value wins
    }
  }
}
```

`"error"` prints it as an error and exits non-zero; `"suppress"` prints nothing.
`mx-tsc` passes the options to Angular's checker and does not apply the category
itself.

Under `tsc -b` the pass runs for **every project of the build graph** (the
named projects and, transitively, their `references`), including a project tsc
judges up to date: tsc's build info knows nothing about templates, so a
template error must fail the second, unchanged run exactly as the first. Each
project's `.ng.mx` files are those of **the program tsc itself builds for that
project**: `mx-tsc` creates it as it does in non-build mode (the same language
plugins, resolver and the project's own tsconfig, `paths` and `moduleResolution`
included; nothing is type-checked) and takes its `.ng.mx` source files. That is
what tsc compiles by definition, and it covers the Angular CLI's default
solution-style `tsconfig.json` (`"files": []`) with a non-composite
`tsconfig.app.json` (`"include": ["src/**/*.ts"]`), where no glob matches a
`.ng.mx` and every component is reached only by import. A referenced project's
sources are replaced by its output `.d.ts`, so its `.ng.mx` is owned by that
project and checked under its tsconfig. If two projects' programs both hold a
file (overlapping `include`s), the first in build order (dependencies first)
checks it, once. That ownership rule relies on claiming dependencies first: a
program can hold a referenced project's `.ng.mx` as a source file (for example
when its output `.d.ts` re-imports it), so the set a program compiles may
include a referenced lib's file, and the dependency must claim it before the
referencing project does. Compile diagnostics from the extra programs are
de-duplicated against the main run's. `--clean`
checks nothing; `--dry` builds nothing and prints, per project, that a build would check its
`.ng.mx` files; `-b --help` and a `-b` command line tsc
rejects run nothing; `--watch` runs the pass once, after the
initial build, and does not re-run it on later changes.
The cost on every `-b` run, up to date or not, is one program creation plus one
Angular checker per project; caching it is not done. See
[Angular → Template diagnostics](../../../apps/docs/docs/hosts/angular.md).

## Host-policy diagnostics

`package.json` decides which host compiles a `.mx` file. When that decision
has a problem, `mx-tsc` prints it as a warning positioned in the
`package.json`, in `tsc`'s shape:

```
package.json(5,13): warning TS80003: unknown mx.host "vue"; valid hosts: html, astro, ...
```

- an `mx.host` that names no host (with a "did you mean" hint when one is close);
- a `package.json` that cannot be parsed (the file is skipped and the default
  `html` host is used for the files under it).

The path is the location only, never repeated in the message; the language
server and the tsserver plugin print the same text as
`package.json:line:col: <message>`.

Both are warnings: the exit code is exactly what it was before they were
printed. Each is printed once per run, however many `.mx`, `.solid.mx`,
`.ng.mx` or `.amx` files sit under that `package.json`.

## Known limitations

- **Watch, Linux: a module installed after `-w -p` started is not noticed.** If
  an import fails with `TS2307` because the package is not installed yet, then you
  install it, `mx-tsc -w -p` keeps the error until you restart it. This is
  TypeScript 6.0.3's own behaviour: plain `tsc -w -p` does the same on Linux
  (it recovers on macOS), and `mx-tsc` matches it exactly. `-b -w` does recover
  on both. See `scratch/reports/review-mx-tsc-build-extensionless-resolve-r3.md`
  (repro in podman, `node:26-bookworm-slim`).
- **A package's `.d.ts` beside its `.ng.mx`.** For a project's own files, an
  `x.d.ts` next to `x.ng.mx` makes `-b`, `-w` and `-p` all resolve `./x` to the
  template. For a file inside a package (`node_modules`), `-b` and `-w` keep the
  `.d.ts` the package publishes as its types, while `-p` alone resolves the
  template.

## What it proves

From `src/fixtures/`, two projects differing only in one expression:

```
$ mx-tsc --noEmit -p src/fixtures/passing
exit=0

$ mx-tsc --noEmit -p src/fixtures/failing
src/fixtures/failing/src/Widget.solid.mx(7,32): error TS2345: Argument of type
  'string' is not assignable to parameter of type 'number'.
exit=2

$ tsc --noEmit -p src/fixtures/failing
src/fixtures/failing/src/index.ts(1,23): error TS2307: Cannot find module
  './Widget.solid.mx' or its corresponding type declarations.
exit=2
```

Plain `tsc` never opens the `.solid.mx` file at all — it fails at the import,
and reports nothing about the type error the module actually contains. `mx-tsc`
reports it at the offending argument's own line and column.

Astro mode also proves both halves of an `.amx` page are mapped precisely:

```
$ mx-tsc --astro --noEmit -p examples/astro-static/typecheck-fixtures/amx-wrong.json
amx-wrong.amx(8,7): error TS2322: Type 'number' is not assignable to type 'string'.
amx-wrong.amx(9,27): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

## How it works

`runMxTsc()` calls `runTsc` with `.solid.mx` and `.mx`; `--astro`
adds `.astro`, `.amx`, Astro's language plugin, and the AstroMX language
plugin:

- **`tscPath`** is `typescript/lib/tsc.js`, resolved relative to this package.
  `runTsc` does not spawn `tsc`; it reads that file, rewrites `createProgram`
  to route through Volar, and evaluates the result. So it needs the real entry
  point's path, not the `typescript` module's exports.
- **`getLanguagePlugins`** returns the SolidMX and whole-file MX plugins plus
  `createCompoundExtensionResolver(ts)`, and optionally Astro's plugin. The
  resolver is what makes
  `import "./X.solid.mx"` resolve; without it every import is `TS2307`, even
  though each file compiles fine on its own.
- **`tsObject`** is the string `"require('typescript')"`. This one is not
  optional, and is the subtlety worth knowing before editing `src/index.ts`:
  `runTsc`'s default is a proxy that resolves property names by `eval` inside
  `tsc.js`'s own scope, so it sees only that bundle's locals. `ScriptSnapshot`
  is not one of them — it is part of the public `typescript` module but not of
  the `tsc` entry point — so the language plugin's `ScriptSnapshot.fromString`
  call dies with `ReferenceError: ScriptSnapshot is not defined` before a
  single file is checked. Requiring the real module gives the same surface the
  tsserver plugin gets.

The binary is CJS (`dist/bin.cjs`): `runTsc` uses `require`, `require.resolve`
and `__filename`, none of which exist in an ES module.

## Tests

`src/index*.test.ts` (split by scenario family so vitest spreads them over workers; shared helpers in `src/test-support.ts`) run the built binary against the SolidMX fixtures and the
Astro example's `.astro` and `.amx` correct/wrong fixtures, asserting exact
diagnostics and exit codes (plus that plain `tsc` does *not* catch the SolidMX
error). It needs
`bun run build` to have produced `dist/bin.cjs` first —
the same fresh-worktree caveat `@mxlang/parser`'s `dist/index.js` carries;
`bun run verify` builds before it tests.

```
bunx vitest run --root ../../.. --project @mxlang/tsc
```

Most cases run `mx-tsc` in the test process through `runMxTscArgs` (an additive,
test-only export of `src/index.ts`: argv in, exit code out; the CLI does not use
it) via `src/in-process.ts`, which captures `process.stdout`/`stderr`. Runs are
synchronous and process-global, so they never overlap, and diagnostic paths print
relative to the process's working directory. A few cases spawn `dist/bin.cjs` for
the exit code and the bin path.

`src/fixtures/` is excluded from this package's own `tsconfig.json`: the
failing fixture is *meant* to be a type error, and must not fail the package's
own typecheck.

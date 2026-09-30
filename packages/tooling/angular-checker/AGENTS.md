# angular-checker — agent instructions

## `@mxlang/angular-checker`: Angular template diagnostics (decision 99)

`packages/tooling/angular-checker` runs `@angular/compiler-cli`'s
`NgtscProgram` over an in-memory `.ts` module (a component with an inline
template) under `strictTemplates`, and returns template diagnostics as **plain
records** — `{ file, start, length, code, message, category, source }`.
`createAngularChecker({ projectDir, tsconfigPath?, angularCoreTypes? })` gives
`check`/`update`/`dispose`; `check` retains the program and passes it as
`oldProgram`, so successive checks are incremental, and takes an optional
cancellation token (callers own the debounce — ruling e).

It is a **separate package from `@mxlang/angular`** so the emitter keeps zero
Angular runtime deps (decision 79); `@angular/core` is a devDependency so the
tests check against real Angular types. `@angular/compiler-cli` is an
**optional peer dependency** (`>=22.0.0 <23.0.0`, plus a devDependency for the
tests), never bundled: `resolveCompilerCli(projectDir)` (`src/compiler-cli.ts`)
loads it with `createRequire(<projectDir>/package.json)`, checks its version
*before* loading it, and answers `ok` / `missing` / `out-of-range` /
`load-failed`, each non-ok one with a message saying how to fix it or turn the
diagnostics off. `createAngularChecker` resolves it at creation and throws
`CompilerCliUnavailableError`, so an unusable compiler-cli can never return an
empty list that reads as success. This package ships inside the VS Code
extension's TS plugin and `mx-tsc`, neither of which may carry Angular's
compiler, hence runtime resolution from the user's project. Consumers decide
what a failure means: `mx-tsc` fails the run, an editor shows the message once.
The package depends on `@mxlang/angular` (for `compileNgMx`'s result type and
`sourceOffsetFor`).

`typescript` is a **required peer dependency** (`>=5.9.0 <7`, the repo's peer policy for `typescript`; the pinned devDependency stays exact): `dist/*.d.ts` imports `typescript`, and `scripts/pack-hygiene.test.ts` fails a shipped declaration or runtime import that no dependency or peer declares.

**`diagnoseNgMx(compiled, checker, virtualPath)`** (`src/diagnose.ts`) is the
`.ng.mx` entry: it checks `compiled.code`, keeps `source: "ngtsc"` records and
**drops `"ts"`** ones (Volar/`tsc` already report those), and maps each
module-absolute offset to the `.ng.mx`: `sourceOffsetFor` (whole-to-whole, the
length is the whole mapped expression), else the enclosing region's start
(`NgMxRegion.generatedStart/End`), else the module source map, else offset 0 —
a diagnostic is never dropped. Output is `source: "angular"`. `virtualPath` must
sit in the project so `@angular/core` resolves; `mx-tsc` uses
`<file>.ng.mx.ts`. Each result carries `mapped` (`exact` / `region` /
`sourcemap` / `none`): element- and attribute-level ngtsc diagnostics (NG8001,
NG8002) have no expression mapping and land on the region start (`region`),
which mx-tsc marks "(approximate location)"; mapping them to the tag is
2.3b-2 work. `tsconfigPath` is parsed against the tsconfig's own directory and
a read/parse error throws `TsconfigError` — never a silent fallback to
defaults. `getNgStructuralDiagnostics` is not collected: decorator errors
already arrive via the semantic phase (see README, Known gaps).

It uses the **workspace TypeScript** (6.0.3) like every other package here.
*History, one sentence:* it originally carried its own `typescript@6` behind
`src/ts6-shim.ts`, because the repo pinned 5.9.3 while `compiler-cli@22.1.7`
required `>=6.0 <6.1` (spike option B, chosen over bumping the repo) — PR #101
moved the repo to 6.0.3, so the shim was deleted per its own header
instructions. The **plain-record `Diagnostic` contract survives the shim**: it
was forced by two non-assignable TypeScript instances, and is kept because it
keeps consumers off TypeScript's object graph.

**What it reports.** One list, each record tagged by `source`: `"ngtsc"` for
template diagnostics (type errors with ordinary TS codes, plus parse errors
with negative codes) and `"ts"` for ordinary TypeScript diagnostics of the
checked module, **including errors in the component's own class body**.
`getNgSemanticDiagnostics` covers templates only, so a class-body error yields
zero Angular diagnostics — returning a clean list for a file that does not
compile would read as success. Consumers filter on `source`, never a code
range. `strictTemplates` is **not** forced: the project's
`angularCompilerOptions` (read with compiler-cli's `readConfiguration`, through
`extends`) reach ngtsc unchanged, and unset follows compiler-cli's default (on
in 22.x, `strictTemplates !== false`). `false` still checks in basic mode, so
the checker is never silently off (supersedes the PR #104 "forced on" ruling).
`configDiagnostics()` returns compiler *option* errors (`getNgOptionDiagnostics` +
TS `getOptionsDiagnostics`, e.g. `extendedDiagnostics` with `strictTemplates:
false`): config-level, not per file, deduped, `file` = the tsconfig; mx-tsc
reports them once per project and fails on errors. It is a separate method
(not a `check` record or a creation-time `TsconfigError`) because option
diagnostics exist only once a program has been built.

**`@angular/core` must resolve from `projectDir`**, or a template using a
signal input or `signal()` has nothing to check against and a broken one
reports zero diagnostics — the silent-zero trap by a second route (measured:
with `compiler-cli` but no `core`, `{{ u().nmae }}` gives 0 instead of 1). It
is a devDependency of this package so its own tests check against real types,
and the resolution is asserted directly.

Two traps, both pinned by tests:

- **A host that cannot read the virtual file yields zero diagnostics and no
  error**, indistinguishable from success. `buildHost` must override
  `readFile`/`fileExists`/`getSourceFile`; removing them makes 9 of the 17
  checker tests fail while the *good-template* test still passes — the
  silent-zero mode itself.
- **`"sideEffects": false` empties `dist/`.** With that field, `bun build`
  tree-shakes the graph away and emits a 56-byte `index.js` re-exporting names
  it never defines; the build still reports success. `src/dist.test.ts` asserts
  the field stays absent and that the built entry has a real body.

Diagnostic offsets are **1:1 with the template text**, because templates are
emitted as backtick literals (ruling c) — no escape-aware inverse, even across
newlines and embedded double quotes.


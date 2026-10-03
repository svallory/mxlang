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
`<file>.ng.mx.ts`. Each result carries `mapped` (`exact` / `node` / `region` /
`sourcemap` / `none`): `exact` is inside a mapped expression; `node` is a start
tag or attribute (NG8001/NG8002 start at generated punctuation, a `<` or `[`,
that no mapping covers), resolved through `CompileNgMxResult.anchors` to the
authored element name, or the attribute from name through value (a default
attribute `<switch=title>` has no spelled name and lands on its value). Both
are precise; `region`/`sourcemap`/`none` are degraded and mx-tsc and the TS
plugin mark them "(approximate location)". An offset with no anchor keeps the
fallback, never a guessed position. Not covered: a position *inside* an
expression resolves to the whole expression's start (whole-to-whole, see
`packages/hosts/angular/src/mapping.ts`). `mx-angular build` runs no Angular
template check, so these diagnostics appear on `mx-tsc` and in the editor only.
`tsconfigPath` is parsed against the tsconfig's own directory and
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
diagnostics have no file position. It builds a throwaway program on demand when
nothing has been checked, so `[]` always means "no option errors".
**Editor wiring (2.3b-2a, done):** the TS plugin runs the checker in a forked
worker (`src/worker.ts` protocol loop, `worker-main.ts` entry, `worker-client.ts`
client: `createCheckerWorker`). Fork, not `worker_threads`: a run stuck in
synchronous ngtsc can only be stopped by killing a process. The client keeps one
request in flight, supersedes per file, and kills+restarts a worker still busy
`graceMs` (5 s, `DEFAULT_GRACE_MS`) after its run went stale; an unusable
compiler-cli/tsconfig is a sticky `unavailable` outcome. `mapNgMxDiagnostics`
maps worker records like `diagnoseNgMx`. Still true for any caller: `check()` never returns these, so an editor path
must call `configDiagnostics()` once per project (not per file or per
keystroke) and show the `"ngtsc"` records against the tsconfig; drop the `"ts"`
ones, which the TypeScript pass already reports. Warnings are shown, never failing.

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

**Typecheck hygiene (angular-checker-dist-before-typecheck):** `typecheck`
runs `tsc -p tsconfig.typecheck.json`, which maps
`@mxlang/core`/`@mxlang/parser`/`@mxlang/angular` to their src via `paths`
(the #182/#192 pattern), so no typecheck needs a prebuilt or fresh dep `dist`.
The mapping must NOT move into `tsconfig.json`: Bun's bundler honours the
nearest tsconfig's `paths`, and the typescript-plugin VSIX bundle inlines this
package's src, so it would follow `@mxlang/angular` into the Angular host's src
and fail on that package's parser -> `public.d.ts` mapping (`vscode-extension`
CI job, `No matching export … for import "parse"`). `tsconfig.json` and
`tsconfig.build.json` resolve the deps through their published dist types.

Diagnostic offsets are **1:1 with the template text**, because templates are
emitted as backtick literals (ruling c) — no escape-aware inverse, even across
newlines and embedded double quotes.


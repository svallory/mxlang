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
Angular runtime deps (decision 79); `@angular/compiler-cli` is an ordinary
dependency of this package alone, and `@angular/core` is a devDependency so the
tests check against real Angular types.

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
range. `strictTemplates` is forced on even when a project tsconfig sets it
false, since honouring false would silently disable the checker while still
returning an empty list.

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


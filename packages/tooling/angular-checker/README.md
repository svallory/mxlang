# `@mxlang/angular-checker`

Angular template type-check diagnostics for MX (decision 99, spike §Q1/§Q5).

Given an in-memory `.ts` module string — a component with an inline template —
plus the project's tsconfig and `@angular/core` types, it returns template
diagnostics as **plain records**: no TypeScript object ever crosses the package
boundary.

```ts
import { createAngularChecker } from "@mxlang/angular-checker";

const checker = createAngularChecker({ projectDir: "/path/to/app" });

const diagnostics = checker.check("/path/to/app/x.component.ts", source);
//   [{ file, start, length, code, message, category, source: "ngtsc" }]

checker.update("/path/to/app/y.component.ts", otherSource); // no check
checker.dispose();
```

## Why this package exists separately

`@mxlang/angular` (the emitter) ships **no Angular runtime dependency**
(decision 79). The Q1 diagnostics path needs `@angular/compiler-cli` at
check time, so it lives here instead, as a tooling package.

`@angular/compiler-cli` is an **optional peer dependency**
(`>=22.0.0 <23.0.0`), resolved **from the user's project at runtime** and never
bundled: this package runs inside the VS Code extension's TypeScript plugin and
`mx-tsc`, neither of which may carry Angular's compiler.
`resolveCompilerCli(projectDir)` reports `ok`, `missing`, `out-of-range` or
`load-failed` (each with a message telling the user what to install, or to set
`mx.angular.diagnostics` to `"off"`), and `createAngularChecker` throws
`CompilerCliUnavailableError` rather than returning a list that reads as clean.
The version is checked before the module is loaded.

`typescript` is a **required peer dependency** (`>=5.9.0 <7`): the emitted
`dist/*.d.ts` imports `typescript` types, so a consumer typechecking with
`skipLibCheck: false` needs it resolvable. Every consumer of the TypeScript
plugin or `mx-tsc` already has one.

## `.ng.mx`

```ts
import { compileNgMx } from "@mxlang/angular";
import { createAngularChecker, diagnoseNgMx } from "@mxlang/angular-checker";

const compiled = compileNgMx(source, "/app/x.component.ng.mx");
const checker = createAngularChecker({ projectDir: "/app" });
diagnoseNgMx(compiled, checker, "/app/x.component.ng.mx.ts");
//   [{ start, length, code, message, category, source: "angular" }]   (offsets in the .ng.mx)
```

Only `"ngtsc"` records are kept (`"ts"` ones are dropped: Volar/`tsc` report
those). Each offset maps back through `sourceOffsetFor` (whole-to-whole: a
position inside an expression resolves to the expression's start, `length` being
the whole expression), else the enclosing region's start, else the module source
map, else offset 0: a diagnostic is never dropped.

## TypeScript

At run time the checker uses the **project's** `typescript`, resolved by `resolveTypescript`, never a copy of its own: from the resolved compiler-cli's own location first (the instance compiler-cli itself loads), falling back to `projectDir`: the forked worker is handed no `ts` by tsserver, and the VSIX ships none. A project without `typescript` gets the same one-notice "unavailable" outcome as a missing compiler-cli, and the message names `typescript`. In this repo that resolves to the workspace TypeScript (6.0.3).

*History:* this package originally carried its own `typescript@6` behind a shim
(`src/ts6-shim.ts`), because the repo pinned 5.9.3 while
`@angular/compiler-cli@22.1.7` required `>=6.0 <6.1` — spike option B, chosen
over bumping the whole repo for one host's benefit. PR #101 moved the repo to
6.0.3, so the shim was deleted per its own header instructions and this file
now imports `typescript` directly.

The **plain-record `Diagnostic` contract is unchanged**. It was originally
forced (types from two TypeScript instances are not mutually assignable) but is
kept on its own merits: it keeps consumers off TypeScript's object graph and
lets a diagnostic cross a process or cache boundary.

## What is and is not reported

**Reported**, all in one list, each record tagged by `source`:

| `source` | what |
|---|---|
| `"ngtsc"` | Angular **template** diagnostics: type errors inside interpolations and bindings (ordinary TS codes, e.g. 2339), and template **parse** errors (negative codes, e.g. -995002). |
| `"ts"` | Ordinary **TypeScript** diagnostics for the checked module — syntactic and semantic — including errors in the component's own class body. |

Both classes are collected because `getNgSemanticDiagnostics` covers templates
*only*: a component whose class body has `bad: number = "str"` yields **zero**
Angular diagnostics, and returning a clean list for a file that does not
compile would read as success. Filter on `source`, never on a code range.

**`@angular/core` must resolve from `projectDir`.** A template using Angular's
own API (a signal input, `signal()`) has nothing to check against otherwise, so
a deliberately-broken one reports **zero** diagnostics and reads as clean —
the silent-zero trap by a second route. Measured: with `compiler-cli` present
but no `core`, `{{ u().nmae }}` yields 0 ngtsc diagnostics instead of 1.
`@angular/core` is a devDependency of this package so its own tests check
against real types, and `checker.test.ts` asserts the resolution directly.

**Not reported**: anything outside the checked module (imported files are
type-checked as dependencies, but their own diagnostics are not returned).
`check` itself does not map back to a `.ng.mx` source — its offsets are in the
`.ts` text handed in; `diagnoseNgMx` (above) does.

**`strictTemplates` follows the project**, it is not forced. Whatever
`angularCompilerOptions` the project's tsconfig sets, through its `extends`
chain (`strictTemplates`, `strictInputTypes`, `strictNullInputTypes`, ...),
reaches ngtsc unchanged, so the checker reports what `ng build` reports. When
the tsconfig does not set `strictTemplates`, `@angular/compiler-cli`'s own
default applies, which is **on** in 22.x
(`get strictTemplates() { return this.options.strictTemplates !== false; }`,
`chunk-M25TUZDV.js:4950` in 22.1.7). With `strictTemplates: false` ngtsc still
type-checks templates in *basic* mode (an unknown property such as `{{ nope }}`
is an error), so the checker is never silently off; only the strict-only checks
(a `string | null` bound to a `string` input, for example) stop being reported.

Compiler *option* errors are not file diagnostics, so `check` never returns
them: `configDiagnostics()` does (`extendedDiagnostics` combined with
`strictTemplates: false` is one, which `ng build` rejects). Each record names
the tsconfig and each distinct problem appears once however many files were
checked; `mx-tsc` fails the run on them, once per project.

*History:* earlier versions forced it on (PR #104), so a project that builds with
`strictTemplates: false` would fail `mx-tsc` on errors `ng build` accepts, once CI
counted template errors. That decision is superseded.

## Known gaps

- **Element and attribute diagnostics land on the region start.** ngtsc reports
  an unknown element (NG8001) or unknown property (NG8002) at the tag or
  attribute, which no expression mapping covers, so `diagnoseNgMx` falls back
  to the start of the `template:` region (`mapped: "region"`, or
  `"sourcemap"`); on a multi-line template the reported line is the region's
  first line, not the tag. Mapping these to the tag is later work (2.3b-2).
  Expression-level errors (`${user.nmae}`) are exact.
- **`getNgStructuralDiagnostics` is not collected.** Decorator-analysis errors
  (`imports: [123]`, a missing template, two incompatible decorators) already
  arrive through `getNgSemanticDiagnostics`, each exactly once; the structural
  list was probed on those cases and added nothing, so it is left out rather
  than deduplicated.
- **One TypeScript instance, in practice.** The checker builds compiler
  options and the host with the project's `typescript`, and
  `@angular/compiler-cli` loads its own peer `typescript`. In a normal install
  those are the same copy; a project that nests a second one is untested.

## Diagnostic offsets

Templates are emitted as **backtick literals** (ruling c), so a diagnostic
offset inside the template literal is **1:1 with the raw template text** —
subtract the offset of the character after the opening backtick and the result
indexes the template directly. No escape-aware inverse is needed, even across
newlines and embedded double quotes. `checker.test.ts` pins this with a
multi-line template.

The quoted-string form the spike measured would instead put offsets in
*escaped* coordinates (`\n` counting as 2 characters), which is why ruling c
matters to this package.

## Incrementality and cancellation

`check` retains the `NgtscProgram` and passes it as `oldProgram` on the next
call, so an edit-then-check cycle avoids a cold compile. Reuse is asserted by
**counting real compilations**, not by timing: the spike measured a ~7x spread
in run cost under machine load, so a timing assertion would be flaky.

Cancellation is **cooperative**. `NgtscProgram` exposes no cancellation token,
so `check` polls the caller's token at phase boundaries (before constructing
the program, and before the expensive diagnostics pass). A cancelled run
returns `[]` rather than throwing, and leaves the checker usable. Callers own
the debounce policy (ruling e: 1 s idle / on-save); this package only exposes
the token.

## The trap

**A host that cannot read the virtual file yields zero diagnostics and no
error** — indistinguishable from a clean bill of health. `NgtscProgram` does
not report an unreadable root file; it analyzes nothing and returns a clean
result.

So `buildHost` must override `readFile` / `fileExists` / `getSourceFile` for
the virtual path. `checker.test.ts`'s known-bad-template test is the guard, and
it has teeth: removing those overrides makes 9 of the 17 tests fail — while the
*good-template* test still passes, which is precisely the silent-zero failure
mode.

## Tests

```
bunx vitest run --root ../../.. --project @mxlang/angular-checker
```

Covers: `@angular/core` resolving from the project dir (the precondition for
every other test); a known-bad template producing a diagnostic positioned
inside the template, and a good one producing none; a bad property on a signal
input's and a `signal()`'s type (code 2339); checking inside `@if`/`@for`
control flow; a missing `track` reported as a parse error with a negative code;
an ordinary TypeScript error in the component's class body reported with
`source: "ts"`; every diagnostic carrying a source; 1:1 offsets across a
multi-line template; program reuse asserted by counting constructions that
received an `oldProgram`; cancellation resolving without throwing and leaving
the checker usable; `update` contents being what gets checked; and
use-after-`dispose` throwing.

## A build trap: `sideEffects: false`

This package deliberately does **not** declare `"sideEffects": false`, unlike
most packages here. With that field set, `bun build` tree-shakes the entire
module graph away and emits a 4-line `dist/index.js` that re-exports names
which are never defined — the build reports success ("Bundled 1 module") and
the failure only appears when something imports the built artifact:

```
ERR Export 'createAngularChecker' is not defined in module
```

Measured: 56 bytes with the field, 4.42 KB without it. If a future change adds
it back, `dist/` silently becomes an empty shell.

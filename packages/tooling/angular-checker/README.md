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
check time, so it lives here instead, as a tooling package, and
`@angular/compiler-cli` plus `typescript@6` are ordinary dependencies of *this*
package only.

## TypeScript

Uses the workspace TypeScript (6.0.3), like every other package here.

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
type-checked as dependencies, but their own diagnostics are not returned), and
mapping back to a `.ng.mx` source — offsets are in the `.ts` text handed in.

**`strictTemplates` is forced on**, even if the project's `tsconfig.json` sets
it to `false`: it is the checker's reason to exist, and honouring `false` would
silently turn template checking off while still returning an empty list.

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

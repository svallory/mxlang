# @mxlang/core

## 0.1.0 (unreleased)

### A custom tag's template is a compilation unit (decision 95)

A discovered template tag (`tags/icon.mx`) is no longer expanded into its
caller. It compiles through the same per-file pipeline a page uses, into a
module, and the caller emits an injected `import` plus an ordinary component
call — the shape an explicitly imported tag already produced on all six hosts.

- **breaking:** **a tag's `static` block now runs once per _process_, not once
  per calling module.** Its statements live in the tag's own module and are
  evaluated at import time, which is the module system's rule and Marko's own
  model. This is observable for any tag whose `static` block has side effects
  (a counter, a registration, an allocation): previously each calling module
  re-ran it, and now the first import does. A tag that needs per-call work
  should do it in the template body rather than in `static`.
- **breaking:** a template's `import`s no longer hoist into the caller's
  module, so the "same local name from a different module" error is gone along
  with the merge that raised it.
- **added:** `input` is a real parameter rather than a substituted name. A
  template may read an attribute any number of times (the caller's expression
  is evaluated once, at the call), accept a spread, use `input` as a value, or
  destructure it — every limit the substitution engine carried is gone.
- **added:** a tag file may export anything, and its `export interface Input`
  is now the tag's public type, typing the call site through the import.
- **added:** a tag may call itself; a module importing itself is legal ESM, so
  recursion terminates on the tag's data rather than on a compiler depth cap.
  **Mutual and self cycles between tag templates are now legal** rather than a
  compile error naming the path: two templates that call each other are an
  ordinary module cycle, and the unit mid-compile is recorded as `pending` so
  the metadata lookup terminates. Deliberate — the cycle detector existed only
  because inlining could not terminate.
- **added:** `parseOptions.openTagOnly` with a body is a positioned MX error at
  the call site (`` `<x>`: does not accept content ``) rather than a Marko
  parse error; `<@content>` on a tag call is rejected.
- **added:** compiling a tag unit caches `{ readsContent, attributeTags }`, so
  a body passed to a tag that never reads `input.content` still warns at the
  call site — MX's improvement over Marko, preserved across the rewrite.
- **removed:** the template expansion engine — `input` substitution, hygiene
  renaming, caller-side import/static merging, the expansion depth and node
  caps, and the template cycle detector. A tag being a separate module makes
  each of them unnecessary rather than merely unused.
- **fixed:** a discovered tag whose template contains a `static` block no
  longer crashes the compiler with `unexpected module-level node kind "Static"
  in the body walk`.
- **added:** `Import` carries `synthesized`, plus `specifier` and
  `resolvedPath`, set only on an import the compiler minted for a discovered
  tag. They exist for one host: a `.solid.mx` MX region is an *expression* with
  no module scope of its own, so `@mxlang/solid` now splits its
  module-level-statement rejection by **origin** rather than by kind. An
  authored `import`/`static`/`export` inside a region is still the same error;
  a synthesized one is returned on `CompileSolidMxResult.hoistedImports`, and
  `@mxlang/parser` writes it into the surrounding TypeScript module — once per
  **resolved path**, reusing the module's own authored default import of the
  same file when present, and never reusing a *type-only* import (it binds no
  runtime value) or one shadowed by a scope enclosing the region (the reused
  name would resolve to the shadow). This closes the last `oracle:custom-tags`
  skip: the gate is
  **24/24 with none recorded**. Every other host emits both kinds identically
  and ignores the flag.
- **breaking:** **every emitted module's default export is now named after its
  file** — `icon.mx` emits `export default function Icon(…)`, `table-of.mx`
  emits `TableOf` — on html, the shared preact/react/hono emitter, and
  `compileSolidUnit`. `Ir.exportName` carries the derived name, re-minted if it
  collides with anything the file already binds. This is observable for any
  consumer that matched the compiled module's export line as *text*: the
  name varies per file now, so a matcher must read it back rather than pin
  `render`. Four in-tree matchers were updated accordingly.
- **added:** **a self-recursive tag calls its own export, with no self-import**
  (design invariant §7.5-7). When a discovered tag's resolved path is the file
  being compiled, the caller emits a call to the module's own named
  declaration rather than `import $mx_Tree1 from "./tree.mx"`. Importing a
  file into itself is legal ESM and did work, but it is a module importing a
  binding it already has. The `tree` oracle fixture covers it on all six
  hosts, three levels deep.
- **added:** `@mxlang/solid` gains `compileSolidUnit`, a whole-file entry point
  beside the region entry point `compileSolidMx`. A tag unit is a file, so its
  module-level statements are placed rather than rejected. It **silently drops
  `export interface Input`** rather than emitting it — Solid's compiler takes
  source text and has no TypeScript frontend, so a type declaration there is a
  downstream syntax error. This is deliberate and pinned by a test, but it is
  an asymmetry worth knowing: the region path *errors* on an authored
  `export interface Input` while the unit path accepts and ignores it. Typing a
  unit's props is phase 3, through the same virtual-file projection the
  TypeScript plugin already does for `.solid.mx`.

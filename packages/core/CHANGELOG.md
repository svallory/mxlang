# @mxlang/core

## 0.1.0 (unreleased)

### `Expr` gains a file-absolute span (core contract C4)

`Expr.span?: SourceSpan` carries file-absolute byte offsets of an
expression's own authored source text, filled by `exprOf` for every
construction site (attribute values, spreads, interpolations, `<for>`
sources and keys, `<const>`/`<return>` initializers, component call
arguments) and absent only for a synthesized `Expr` or a fabricated literal
default — never a fabricated span pointing at unrelated text. Additive: no
existing field changed shape. `mapping.ts` gains `mappedExpr(expr)`, a thin
wrapper over `mapped(expr.code, expr.span ?? null)`; no host adopts it in
this change.

### `<return>` and `/var`: a tag hands one value back (decision 95)

A template may end with `<return value=EXPR/>`, and a caller binds that value
with `/var`:

```marko
<!-- tags/counter.mx -->
<span>${input.start}</span>
<return value=input.start + 1/>
```

```marko
<counter/next start=41/>
<p>${next}</p>
```

- **`<return>` is value only.** Marko also accepts `valueChange`; MX 1 ships no
  two-way channel, so that attribute is rejected by name rather than accepted
  and dropped.
- **At most one per template, at the top level only.** Not inside a native tag,
  `<if>`/`<else>`, `<for>`, an attribute tag or a `<define>`. A returning tag
  returns unconditionally, which is what makes its signature a single shape
  rather than `T | undefined` per path — and because a unit compiles without
  seeing any of its callers, no call site can widen it. The grammar is Marko's,
  ported from its own `<return>` translator with MX wording; all eleven of its
  compile-time error fixtures have a counterpart test.
- **`<return>` in a page is legal** and means the same thing: a page is a module
  that returns a value nobody reads yet. It used to be a hard error on the html
  and JSX hosts, on the grounds that a compiled template "has no parent to
  return to" — true only while a tag was expanded into its caller.
- **breaking:** a unit that declares `<return>` changes its export shape. On
  html and the JSX hosts the default export returns `{ value, output }` rather
  than the output alone; on Solid the value comes back through a generated
  callback prop, because a Solid component's return value is its view. A unit
  with no `<return>` is unchanged. Astro renders an MX component through its
  own renderer, which unwraps the pair there.
- **`/var` is top-level-only on the JSX hosts and Solid.** Those targets lower
  `<if>` and `<for>` to *expressions* — a ternary, a `.map` callback, a `<For>`
  render prop — so a callback scope has no statement position to hold the
  binding, and hoisting the call out of it would read bindings that do not
  exist there and run once for a body rendered N times. Writing one there is a
  positioned error naming the tag; the call itself, without `/var`, works
  everywhere. html and Astro `.mx` support the nested case. Lifting the
  restriction is MX 2 work.
- **`/var` is not supported in a `.amx` file**, which has no statement position
  of its own; a `.amx` template may still *call* a returning tag and render its
  output.
- **A returning unit on a JSX host may not import hooks.** It is invoked as a
  plain function rather than mounted, so Preact's and React's hook dispatchers
  would bind its hooks to the *calling* component's hook list: order-dependent,
  broken under a conditional or looped call, and `useContext` reading the
  caller's position in the tree. Importing a `use*` binding from
  `preact/hooks`, `preact/compat`, `react` or `hono/jsx` into a unit that
  declares `<return>` is a compile error. Solid is unaffected — its callback
  prop keeps the unit a real component.
- **The Solid binding is one-shot, not reactive.** It holds the value from the
  single invocation that produced it, which matches `/var`'s meaning on every
  other host — but a Solid author may reasonably expect a signal, so a tag
  wanting reactivity should return an accessor for the caller to call.
- **The binding's type is the `<return>` expression's inferred type**, and a
  wrong prop at a discovered tag's call site is a TypeScript error at the
  caller's own position, through the tag's `export interface Input`.
- Three positioned diagnostics replace what would otherwise be `undefined` or a
  run-time crash: `/var` on a tag whose template has no `<return>`; a `/var`
  read outside its declaring block (MX rejects the escape rather than hoisting
  the binding into a getter as Marko does, which would change its type); and a
  read before the call that binds it.

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

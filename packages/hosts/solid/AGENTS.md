# solid — agent instructions

## Solid 2 target and pin policy

SolidMX targets **Solid 2 only** — no Solid 1 lowering table, no dual target. Pins: `solid-js`, `@solidjs/web`, `@solidjs/babel-plugin`, `@solidjs/compiler` all at `2.0.0-rc.7`. `babel-preset-solid` and `vite-plugin-solid` are dead ends (renamed upstream).

Solid 2 is pre-stable and RCs ship weekly. Policy: **pin one RC and stay on it**; re-sync the research note on each bump we choose to take, and do not chase every RC. See `README.md` "Solid 2 RC policy".

Consequences encoded in the lowering table: `Index`/`Key`/`mxRange` are gone (one `For` with a `keyed` prop, plus `Repeat`); `classList` is gone (one `class` prop taking a string, object, or recursive array); `on:`/`oncapture:`/`attr:`/`bool:`/`use:` are parse errors with fix-it hints (only `prop:` survives); `<try>` lowers to `Errored`/`Loading`. No runtime-helper imports and no `needsImport` machinery: both compilers auto-import the builtIns (`For Show Switch Match Loading Reveal Portal Repeat Dynamic Errored`).

## `@mxlang/solid`: the Solid host on `@mxlang/core`

`packages/hosts/solid` (`@mxlang/solid`, decisions 69, 71, 72, 79, 81) is the
third emitter over the core IR — SolidMX's `.solid.mx` becomes Solid JSX
text instead of a string or Astro template. `packages/hosts/solid/README.md`
carries the full lowering table (IR kind to Solid JSX), the error list, and
the `.solid.mx` bridge paragraph; the summary here is the package-map entry.

Two facts worth knowing before touching it:

- **It is an `Emitter<string>`, same shape as `@mxlang/astro`'s
  `.amx` emitter**: `IfChain` becomes `<Show>` (≤2 conditioned branches) or
  `<Switch>/<Match>` (3+); `For` becomes `<For each keyed>` (`of=`/`in=`) or
  `<Repeat count from>` (`from=`/`to=`/`until=`, with `step` folded into a
  per-row callback when present); `<try>` is a `HostTag` (`claimsTag`/
  `resolveHostTag`) lowering to `<Loading>`/`<Errored>`.

- **A `<for>` body always reads its params as values; the emitter rewrites
  the reads.** Solid 2 hands some `<For>` callback parameters as accessors
  and the shape follows the keying mode
  (`solid-js/types/client/flow.d.ts`): no `keyed` prop gives a value row and
  an accessor index; `keyed={fn}` (`by="field"`/`by=(fn)`) gives accessors for
  both. Rather than make MX authors write `p().name` on some forms and
  `p.name` on others, every read of an accessor-backed param is rewritten to
  call it, through `@mxlang/core`'s `rewriteAccessorReads` (an AST pass that
  respects shadowing, not a regex). `in=` is the special case: `keyed={e =>
  e[0]}` makes the entry one accessor, so the pair cannot be destructured in
  the parameter list — `([k, v]) =>` throws `TypeError: {} is not iterable` —
  and the callback takes a generated `mxEntry` with `k`/`v` reading
  `mxEntry()[0]`/`[1]`. Reads are rewritten rather than snapshotted to a
  `const` at callback top, which would go stale on a same-key row
  replacement. Assigning to an accessor-backed param is a positioned compile
  error. Full table in `packages/hosts/solid/README.md`. Nothing Solid-specific
  reaches `packages/core` beyond the two IR fields (`ForSource.range.step`,
  `For.key`) every Marko-syntax host needs regardless of target — see the
  core README's IR table.
- **`.solid.mx` region discovery stays in `@mxlang/parser`.**
  `packages/parser/src/mx/{walk.ts,bridge.ts}` (the vendored Babel's JSX
  plugin, replaced to recognize `<` in expression position) find each MX
  region and hand its raw text to this package's `compileSolidMx`, which
  resolves it through `@mxlang/core`'s `parseFragment` and re-splices the
  emitted JSX text back into the surrounding TypeScript AST at the same
  span — so positions and the eventual source map stay anchored to the
  original `.solid.mx` file. `@mxlang/parser`'s own `lower.ts`/`control.ts`/
  `attrs.ts` (the pre-core-IR lowering) are deleted; that lowering now lives
  entirely in this package. See `packages/parser/README.md`.

- **Attribute-tag values are accessors on Solid (decisions 106–107).** This
  host declares `attrTags: 2` and emits only core's resolved `attrTagProps`.
  Solid 2.0.0-rc.7 client measurements rule out an eager JSX value (one DOM
  node moves when rendered twice) and a getter (fresh nodes, but the value
  handed to `<Dynamic>` is not a component). The reusable renderable is
  `() => SolidElement`: it stays live, renders more than once, works through
  direct insertion and `<Dynamic>`, and composes inside reactive arrays.
  Parameters add the outer render-prop function, `(p) => () => JSX`.
- **A region receives its surrounding module imports and reports callee
  dependencies.** `compileSolidMx` seeds `ctx.importSpecifiers` from the
  parser bridge and returns `ctx.dependencies`, allowing imported callees to
  resolve their `Input` and Vite to invalidate callers. The registered
  `.solid.mx` callee reader replaces regions with `null`; declaration reading
  needs no output, and compiling them there would recurse for mutual imports.

Decision 72's subset rule removed four SolidMX constructs real Marko itself
rejects (tag params on `<if>`, tag params and attribute tags on native
elements, `<fragment>`) — see `divergences.md`'s "Deferred to MX 2" table for
each construct, Marko's exact error, and the test that used to cover it.

# solid — agent instructions

## Solid 2 target and pin policy

SolidMX targets **Solid 2 only** — no Solid 1 lowering table, no dual target. Pins: `solid-js`, `@solidjs/web`, `@solidjs/babel-plugin`, `@solidjs/compiler` all at `2.0.0-rc.7`. `babel-preset-solid` and `vite-plugin-solid` are dead ends (renamed upstream).

Solid 2 is pre-stable and RCs ship weekly. Policy: **pin one RC and stay on it**; re-sync the research note on each bump we choose to take, and do not chase every RC. See `README.md` "Solid 2 RC policy".

Consequences encoded in the lowering table: `Index`/`Key`/`mxRange` are gone (one `For` with a `keyed` prop, plus `Repeat`); `classList` is gone (one `class` prop taking a string, object, or recursive array); `on:`/`oncapture:`/`attr:`/`bool:`/`use:` are parse errors with fix-it hints (only `prop:` survives); `<try>` lowers to `Errored`/`Loading`. Both compilers auto-import the builtIns (`For Show Switch Match Loading Reveal Portal Repeat Dynamic Errored`), and escaped block values additionally request `@solidjs/web`'s public `escape` helper through the region's hoisted-import channel. **That auto-import is Solid's own compiler stage** (`@solidjs/vite-plugin`'s native or Babel compiler), which never runs inside the type-check projection — see `packages/tooling/typescript-plugin/AGENTS.md`'s note on `appendSolidBuiltinImport`, which supplies the same names there so `tsc`/tsserver can resolve them too.

Event props emitted by this host (`onClick=`, `on-dblclick=`, …) are looked up in `@solidjs/web`'s own declared `jsx.d.ts` spelling (`event-names.ts`'s vendored `SOLID_EVENT_PROP_NAMES`, drift-tested against the installed package), not recomposed by capitalizing only the DOM name's first letter — 97 of the 143 declared names differ from `onDblclick`-style capitalize-first (`onDblClick`, `onKeyDown`, …). Solid's runtime lowercases whatever follows `on` regardless of casing (`prop.slice(2).toLowerCase()`), so this is a typing-only change: it can never bind a different DOM event, only satisfy or fail `jsx.d.ts`'s exact prop-name keys.

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
  Consumers pass those parameters at the dynamic call site
  (`<${input.item.content("Ada")}/>` for data,
  `<${input.item("Ada")}/>` for renderable). Escaped root interpolations use
  Solid's public server `escape` helper while retaining the original value in
  the browser, which preserves both SSR safety and reactive DOM insertion.
- **A declared attribute-tag value carries its type at the call site.** Each
  concrete singular occurrence is emitted as `((value) satisfies
  NonNullable<Parameters<typeof Callee>[0]["name"]>)`, so `mx-tsc` and the
  tsserver plugin check it against the callee's `AttrTag`; an undeclared
  property is emitted bare. The inner parentheses are load-bearing: every
  Solid renderable is an accessor, and `satisfies` binds tighter than an
  arrow function, so `() => <>B</> satisfies T` checks the returned fragment
  against a function type and fails (TS1360). The same rule puts the check
  on each occurrence inside a conditional plan rather than around it, since
  `test ? a : undefined satisfies T` checks only `undefined`; a bodiless
  renderable carries none. `compileSolidMx` also takes an optional
  `warnings` array for core's non-fatal diagnostics. A wrong attribute
  type is reported on the attribute itself, not the tag name (a
  *missing* attribute still reports on the tag name, since there is no
  attribute text to point at) — see `solid-attr-tag-attr-offset` in
  `packages/tooling/typescript-plugin/AGENTS.md`.
- **A region receives its surrounding module imports and reports callee
  dependencies.** `compileSolidMx` seeds `ctx.importSpecifiers` from the
  parser bridge and returns `ctx.dependencies`, allowing imported callees to
  resolve their `Input` and Vite to invalidate callers. The registered
  `.solid.mx` callee reader replaces regions with `null`; declaration reading
  needs no output, and compiling them there would recurse for mutual imports.
- **A top-level `<define>` inside a region hoists to module scope, gensym'd
  like a synthesized import (decision 110b).** A region is a JSX expression
  spliced into someone else's module, so `const Row = (...) => ...;` has no
  statement position to live in — the identical wall `hoistedImports`
  already hits for a discovered tag's import. `SolidEmitter.define`
  collects each top-level `Define` node it processes into a module-level
  `function $mx_DefineN(params) { return <>...</>; }` (`hoistedDefines`,
  collected the same one-emit-pass way `collectReturnVars` already gathers
  `/var` names and the escape-import flag), gensyms its binding
  (`generatedDefineBinding` — always fresh, never the author's own name,
  since unlike an authored import there is nothing outside the region that
  could already declare it), and records the author name -> gensym mapping
  in `defineBindings` for the call site to look up. `compileSolidMx` returns
  the collected list as `CompileSolidMxResult.hoistedDefines`, and the
  parser bridge (`packages/parser/src/mx/hoist-imports.ts`'s
  `HoistedDefine`) writes each one into the surrounding module after the
  import block, the same channel and placement `hoistedImports` uses.
  **Only a *direct top-level* child of the region hoists** — `define()`
  checks the same `lazyScope` flag `/var` already uses (true once emission
  has entered a `<for>`/`<if>`/attribute-tag body/another callback scope)
  and fails with a positioned error naming the construct otherwise. Module
  scope has no per-row or per-branch scope for a nested `<define>` to close
  over, the identical §7.5-8 reasoning that already restricts `/var` to the
  top level here.
  **A hoisted `<define>` may not close over a value local to the region**
  (a signal, a prop, anything from the surrounding TypeScript function the
  region lives in) — only its own params, another top-level `<define>`'s
  gensym'd name, and the module's own imports are safe once it becomes a
  real module-scope function. Enforced by `freeJsxNames`, a hand-rolled
  scope-aware AST walk over the rendered body (JSX + TS, so
  `@mxlang/core`'s `freeIdentifiersIn` — TypeScript-only — cannot be
  reused: it silently returns an empty set on a body that fails to parse
  without the `jsx` plugin, which is exactly the undercount this check
  exists to prevent). Free identifiers not in that allowed set are a
  positioned error naming the captured identifier; the check errs toward
  over-reporting (a false "capture" the author works around by passing a
  param) over under-reporting (silently wrong code reading `undefined` at
  the hoisted function's real, module scope) — the same tradeoff
  `packages/parser/src/index.ts`'s `shadowedNames` already makes for an
  adjacent problem. `KNOWN_GLOBALS` allowlists common JS globals (`Math`,
  `console`, …, deliberately *not* DOM/browser globals, since SSR runs
  under Node/Bun first); `$mxEscape` (the escape helper's own hoisted
  import binding) is allowlisted separately, since a define body that
  escapes an interpolation references it by name before it is known to
  exist as an import.
  **On Solid, a `<define>` call is a plain function-call expression, not a
  JSX tag.** Every other `Component` target prints an ordinary `<Tag
  .../>` element; JSX has no positional-call syntax, so
  `SolidEmitter.#defineComponent` instead emits `{$mx_DefineRowN(...)}` —
  the same call shape `@mxlang/html`'s `<define>` already uses (decision
  109). Args fill the declared params positionally; any params beyond the
  args are filled by name from attrs/attribute tags/`content`
  (`undefined` where nothing supplies one), mirroring html's own
  named-lookup scheme exactly, so all four of decision 109's call shapes
  (no args; args; attribute tags; args plus content and attribute tags)
  work identically. A spread is rejected the same way html rejects it — a
  `<define>` is called positionally, so a spread's keys are only known at
  run time. One difference from html's `content`/attribute-tag values is
  load-bearing: **Solid's own attribute-tag convention (an accessor,
  `() => JSX`) still applies to a `<define>` call's named-lookup values**,
  since they are resolved through the same `attributeTagProp`/`content`
  machinery every other Solid call uses — a `<define>` param filled that
  way is a function the define's own body must call (`${head()}`, not
  `${head}`), unlike html's plain-value convention. `/var` on a
  `<define>` call binds the call's own return value directly (there is no
  Solid-only callback-prop channel for a plain function call the way a
  JSX component call has); it is otherwise still refused inside
  `<for>`/`<if>` (§7.5-8), unchanged from every other `Component` target.
  **Three round-2 review fixes, worth knowing before touching any of this:**
  - **`compileSolidUnit` must never see `hoistedDefines`/`defineBindings`
    populated.** `collectReturnVars` takes an `allowHoist` parameter
    (default `true`); `compileSolidUnit`'s own call passes `false`, which
    keeps both `null` so `SolidEmitter.define`'s `fail()` branch still
    fires. A tag *unit* is a whole file, not a region — nothing there
    reads `hoistedDefines`, so without this gate a `<define>` compiled
    clean but silently emitted a call to a function nothing declares (a
    runtime `ReferenceError`, decision 110b's "positioned error, not
    wrong code" violated silently). Sharing the module-scope collector
    variables between both callers, with no per-caller gate, was the bug.
  - **A gensym is unique only *within its own region*.** Two regions in
    one file each declaring `<define/Row>` independently mint the
    identical `$mx_DefineRow1` — a host compiling one region has no
    visibility of another's choices. `packages/parser/src/index.ts`'s
    `hoistRegionImports` now runs a collision pass across every region's
    `HoistedDefine` entries after collecting them (paired with the
    region range each came from, via `defineRange`), renaming every
    binding but the first occurrence against a pool seeded with every
    name the module already uses (`moduleBindingNames`) — both the
    declaration (an AST rename: each define is parsed up front, and a
    collision assigns `FunctionDeclaration.id.name` directly, rather
    than pattern-matching `entry.code` as text, which used to tie the
    rename to `SolidEmitter.define`'s exact generated shape and once
    broke silently because `$` is a regex metacharacter) and the
    reference inside that region (`renameRegionReferences`, the same
    function reused-import renaming already uses).
  - **The capture-check safe-list reads `defineBindings`' *values*, not
    its keys.** A call to a sibling define reaches `freeJsxNames` as the
    *gensym'd* binding, not the author's name — `blockExpression` already
    drove that reference through `#defineComponent`, which resolved it.
    Checking `defineBindings.has(freeName)` against the author-name keys
    therefore never matched, misreporting every such call as closing over
    a region-local value; the check reads `new
    Set(defineBindings.values())` instead.
  - **A self-recursive `<define>`, or a define referencing a sibling not
    yet declared, is not reachable through this fix's own machinery at
    all — it's a separate, pre-existing, unrelated gap.** Core's
    `lowerDefine` (`ctx.defines.set(name, params)`) registers a define's
    name only *after* lowering its own body, so `<A>` referencing itself
    or a later `<B>` never resolves as a `"define"`-kind `Component`
    target in the first place. On `@mxlang/html` that reaches the
    generic capitalized-tag guard and errors ("no matching import or
    `<define>` in scope"); on Solid it does not, because
    `solidDeclarations.isComponent` is a bare `/^[A-Z]/` test with no
    resolvability check, so it silently lowers as a plain `"name"`-kind
    `Component` and prints a JSX tag referencing a binding nothing
    declares (args dropped). Confirmed pre-existing and unrelated to
    `<define>`: the identical silent pass-through reproduces for *any*
    unresolvable capitalized tag, define or not (`<TotallyUndefined/>`
    alone). Fixing it needs a resolvability check in Solid's
    `isComponent`/`rejectComponentTag`, a broader change than hoisting
    `<define>` — filed as its own follow-up, not folded into decision
    110b.

Decision 72's subset rule removed four SolidMX constructs real Marko itself
rejects (tag params on `<if>`, tag params and attribute tags on native
elements, `<fragment>`) — see `divergences.md`'s "Deferred to MX 2" table for
each construct, Marko's exact error, and the test that used to cover it.

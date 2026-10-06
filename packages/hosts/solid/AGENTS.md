# solid — agent instructions

## Solid 2 target and pin policy

The Solid host targets **Solid 2 only** — no Solid 1 lowering table, no dual target. Pins: `solid-js`, `@solidjs/web`, `@solidjs/babel-plugin`, `@solidjs/compiler` all at `2.0.0-rc.7`. `babel-preset-solid` and `vite-plugin-solid` are dead ends (renamed upstream).

Solid 2 is pre-stable and RCs ship weekly. Policy: **pin one RC and stay on it**; re-sync the research note on each bump we choose to take, and do not chase every RC. See `README.md` "Solid 2 RC policy".

Consequences encoded in the lowering table: `Index`/`Key`/`mxRange` are gone (one `For` with a `keyed` prop, plus `Repeat`); `classList` is gone (one `class` prop taking a string, object, or recursive array); `on:`/`oncapture:`/`attr:`/`bool:`/`use:` are parse errors with fix-it hints (only `prop:` survives); `<try>` lowers to `Errored`/`Loading`. Both compilers auto-import the builtIns (`For Show Switch Match Loading Reveal Portal Repeat Dynamic Errored`), and escaped block values additionally request `@solidjs/web`'s public `escape` helper through the region's hoisted-import channel. **That auto-import is Solid's own compiler stage** (`@solidjs/vite-plugin`'s native or Babel compiler), which never runs inside the type-check projection — see `packages/tooling/typescript-plugin/AGENTS.md`'s note on `appendSolidBuiltinImport` (`src/typecheck-module.ts`, this file kind's `completeTypecheckModule`), which supplies the same names there so `tsc`/tsserver can resolve them too.

Event props emitted by this host (`onClick=`, `on-dblclick=`, …) are looked up in `@solidjs/web`'s own declared `jsx.d.ts` spelling (`event-names.ts`'s vendored `SOLID_EVENT_PROP_NAMES`, drift-tested against the installed package), not recomposed by capitalizing only the DOM name's first letter — 97 of the 143 declared names differ from `onDblclick`-style capitalize-first (`onDblClick`, `onKeyDown`, …). Solid's runtime lowercases whatever follows `on` regardless of casing (`prop.slice(2).toLowerCase()`), so this is a typing-only change: it can never bind a different DOM event, only satisfy or fail `jsx.d.ts`'s exact prop-name keys.

## `@mxlang/solid`: the Solid host on `@mxlang/core`

`packages/hosts/solid` (`@mxlang/solid`, decisions 69, 71, 72, 79, 81) is the
third emitter over the core IR — Solid's `.solid.mx` becomes Solid JSX
text instead of a string or Astro template. `packages/hosts/solid/README.md`
carries the full lowering table (IR kind to Solid JSX), the error list, and
the `.solid.mx` bridge paragraph; the summary here is the package-map entry.

Three facts worth knowing before touching it:

- **An unresolved capitalized tag is Marko's own compile error (decision
  114), and `isComponent` is where that's decided.** `solidDeclarations`
  (`emitter.ts`) declares `isComponent(name, ctx) => (ctx.imports?.has(name)
  ?? false) || SOLID_BUILTIN_TAG_NAMES.has(name)` — genuine resolvability,
  not the bare `/^[A-Z]/` test it used to be. Everything else capitalized
  reaches core's own unresolved-tag guard, which calls the new
  `rejectUnknownTag` hook here for Marko's exact wording (`` Unable to find
  entry point for custom tag `<Name>`. ``, verified against `@marko/compiler`
  5.42.5 / `marko@6.3.51`). Two routes feed `ctx.imports` beyond the file-local
  bindings core's own precedence order already checks first (imports,
  `<define>`, `<const>`, tag params — none of those ever reach `isComponent`
  at all): `compileSolidMx`'s `moduleBindings` option (every value the
  *surrounding* TypeScript module binds at its top level — an import or a
  top-level `const`/`function`/`class`, type-only excluded — computed by
  `@mxlang/parser`'s `programBindings`/`sourceBindings` from a
  declaration-only pre-parse with regions nulled, and passed unfiltered by
  local shadowing, since Marko's own rule is that *any* in-scope binding
  resolves a capitalized tag as a reference to it, shadowed or not); and
  `SOLID_BUILTIN_TAGS` (`@mxlang/parser`, shared with
  this package's `appendSolidBuiltinImport`) — `Show`, `For`,
  `Switch`, `Match`, `Repeat`, `Errored`, `Loading`, `Dynamic`, which
  `@solidjs/vite-plugin`'s own compiler stage auto-imports and this compiler
  never runs through. Neither concept has a Marko equivalent to measure
  against (Marko has no host-native-JSX-passthrough and no
  spliced-into-someone-else's-module construct); both came from an operator
  ruling (2026-09-28) rather than a Marko fact.
  **Whole-file `.mx` resolved to Solid goes through `compileSolidUnit`, not
  `compileSolidMx` (decision 115).** `compileSolidMx` (the *region* compiler)
  still rejects every module-level statement unconditionally — a `.solid.mx`
  region is an expression spliced into someone else's module and has nowhere
  to put one — but a whole file has its own module scope, so `compileSolidUnit`
  places an authored `import` there like every other host does, and it
  resolves a capitalized tag the same way an import resolves one on
  `@mxlang/html`/`@mxlang/preact`. Before decision 115, every production entry
  point (the TypeScript plugin, the language server, `mx-tsc`, and the
  vite-plugin, which had no `host === "solid"` branch at all and silently fell
  through to `@mxlang/html`'s string emitter) routed a whole-file `.mx`
  resolved to Solid through `compileSolidMx` regardless, so an authored import
  was rejected there too, contrary to what this file used to say — this was
  the actual bug behind TODO `solid-whole-file-mx-import`, filed from PR #149.
  **`compileSolidUnit` emits the author's `export interface Input` and annotates
  the component parameter with it** (`function Card(input: Input)`), the same
  shape `@mxlang/html` and `@mxlang/preact` have, so a caller's ordinary props
  are a JSX props check: `<Card title=1/>` against `title: string` is TS2322
  through the TypeScript plugin, `mx-tsc` and an editor (TODO
  `solid-whole-file-prop-typing`; tests in `packages/tooling/tsc/src/index.test.ts`
  and `packages/tooling/typescript-plugin/src/index.test.ts`). A component with
  no `Input` gets an empty one; a unit that declares `<return>` widens the
  parameter with the `$mxReturn` callback prop so a caller's `/var` type-checks
  as a declared prop — but only as `any` (TODO `tag-var-type-from-return`; see
  the bullet below), not the `<return>` expression's real type;
  an `AttrTag` in `Input` gets its `import type { AttrTag } from "@mxlang/solid"`.
  **The output is therefore TSX carrying types, so every runtime consumer needs
  a TypeScript-aware step.** The vite path has it: `@mxlang/vite-plugin` gives a
  whole-file unit a `.tsx` id, `@solidjs/compiler` *parses* TypeScript and passes
  the types through (it does not strip them), and vite's own transform erases
  them (`examples/counter-app/e2e/whole-file.spec.ts` builds and renders one).
  An earlier version dropped `Input` on the belief that Solid's compiler has no
  TypeScript frontend; that was wrong. AttrTag props are additionally checked
  through a `satisfies` assertion at the call site (decisions 106-108).
- **Every expression value is recorded as a mapping (`mappedExpr`), and a
  whole-file unit maps its module statements too** (TODO `solid-mx-tsc-silent`).
  `descriptor.mappings` is `"merge-recorded"`: the TypeScript plugin does not
  re-lower a Solid file, so what the emitter does not record is unmapped and a
  TypeScript error on it is dropped. Before this, a whole-file `.mx` resolved to
  Solid recorded none, and `mx-tsc` printed nothing (exit 0) for an undeclared
  name, a prop type error or a `${}` error. Component and native attribute
  values, spreads, class merges, `${}`/`$!{}` text, `<if>`/`<for of>`/`<for in>`
  heads and attribute-tag spreads/conditions go through `mappedExpr` (per-atom
  for an atom, decision 156); `compileSolidUnit` maps imports, `static` blocks
  and `Input` with `mappedStatement`. A value Solid rewrites maps what
  survives: a `<for>` accessor read (`i` to `i()`, `row` to `row()`, a for-in
  key to `mxEntry()[0]`) maps its unchanged runs one to one and the replaced
  name as a whole (`Expr.unrewrittenCode`, `mappedExpr`), and a method
  attribute maps its `{ … }` body when the printer kept the authored text
  (`Expr.bodySpan`); a mapping over different text shifts positions, so the
  inserted text stays unmapped. The dynamic tag's own expression is mapped,
  and a `<for in={ … }>` object-literal source no longer gets a `?? {}`
  (TS2869). The whole-file virtual code also gets the file kind's
  `completeTypecheckModule` (`compileMxVirtual`), so `<For>`/`<Show>`/
  `<Dynamic>` resolve and a row's type is known. Known unmapped: the `<for
  from= to= step=>` range arithmetic, attribute-tag `<for>` sources, a method
  body the printer reformatted (`{ go() }` prints as `{ go(); }`), a method's
  rewritten head, a `<textarea>` spread wrapped in `__mxOmit`, and a dynamic
  tag's call arguments. Pinned by
  `expression-mappings.test.ts` and `packages/tooling/tsc/src/expression-values-solid-typecheck.test.ts`.
- **`/var` binds `any` on this host, unlike html/preact/react/hono** (TODO
  `tag-var-type-from-return`, filed from PR #159 round 2; firstmate's ruling
  2026-09-28: option C). Every JSX host but this one binds `/var` with
  `const n = temp.value;`, so TypeScript infers `n`'s real type from the
  callee's own return signature for free. Solid's `/var` is assigned inside
  a `$mxReturn={($mxV) => { n = $mxV; }}` callback prop instead (§2.4's
  design; the callback is what lets a Solid component's return value stay
  its view rather than a destructured pair) — TypeScript's control-flow
  analysis has nothing to narrow `n`'s declaration from, since the
  assignment happens inside a callback invoked at some later,
  statically-unprovable point, not directly at the declaration. Measured:
  inferring the real type without changing the emitted runtime JS is not
  possible — `typeof` only accepts an identifier, never an arbitrary
  expression, and the `<return>` expression can depend on the unit's own
  body locals, so no type-only declaration beside the component can name it
  either. Both emission sites (`@mxlang/parser`'s `hoistRegionImports` for a
  `.solid.mx` region, `compileSolidUnit` above for a whole-file unit)
  therefore declare the binding `let n: any;` explicitly — not a bare
  `let n;`, which would additionally report `noImplicitAny`'s own TS7005 on
  every read. A misuse of the bound value type-checks clean today; pinned by
  a regression test on each path (`packages/parser/src/mx/hoist-imports.test.ts`,
  `packages/tooling/typescript-plugin/src/index.test.ts`), named so a future
  fix flips the assertion.
- **It is an `Emitter<string>`, same shape as `@mxlang/astro`'s
  `.astro.mx` emitter**: `IfChain` becomes `<Show>` (≤2 conditioned branches) or
  `<Switch>/<Match>` (3+); `For` becomes `<For each keyed>` (`of=`/`in=`) or
  `<Repeat count from>` (`from=`/`to=`/`until=`, with `step` folded into a
  per-row callback when present); `<try>` is a `DelegatedTag` (`isDelegatedTag`/
  `resolveDelegatedTag`) lowering to `<Loading>`/`<Errored>`.

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

- **Decisions 109 and 112 are disjoint, not in conflict (lead ruling,
  2026-09-28): 109 governs a function/component target with arguments; 112
  governs only a string (native-element) target.** For a string target
  called with arguments, `args[0]` (Marko's own `args[0] || {}`,
  `runtime-tags/src/html/dynamic-tag.ts`'s `_dynamic_tag`) becomes the
  element's attributes *instead of* this call's attribute-tag props,
  matching html's `renderDynamic` and the shared JSX `mxDynamic` — content
  still renders regardless, since Marko threads it independently of the
  input. A function/component target is unaffected: the next bullet's
  orthogonality (decision 109's own implementation note, measured against
  Solid 2.0.0-rc.7) still holds there, and `tags` (`attributeTagProps`)
  still applies unconditionally for that branch. Which rule applies is a
  run-time fact (the resolved target's type), so `#dynamicComponent` emits
  two `<Dynamic>` branches behind its existing `typeof` guard rather than
  one conditional attribute list. See spec §15 item 11 for the full detail.
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
  `function __mx_DefineN(params) { return <>...</>; }` (`hoistedDefines`,
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
  `SolidEmitter.#defineComponent` instead emits `{__mx_DefineRowN(...)}` —
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
    identical `__mx_DefineRow1` — a host compiling one region has no
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
    yet declared, was a separate, pre-existing gap — now fixed by decision
    114, not by this fix.** Core's `lowerDefine` (`ctx.defines.set(name,
    params)`) registers a define's name only *after* lowering its own body,
    so `<A>` referencing itself or a later `<B>` never resolves as a
    `"define"`-kind `Component` target in the first place. On
    `@mxlang/html` that already reached the generic capitalized-tag guard
    and errored ("no matching import or `<define>` in scope"); on Solid it
    used to silently lower as a plain `"name"`-kind `Component` and print a
    JSX tag referencing a binding nothing declares (args dropped), because
    `solidDeclarations.isComponent` was a bare `/^[A-Z]/` test with no
    resolvability check — the identical silent pass-through reproduced for
    *any* unresolvable capitalized tag, define or not. Decision 114
    tightened `isComponent` to genuine resolvability (an in-scope module
    value, a Solid JSX built-in, or nothing) as its own, separate fix; this
    self-recursive case now reaches Marko's own error
    (`` Unable to find entry point for custom tag `<A>`. ``) as a side
    effect, not something `<define>` hoisting itself changed.

Decision 72's subset rule removed four Solid constructs real Marko itself
rejects (tag params on `<if>`, tag params and attribute tags on native
elements, `<fragment>`) — see `divergences.md`'s "Deferred to MX 2" table for
each construct, Marko's exact error, and the test that used to cover it.

### The body channel (`input.content`)

A tag unit that reads `input.content` gets `input` as a `merge` view over its props whose `content` is the body (`props.content ?? props.children`), resolved through a `children()` memo; a unit that never reads the body is emitted unchanged. Pinned by `src/body-content.test.ts`.

- **Evaluated once.** The memo resolves the body once. When `<if=input.content>` is a unit's only use of the body, the body is therefore still evaluated (its nodes created) once, even if the branch is not taken. That is inherent to `children()`; a purely lazy check would need a separate "body present" marker that JSX children do not carry.
- **Empty body.** `<if=input.content>` with a present-but-empty body (`${""}`, `${null}`, `${false}`, `${undefined}`) takes the else branch, as on the other JSX hosts (see `divergences.md`).

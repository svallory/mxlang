# @mxlang/core

## 0.1.0 (unreleased)

### Breaking: an element's `on<Name>`/`on-<exact>` attribute lowers to a new `event` attr kind

An attribute on an **element** matching `/^on[A-Z-]/` **whose value is an
expression** is now lowered to an `Attr` of kind `"event"` carrying the source
spelling (`name`), the resolved DOM event name (`event`), the handler `Expr`
and a `nameSpan` — instead of the `dynamic` prop it used to be. The
attribute-method form (`onClick() { … }`) lowers to the same kind, with an
arrow-function `Expr`.

**The value has to be an expression.** A bare `<div onClick>` is HTML's
spelling of `true` and stays a `boolean` attribute; `<button
onClick="alert(1)">` is an ordinary HTML attribute string and stays `static`.
MX does not invent a policy against inline handler strings — it only stops
*creating* one from a function. (What the html host does with such a string is
phase B's decision.) `on<Name>` lowercases everything after `on`
(`onClick` → `click`, `onDblClick` → `dblclick`); `on-<exact>` is verbatim
(`on-my-event` → `my-event`). The rule is Marko's own, so an MX template and
the equivalent Marko template bind the same event, and every host now
recomposes its own spelling from one resolved name rather than re-deriving it.

**Why it is breaking for hosts:** `Attr` is a discriminated union every
emitter switches on, so a host that does not handle `"event"` no longer
type-checks. That is deliberate — the core's rule is that a host which cannot
express a kind must say so, never silently drop it. In this release every
in-tree host handles the kind with a **temporary passthrough**, so output is
unchanged on every host and oracle; each host's real emission (and its
rejections) follows in phase B.

Reproducing the old output means reproducing *which branch* the old `dynamic`
path took, not merely its most common one. On Angular that is visible: base
matched `on<Name>` against its own `EVENT_NAME` (`/^on[A-Z]/`) and routed it
through `IRREGULAR_EVENTS`/`domEventName`, while `on-<exact>` never matched
that regex (a dash is not a capital) and fell through to a plain `[name]=`
binding — so `on-my-event=f` emitted `[on-my-event]="f"`, and the passthrough
emits exactly that. The passthrough therefore keeps reading `attr.name`, not
the new `attr.event`: the two disagree precisely for `onDoubleClick`
(`dblclick` from Angular's table, `doubleclick` from core). Phase B switches
every host to `attr.event` and deletes `IRREGULAR_EVENTS`.

**Only on an element.** On a component call, a `<define>` call, a custom tag, a
host tag (`<try onClick=…>`) or an attribute tag, an `on*` attribute stays a
`dynamic` prop, because it is the callee's own prop contract rather than a DOM
event.

**Behaviour change for authors:** MX has no aliases. `onDoubleClick` lowers to
`doubleclick`, a nonexistent DOM event, and core raises a **non-rewriting**
warning positioned at the attribute name (`` `onDoubleClick` is not a DOM
event; did you mean `onDblclick` ``). Checked against `lib.dom.d.ts`, only
`onDoubleClick`, `onDragExit` and `onEncrypted` are affected; every other React
camelCase spelling already lowercases to the real DOM name. A template relying
on Preact's case-preserving custom events (`onMyEvent` → `MyEvent`) changes
meaning — it now lowercases to `myevent`, and the author must write
`on-MyEvent`.

`on:*` and `oncapture:*` are unchanged: core gives them no meaning and they
reach the host through the existing modifier hook.

### Phase B: hosts emit from the `event` kind (decision 101)

The phase-A passthroughs are replaced by each host's ruled emission,
recomposed from the one source of truth (`attr.event`, the DOM name):

- **Solid and the Preact/hono targets** emit `on` plus the capitalized DOM
  name — `click` → `onClick`, `dblclick` → `onDblclick` (capitalize-first) —
  so `onDblClick` and `on-dblclick` produce byte-identical output, and those
  runtimes lowercase the prop at bind time. **React is a lookup, not a
  derivation:** its prop names are camelCase data from react-dom's own
  registration table (`simpleEventPluginEvents`), which no rule can reverse
  (`keydown` → `onKeyDown`, `timeupdate` → `onTimeUpdate`), so the React
  target vendors the list plus the registrations outside it
  (`buildReactEventPropNames` in `packages/hosts/react/src/target.ts`,
  react-dom 19.3.0) and a drift test compares it against the installed
  react-dom. A custom DOM event a JSX
  prop cannot spell (`on-my-event`) is a uniform positioned error on all
  three naming the `ref` route, even though Preact alone could carry it.
- **Angular** emits `(${attr.event})="(handler)($event)"` for both
  `on<Name>` and `on-<exact>` — custom events bind verbatim — and maps a
  lowercase expression `onclick=fn` to `(click)`. The host's invented
  `IRREGULAR_EVENTS` table is deleted; `onDoubleClick` now emits
  `(doubleclick)` under core's warning, never a rewrite. Component `on*`
  attributes stay ordinary `[prop]` inputs (no `@Output()` inference).
- **html and astro** reject an expression-valued event attribute: an event
  handler requires a runtime, and both targets render once to a string /
  static markup. Previously html silently emitted dead inline JS. A
  *string*-valued `onclick="…"` stays an ordinary static attribute on every
  host — MX does not invent a policy against inline handler strings.
- **`on:`/`oncapture:`** are rejected on every host with a per-prefix fix-it
  naming `on-<exact>` (replacing the shared JSX emitter's wrong class-shaped
  hint and html's nonsense object suggestion).

`on-` with no event name after the dash is a positioned error (`` `on-` needs
an event name (`on-<event>`) ``) rather than a silently empty event name.

### `discoverProjectTags` reports host-module files under `tags/` as a diagnostic instead of throwing

`indexDirectory` (and therefore `scanCustomTags` and `discoverProjectTags`) now reports host-module files under `tags/` (like `.ng.mx` or `.solid.mx`) as a scan diagnostic rather than throwing, allowing the rest of the project's tags to be successfully discovered.

`indexDirectory` (shared by `scanCustomTags` and `discoverProjectTags`) used
to reject only `.solid.mx` under `tags/`; a `.ng.mx` file (the Angular host's
per-region file kind) was indexed as an ordinary tag instead, since it does
end with `.mx`. Both are now recognized as host module files — a different
file kind, not a tag template — via a small allowlist of host segments
(`solid`, `ng`), and rejected with the same generic, positioned message:
`` `<name>` is a host module file, not a tag template; tag templates are
`.mx` ``. The allowlist is deliberately closed rather than "any second dotted
segment before `.mx`", since `TAG_NAME_RE` allows dots in an ordinary tag
name and `tags/my.icon.mx` is meant to stay the valid tag `<my.icon>`. `.amx`
is unaffected either way — it carries no `.mx` suffix and is silently ignored
under `tags/`, as before.

### Breaking: a bare `${expr}` line is a dynamic tag, not a text placeholder

A standalone concise-position `${expr}` line (no attributes, no body) used to
lower to an escaped `Interpolation` whenever no host claimed `DYNAMIC_TAG`.
It now lowers the same way the tagged `<${expr} .../>` form does: a claiming
host still gets a `HostTag` (`shape: "bare"`), and an unclaiming host gets a
`Component` with `target: { kind: "dynamic", expr }` instead of a silent
interpolation — matching real Marko, which parses both shapes to the
identical `MarkoTag` node and treats an expression-named tag as a dynamic
tag (see Marko's own `error-dynamic-tag-name` fixture). Previously, lowering
a bare, unclaimed dynamic tag with attributes or a body threw `"dynamic tag
name is not supported in a standalone template"`; that error is gone — every
host now either claims the tag or emits a dynamic component. Text on its own
line still needs the escape hatch, `-- ${expr}`; a placeholder inside an
HTML-syntax body (`<div>${expr}</div>`) is unaffected, since it parses as
`MarkoPlaceholder` and never reaches this code path. See `divergences.md`
and `AGENTS.md`'s "four Marko facts" for the full history.

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

### `printExpression` is now a public export

`printExpression(node: Node): string` — printing a Marko-owned expression
node back to source text with the same Babel generator instance that parsed
it (`@marko/compiler/internal/babel`'s `generator`, concise mode) — was
module-private to `compile.ts`. It is now exported from `@mxlang/core`'s
public entry, so a host no longer has to carry its own copy over a
different Babel instance's generator to get the same result. Additive: no
existing export changed shape, and `newCtx`'s `generate` parameter is
unchanged — a caller still passes it explicitly. `@mxlang/solid` switched
its two `newCtx` call sites from its own `generateExpression` (over
`@babel/generator`) to this export and dropped that dependency; no output
change — `@babel/generator` and Marko's bundled generator were verified
byte-identical across the node kinds `.solid.mx` compiles through this
path.

### `Define`/`For` gain file-absolute name and param spans

`Define.nameSpan?: SourceSpan`, `Define.paramSpans?: Array<SourceSpan |
undefined>`, and `For.paramSpans?: Array<SourceSpan | undefined>` extend
C4's span convention to `<define>`'s own name and params and a `<for>`'s
params — the file-absolute byte offsets every other source-derived IR run
already carried, filled at `lowerDefine`/`lowerFor` and `undefined` only for
a param or name node with no authored `loc`. Additive: no existing field
changed shape, no emitter change required.

### `mx.tags[].hosts` now filters discovery

`getCustomTags`/`scanCached`/`scanCustomTags` accept an optional `host` in
their options (`"html"`, `"astro"`, `"solid"`, `"preact"`, `"react"`,
`"hono"`, `"angular"`). A `DiscoveredTag` now carries `hosts` from the
`mx.tags` entry that declared it, and a tag whose `hosts` excludes the
passed-in `host` is left out of both `ScanResult.tags` and `customTags`
entirely. No `hosts` on the entry (or no `mx.tags` entry at all, as with
every local `tags/` directory) means visible to every host. Every built-in
integration now passes its own host name when it scans.

`@mxlang/preact`'s `export { getCustomTags } from "@mxlang/core"` is a
passthrough for `@mxlang/react` and `@mxlang/hono`'s Bun loaders to call with
*their own* host name (`"react"`, `"hono"`) — it is not itself a call site
and stays unhosted by design, the same as importing `getCustomTags` directly
from `@mxlang/core`. `mx-tsc` is covered transitively: it runs the same
language plugin as the tsserver plugin (`@mxlang/typescript-plugin`), whose
`mx-language.ts`/`language.ts`/`amx-language.ts` call sites already resolve
and pass a host (see above).

### `discoverProjectTags`: project-wide tag enumeration

`discoverProjectTags(projectDir, options?)` enumerates every tag reachable
inside a project — every `tags/` directory found walking down from the
root, plus the root `package.json`'s `mx.tags` entries — the counterpart to
`scanCustomTags`'s single-file upward walk. Excludes `node_modules`,
dotdirectories, and nested packages. Accepts the same `host` filter.

The walk follows symlinked directories (a symlinked `tags/` directory is
discovered, and any directory reached only through a symlink is walked into
normally), guarded against symlink cycles so a self-referential link cannot
recurse forever.

### Tolerant, cached `package.json` reads

A broken `package.json` no longer silently drops `mx.tags`: the previous
good manifest stays in force, and one positioned diagnostic is reported per
broken revision (not per scan). Manifest reads are now cached by path and
mtime.

### TypeScript 6.0.3, and `typescript` as a peer dependency

The repo builds and typechecks on `typescript@6.0.3` (from `5.9.3`).

`@mxlang/tsc` and `@mxlang/typescript-plugin` now declare
`peerDependencies.typescript: ">=5.9.0 <7"` instead of an exact pin. TypeScript
must come from the consumer's project: the TS plugin is handed the `ts` object by
tsserver and `mx-tsc` passes `require('typescript')` to Volar's `runTsc`, so a
second nested copy breaks `instanceof` across that boundary. Both keep an exact
`devDependencies.typescript` so CI stays pinned.

`@mxlang/language-server` declares no `typescript` peer. It has no reference to
`typescript` in its source at all — TypeScript is only its build tool, emitting
`dist/*.d.ts` — so it keeps an exact `devDependencies.typescript` and nothing
else, rather than making consumers resolve a module it never loads.

The bump itself needed one source change: `packages/hosts/angular`'s
`tsconfig.build.json` now sets `rootDir: "src"` explicitly. TS 6 no longer
infers a common source directory when a build config and its base config
disagree about it (`TS5011`). No other package was affected, no deprecation
warning was reported anywhere in the build, typecheck, test or oracle runs, and
emitted `.d.ts` output is unchanged. The full TS 6 findings — and what they do
and do not imply for TS 7 — are in `notes/investigations/ts7-go-impact.md` §7.

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

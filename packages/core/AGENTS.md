# core — agent instructions

## `@mxlang/core`: the Marko-node consumer

`packages/core` (`@mxlang/core`, decisions 70 to 72, 79) is the half every MX
host shares: it consumes Marko's AST through `@marko/compiler`, applies the
structural lowerings (`<if>`/`<else>`, every `<for>` form, `<define>`,
`<const>`, statement tags, the field and inert-shape guards) and **resolves
them into a host-independent IR** (decision 79). A host then *emits* from that
IR and never walks a Marko node. `packages/core/README.md` documents the IR
kinds, what a host implements in order, the hooks and the front doors — read it
before adding either.

The three pieces: `src/ir.ts` (the node kinds, a position on every one),
`src/lower.ts` (Marko AST in, `Ir` out, carrying every validation and every
error message the emitting walk had), and `src/emit.ts` (`Emitter<Out>`, one
method per kind, plus the `drive`/`emit` driver). `src/declarations.ts` holds
`HostDeclarations` — the questions the lowerer asks — and `Policy` remains a
compatibility alias of `HostDeclarations` only. `HostOptions.emitIr` is
required: there is no pre-IR string-walk fallback.

Both current hosts are on the driver. `@mxlang/html` uses
`packages/targets/html/src/emitter.ts` for vanilla HTML strings;
`@mxlang/astro` uses `packages/hosts/astro/src/astro-template.ts` for `.astro.mx`'s
expression-shaped Astro syntax. Neither emitter reads a Marko node; a
host-specific resolve-time decision goes in `DelegatedTag.data` through
`isDelegatedTag`/`resolveDelegatedTag` (decision 132 renamed these from `claimsTag`/`resolveHostTag`; `HostTag` is now `DelegatedTag`).

Five facts worth knowing before editing it:

- **Attribute-tag IR has three synchronized views (decisions 106–108).**
  `Component` and a dynamic `DelegatedTag` keep `attributeTags`, the flat
  source-order occurrence list used by existing emitters and tooling; add
  `attributeTagTree` to preserve nested `<if>`/`<for>` structure; and resolve
  `attrTagProps`, the cardinality/shape emission plan. `AttributeTag` carries
  the same three fields recursively, plus its own lowered `attrs` and
  `hasBody`. A host declaring `attrTags: 2` emits from `attrTagProps` only and
  does not regroup the flat list or resolve declarations itself. Until a host
  declares that capability, core positions an error on every construct whose
  v2 shape could otherwise be silently dropped.
  For an untyped, unresolved or dynamic callee, the fallback plan uses
  `renderable` when every occurrence of that property is body-only; one
  occurrence with attributes or nested tags makes the whole property `data`.
  Cardinality is still derived independently from paths and loops. A declared
  `Input` remains authoritative and defaults to `data` (decision 108).
  A claimed dynamic `DelegatedTag` also retains its tag arguments in `args`; an
  emitter must forward them when it reconstructs a `Component` call. For a
  named custom tag, Marko's own call shapes are exclusive: arguments cannot
  also come with attributes, attribute tags, or body content
  (`assertAttributesOrSingleArg`), and core rejects that combination with
  Marko's positioned diagnostic before a host could silently discard the
  property/body side of the call. A dynamic `<${expr}>` tag and a `<define>`
  call are different in real Marko, and MX now matches it (decision 109): both
  compile through the lenient dynamic-tag visitor (`assertAttributesOrArgs`),
  which allows arguments together with a body or attribute tag (Marko's
  "dynamic tag fallback content") and only rejects arguments plus a plain
  attribute. `rejectArgsWithProps` takes this lenient rule for `target.kind`
  `"dynamic"`/`"define"` (or no target — the dynamic-tag call site before a
  `DelegatedTag`/`Component` split) and the strict rule only for `"name"`. The
  trailing shape a host emits is `callee(...args, { content, <attribute
  tags> })` — Marko's own, confirmed against `@marko/compiler`/`marko`
  6.3.51's translator and runtime: the props object is appended once,
  after every positional arg, only when there is content or an attribute
  tag to carry. **A `<define>` call is not literally Marko's shape**: Marko
  itself has no declared `Input` to destructure that single trailing object
  against for a `<define>`, and measured against real Marko 6.3.51 its own
  codegen for `<Card('a')><@head>H</@head></Card>` binds the *whole* trailing
  object to whichever param follows the positional args, not the attribute
  tag's value — silently dropping the content Marko's own comment calls
  "fallback content". MX's `<define>` emitters (html, the shared preact/
  react/hono emitter) instead extend their own pre-existing positional
  named-lookup scheme (args path only; a no-args call passes one attribute
  object, decision 160): params beyond the
  consumed args are filled from the same named lookup, one value per param.
  Solid needed no emitter change for the dynamic-tag case — its design
  already keeps attrs/attribute-tags/content orthogonal from args (args only
  resolve the value handed to `<Dynamic component=…>`; attrs/tags/content
  render on that element regardless), so core's relaxed guard alone was
  sufficient. A `<define>`-bound call target is a separate, pre-existing gap
  on Solid, unrelated to this decision: `<define>` itself unconditionally
  errors inside a `.solid.mx` region ("cannot declare a function inside a
  JSX expression"), so `ctx.defines` is never populated there and
  `target.kind === "define"` is unreachable on Solid regardless of args —
  not something this decision's scope changes or could fix without first
  making `<define>` itself work on this host.
  Angular (`ngComponentOutlet` binds `@Input()`s only, not positional
  constructor arguments) and Astro (no local component form at all) keep
  their own positioned errors, unrelated to and unaffected by this change.

- **Marko's parse layer is loaded in one place, `src/marko-frontend.ts`, and
  bundled into the dist (decision 159).** `markoCompiler()`, `markoBabel()`
  and `markoHtmljsParser()` (all public) are the only way core, the hosts,
  data and the tools reach `@marko/compiler`, its Babel or its parser: never
  `require("@marko/compiler...")` elsewhere, or a second compiler instance
  loads (separate taglib caches, compile state and Babel nodes). From source
  they resolve the workspace's `@marko/compiler` (patched npm `htmljs-parser`).
  In the dist, `build/frontend.ts` bundles `@marko/compiler` into
  `dist/marko-frontend.cjs` with `htmljs-parser` resolved to
  `packages/parser/src/template/`, and the main build defines
  `MX_MARKO_FRONTEND` so the loader requires that file; `@marko/compiler` and
  `htmljs-parser` are devDependencies only. The build fails if the bundle
  requires any package, carries an npm `htmljs-parser`, or `dist/index.js`
  imports either specifier statically. The bundle stubs Babel's
  `browserslist` (no config file found: MX passes no targets) and leaves out
  `@babel/preset-typescript` (only for a `.cts` Babel config file). A bundle
  that inlines core's dist (the VSIX builds) gets `marko-frontend.cjs` copied
  beside it by `scripts/bundled-build.ts`. Deleted with the switch to the MX
  AST (decision 158).
- **Its JS parsers are Marko's own Babel (`markoBabel()`) and `@babel/parser`.**
  `core.ts` used to parse
  an `import` line with `@mxlang/parser` — the *Solid parser* package — for a
  single `parse` call. It now asks `@marko/compiler/internal/babel`
  (`parse`/`parseExpression`/`traverse`/`types`, all present), which is also
  the instance Marko's own nodes belong to. Do not reintroduce a second Babel.
  **`printExpression(node): string`** (`compile.ts`, public from `@mxlang/core`)
  is the one function that prints a Marko-owned expression node back to source
  text, with that same generator instance — it is what `compileSource`'s
  `translate` visitor hands `newCtx` as its `generate` argument, and every
  host printing an expression back to text should call this rather than
  reaching for its own Babel generator. `@mxlang/solid` used to carry its own
  copy (`generateExpression`, over `@babel/generator` — a different Babel
  instance from the one that parsed the node) before switching to this
  export.
- **`callee-input.ts` is the synchronous, syntactic cross-file reader for a
  component's `Input`** (decisions 106 and 107). It resolves discovered and
  imported callees, parses complete TS/TSX modules with `@babel/parser`'s
  `typescript` + `jsx` plugins, and reaches `.mx` declarations through the
  existing template-metadata compile/cache. It follows only bounded literal
  aliases, re-exports, and `import type` edges. Every followed file has its own
  declaration/import/`AttrTag` scope; never merge names across files. Spans
  carry the declaring file and use offsets into that file, including `.mx`
  Input slices. The resolver records files and missing extension candidates in
  `CompileResult.dependencies`, and caches by path plus snapshots of every
  dependency; calls with a tool resolver skip the shared cache. `readOwnInput`
  reads the current unit before its template metadata is complete, while a
  pending cross-file metadata entry remains unknown and is not cached. Keep this
  path synchronous: Bun loaders, Volar, diagnostics, and `mx-tsc` cannot await
  it. Do not replace full TSX parsing with declaration text extraction, and do
  not add a `core -> @mxlang/parser` dependency: parser's Solid test path
  reaches `@mxlang/solid`, which already depends on core.
  **An editor-only callee (not yet on disk) still resolves and still reports a
  dependency (phase 4 tooling fix).** `probeFile` now also checks the active
  `withCalleeInputSources` override map for each candidate path, so an unsaved
  buffer for a brand-new `.mx` file resolves like a saved one; and
  `resolveTarget`'s `"unresolved"` result now carries every probed candidate
  path, which `readCalleeInput` records as a dependency even though nothing
  was read. Without this, a caller whose callee could not be read on the
  *first* compile (the callee is open but unsaved, or does not exist on disk
  yet) never got a dependency edge at all, so a later compile — even one
  handed the editor's snapshot through `withCalleeInputSources` — kept
  re-deriving the same untyped fallback shape forever, because nothing ever
  told it to retry with an override in scope. Measured through the
  typescript-plugin's source reader on a callee held only by the editor: the
  first pass reports the probed candidates, and the second pass resolves the
  callee through the override and emits the typed `satisfies` value.
  **A failed compile must still report every callee it resolved before the
  error was raised.** `compile.ts`'s `Program.exit` now saves `ctx.dependencies`
  in a `finally` around `lower()`, and `compileSource` decorates a thrown
  `TranslateError` with those dependencies before rethrowing (a new
  `TranslateError.dependencies` field). Before this, a document that failed to
  compile (e.g. "missing required attribute tag") reported **no** dependencies
  at all, because `compileSource` threw before ever returning
  `CompileResult.dependencies` — an LSP integration recording dependencies
  from a *failed* diagnosis (`readCalleeInput`'s exact case) would wipe out an
  edge a *previous, successful* diagnosis had recorded, so the next callee
  change found no caller to re-diagnose. See
  `packages/tooling/language-server/AGENTS.md`'s dependent-re-diagnosis entry
  for the integration side of this.
- **Every host implements `Emitter<Out>`**, one method per IR kind, and the
  core's `drive`/`emit` owns the walk. A host that cannot express a kind throws;
  no optional callback may silently drop it.
- **An element's `on<Name>`/`on-<exact>` is an `event` attr, and only on an
  element** (decision 101). Core lowers an attribute matching `/^on[A-Z-]/` to
  `Attr` kind `"event"`, carrying the source spelling (`name`), the resolved
  DOM event name (`event`), the handler `Expr` and a `nameSpan`: `on<Name>`
  lowercases everything after `on` (`onClick` → `click`), `on-<exact>` is
  verbatim (`on-my-event` → `my-event`). Marko's own rule, copied rather than
  re-derived. **Only for an expression value**, and so placed *after* the
  boolean/static checks in `lowerAttr`: a bare `<div onClick>` stays `boolean`
  and `<button onClick="alert(1)">` stays `static` (deriving the kind first
  rendered `<div onClick="true">` on html and `(click)="(true)($event)"` on
  Angular). `on-` with no name after the dash is a positioned error. The **`isElement` gate** is what makes it correct: `lowerAttrs`
  defaults its `on` parameter to `"element"` and a `DelegatedTag` takes that
  default, so the gate travels as a separate `isElement` boolean set only at
  the real `Element` call site — on a component call, a `<define>` call, a
  custom tag, a host tag (`<try onClick=…>`) or an attribute tag, `on*` stays a
  `dynamic` prop, because it is the callee's prop contract, not a DOM event.
  The boolean is deliberately *not* a third `on` value: `resolveModifier`,
  `rejectAttributeMethod` and `orderAttrs` all take `on` and none of them wants
  a third case. **No aliases:** `onDoubleClick` lowers to `doubleclick` and
  core warns without rewriting (`warn(ctx, …)`, positioned at the attribute
  name); core's warning table is the three React spellings whose lowercase is not a DOM
  event, verified against `lib.dom.d.ts`. `on:*`/`oncapture:*` get no meaning
  from core and reach the host through the existing modifier hook, which every
  host rejects with a per-prefix fix-it naming `on-<exact>`.
  **Phase B emission (each host recomposes from `attr.event`):** every JSX
  host looks the prop up in the handler props its own JSX types declare,
  which no derivation can reverse (`keydown` → `onKeyDown`; `dblclick` →
  Solid's and Preact's `onDblClick`, React's and hono's `onDoubleClick`), so
  `onDblClick` and `on-dblclick` are byte-identical on each. Solid's table is
  `packages/hosts/solid/src/event-names.ts`; Preact's and hono's are in
  `packages/hosts/preact/src/dialect.ts`; React's (`reactEventPropNames`) in
  `packages/hosts/react/src/dialect.ts`; each is drift-tested against the
  installed types. Preact, React and hono tables are closed
  (`JsxDialect.closedEventPropNames`): a DOM name the host's types declare no
  handler for is a positioned compile error. A custom DOM
  event a JSX prop cannot spell (`on-my-event`) is a uniform positioned error
  on solid/preact/react/hono naming the `ref` route — JSX hosts cannot express
  it, and the same source must not silently do nothing on one host. Angular
  emits `(${attr.event})="(handler)($event)"` for both forms (custom events
  bind verbatim) and maps a lowercase expression `onclick=fn` to `(click)`;
  its old `IRREGULAR_EVENTS` table is deleted — `onDoubleClick` emits
  `(doubleclick)` under the warning, never a rewrite. html and astro *reject*
  an expression-valued event attribute (no runtime; previously html emitted
  dead inline JS). Event-attribute errors are positioned at the attribute
  name — Marko's attr `loc.start` is the name start, the same offset
  `nameSpan.sourceStart` carries, so the language server underlines the name
  (pinned by position tests on solid/preact/html/astro). Everywhere, a
  *string*-valued `onclick="…"` stays an
  ordinary static attribute verbatim — MX does not invent a policy against
  inline handler strings — and an `on*` on a component stays a plain prop.
- **Three stateful-tag hooks** (decision 70), unit-tested through
  `src/lower.test.ts`: `isDelegatedTag`/`resolveDelegatedTag` (the lower-time tag
  handler), `ctx.hoist(code)` (lift a statement to the enclosing function's
  head — the render function, or the nearest `Define`), and
  `ctx.bindings.register(name, rewrite)` (rewrite identifier *references*, so a
  host whose state is a getter emits `count()` for `${count}`). Rewrites apply
  only to reference positions, and emitted-JS scopes restore shadowed names.
- **`parseFragment` is spike 1's stopgap, with measured limits.** Marko's own
  nodes carry no numeric `start`/`end` at all (only `loc.{line,column}`); the
  Babel expression nodes nested inside them carry their offset at
  `loc.*.index`; **position objects are shared between nodes**, so the walk
  dedupes them or a second visit lands at `base + base` (measured: raw index 16
  with `baseOffset: 42` came out at 100 instead of 58); a thrown parse error's
  position is on the exception, not in the tree, and is shifted separately.
  `parseFragment` also passes a **parse-only translator stub** (empty
  `translate`), because `@marko/compiler` otherwise resolves its default
  `marko/translator` before parsing and fails — the `marko` package is not a
  dependency here. Solid's own bridge
  (`packages/parser/src/mx/bridge.ts`) now calls `parseFragment` for every MX
  region it finds; see "`@mxlang/solid`: the Solid host on `@mxlang/core`"
  in `packages/hosts/solid/AGENTS.md`.
- **Programmatic custom tags lower to ordinary IR before a host emits.** Every
  host compiler accepts `customTags: Record<string, CustomTag>`; the core
  validates declared attributes and attribute tags, then calls `transform`.
  Only `parseOptions.text`/`preserveWhitespace`/`openTagOnly` cross into an
  injected Marko taglib. Marko caches injected taglibs by id, so the id must
  remain keyed by the parser-facing definitions or later compilations can
  reuse the first map. **That cache is never evicted, so the id must not be
  minted per compile.** Marko's `lookupCache` is keyed on the sorted taglib
  ids and `loadedTranslatorsTaglibs` on the translator object, and neither
  drops an entry except through `clearCaches()`; measured, 200 compiles with
  200 distinct tag sets leave 200 live ids. In a one-shot build that is
  bounded, but a long-lived language server compiling an edited file over and
  over grows without limit. **Done in P2** (`packages/core/src/scan-cache.ts`):
  the cache interns one tag-map object per tag set, so the derived id is
  stable across compiles, and evicts `taglib.clearCaches()` when the
  parser-facing set changes. The TypeScript plugin passes the
  same map to compilation and its
  second lower. `.solid.mx` carries the map across the parser boundary on the
  `mxCustomTags` parser option (`print(source, file, { customTags })`), the
  only channel the in-tokenizer bridge has to the caller.
  `bun run oracle:custom-tags` is the six-host gate; every row renders and
  compares against `expected.html`. It runs **six** fixtures — `icon` (an L2
  sidecar), `icon-template` (the same tag as an L1 template), `icon-sprite`
  (P5's collecting pair), `table-of` (L2 without that pair) and `tree` (a
  self-recursive L1 template, three levels deep) and `counter-return` (a unit
  that hands a value back with `<return>`, bound at the call site with `/var`,
  whose export shape differs per host so the rendered bytes are the gate) —
  for a 36-row count gate.
  **All 36 rows pass, with no recorded skip.** (Two skips used to
  live here and both are fixed: `table-of` on Solid was the accessor-binding
  bug — see the P5 bullet below — and `icon-template` on Solid was a discovered
  unit's import having no module scope inside a `.solid.mx` region, now hoisted
  by the parser bridge; see the bullet on that below.) A skip still runs, still
  counts, and still prints its reason, so a fixture that stopped running is
  still a failure.
- **`analyze` / `finalize` / `ctx.store` are P5 and shipped**
  (`packages/core/src/custom-tags.ts`; the contract and the worked example are
  in `packages/core/README.md`). Six invariants worth knowing before touching
  them:
  - **Order is by tag name, twice.** Per file: every `analyze`, then every
    `transform` in source order, then every `finalize`; both hook phases run
    sorted by tag name, and `finalize`'s nodes are prepended to `Ir.body` in
    that order. A `finalize` receives no other tag's output and no route to the
    program, so ordering cannot become semantically load-bearing — decision
    80's coupling, which this is the obvious back door for.
  - **A store is per file *and* per tag, keyed on the `Ctx`.** A definition
    object is a module singleton the scan hands to every file in a package, so
    keying anywhere else leaks one file's collected state into the next. The
    same map is shared by reference into a tag template's `Ctx`, which is both
    the store's scope (a template's `<icon>` joins the caller's sprite sheet)
    and the hook gate: a non-undefined `ctx.customTagStores` is how the nested
    `lower()` knows it is not the file root and runs no hooks of its own.
  - **A file containing a tag that defines `analyze` is lowered twice.** The
    first walk runs over a scratch `Ctx` (same source, declarations, lookup,
    tags, stores and filename; its own prelude, bindings, imports and
    warnings) that records each call and is then discarded — so `analyze` gets
    the identical `TagCall` its `transform` will get, while the walk's hoists
    and warnings are not emitted twice. Its suppressed-output IR is never
    cached. No registered `analyze` means one walk, exactly as before.
  - **A unit boundary is a hook boundary** (decision 95). A call written inside
    a tag template belongs to *that template's* compilation unit and is not
    replayed into the caller, so a file-level `analyze` sees only the calls its
    own file wrote — measured: a caller whose template calls `<inner/>` reports
    an empty call list for `inner`. This is the reverse of the inlined model,
    where the scratch walk expanded templates far enough to record nested calls
    and every cache entry replayed a transitive call list. A tag that must
    collect across units has to do it through its own module state, not through
    `analyze`. The cached metadata a unit exposes to its caller is
    `{ readsContent, attributeTags }` and nothing else.
  - **Only a tag the file actually calls is finalized** (`ctx.customTagsUsed`),
    and a tag with `analyze` but no calls is skipped rather than analyzed with
    an empty array. A tag declaring **only** `finalize` is rejected at
    registration, from both `compile.ts` and `fragment.ts`, beside the
    built-in-shadowing check.
  - **`table-of` on Solid was skipped and now passes.** The skip recorded a
    `<for>` body reading a *property* of its row rendering empty under SSR.
    That was the accessor-binding bug, not a custom-tag matter: `@mxlang/solid`
    now rewrites every read of a parameter Solid hands as an accessor into a
    call (`p.name` -> `p().name`), so all 24 rows of `bun run oracle:custom-tags`
    pass with no recorded skip. See `packages/hosts/solid/README.md`
    "`<for>` bodies read the row as a value, on every form".
- **`<try>` is a core-owned custom tag (spec §5 P4), not per-host code.**
  `packages/core/src/builtin-tags.ts` exports `BUILTIN_CUSTOM_TAGS`, and a
  name it lists (today, only `try`) cannot be shadowed by a registered
  `customTags` entry of the same name at either of two points: `lower.ts`'s
  custom-tag branch consults it *before* a caller's own `ctx.customTags` (the
  call-site check, for a name Marko has already agreed to parse as that tag),
  and `rejectShadowedRegistration` in `builtin-tags.ts` rejects the whole
  registration up front, from both `compile.ts` and `fragment.ts`, before any
  parsing happens. The second check exists because a shadowing registration's
  own `parseOptions` (e.g. `try: { parseOptions: { openTagOnly: true } }`)
  changes how the parser itself reads `<try>`, which would otherwise surface
  as an unrelated parser error instead of the shadow diagnostic — a name
  cannot be shadowed even by a registration whose `transform` never runs.
  Every rejection is the same positioned error, not a silent override. The
  tag's `transform` validates the shape every host used to re-derive by hand
  (no tag params, no `/var`, at most one `<@catch>`, at most one
  `<@placeholder>` with no params of its own — the first two through the
  tag's own checks, the attribute-tag shape through the tag's declared
  `attributeTags` contract) and then asks for the primitive with
  `ctx.build.delegatedTag("try", children, attributeTags)` (a fourth `attrs`
  argument carries attributes; omitted means none). `lowerCustomTag`
  passes an `isBuiltin` flag that skips the ordinary `hasContent` gate on a
  custom tag's body. Decision 141: `hasContent` tests Marko-normalized text
  for nonemptiness, never trims it again — same-line spaces/tabs are content,
  while newline indentation already removed by Marko is absent. `<try>` is
  a structural pass-through wrapper and reproduces the caller's body unchanged, matching what
  `lowerDelegatedTag` always did. Each host's `isDelegatedTag`/`resolveDelegatedTag` for
  `"try"` only decides how the primitive renders now — `@mxlang/html`,
  `@mxlang/solid`, and `@mxlang/preact`'s shared JSX emitter (reused by
  `@mxlang/react`/`@mxlang/hono`) all shrank to that. `@mxlang/astro` never
  claimed `"try"`; its rejection is an ordinary `tags["try"]` disposition
  entry (`ctx.declarations.tags`), checked earlier in `lowerTag` than any
  custom tag, so it is unrelated to this change and untouched. Error wording
  for the shape checks changed from each host's hand-written phrasing (e.g.
  "given twice") to the generic custom-tag messages (e.g. "may not be
  repeated") — a wording change, not a behavior change, so the affected host
  and Solid-bridge tests were updated to match rather than left failing. A
  tag whose `attributes` is declared empty (`{}`, `<try>`'s own case) reports
  a named or spread attribute the same way — "accepts no attributes" — rather
  than the generic checker's own internal wording ("spread attributes cannot
  be checked...") leaking into a user-facing message.
- **Custom tags are discovered, not configured** (P2, spec §4;
  `packages/core/src/{scan,scan-cache}.ts`). `getCustomTags(file)` walks
  upward from a file to the package root collecting `tags/` directories,
  indexes `x.mx` and `x.tag.ts` by basename, and extends the walk with
  `package.json#mx.tags` (a string, or entries of
  `{ dir, prefix?, hosts?, parseOptions? }` supplying directory-level defaults
  a sidecar may override). Nearest `tags/` directory wins; `mx.tags` entries
  come last, in array order. Every integration the spec lists calls it per
  compiled file — the Bun loaders, the Vite plugin, the Astro `.astro.mx` plugin,
  the TypeScript plugin, the language server, and `mx-tsc` through the same
  language plugin — because which tags a template may call follows from where
  the template lives. An explicitly passed `customTags` still wins over a
  discovered tag of the same name.
- **Package-level contracts use `mx.contracts` (decision 142).** A string,
  `{ module, hosts? }`, or array names modules default-exporting `ContractMap`
  (`Record<string, CustomTag>`): declarations plus `analyze`, no `transform`,
  `finalize`, template or prefix. Both walks share indexing after `tags/` and
  `mx.tags`; winners replace whole entries, with shadow and duplicate warnings.
  Only entries applicable to the caller's `host` compete; ineligible entries
  cannot hide unrestricted fallback contracts or produce shadow warnings.
  Modules are still validated and stamped before host filtering. Absent
  `mx.contracts` never triggers contracts-key position tokenization. A broken
  manifest warning names both `mx.tags` and `mx.contracts`: previous good
  configuration stays in force, or none is loaded until it parses.
  Modules evaluate eagerly on a scan-cache miss (their names and parser options
  must be known); file stamps retain hashes, not source, and unchanged maps
  remain interned. A failed discovery walk carries its partial file/manifest
  evidence (including the offending module) on `TranslateError.dependencies`.
  `scanCached` also retains the last complete scan's inputs on failure: an
  incomplete scan is not authoritative empty evidence. A later successful
  scan replaces those inputs normally. Config/resolution failures address the direct `"contracts"`
  key using cached manifest text; module failures and per-module registration
  errors address the module file at `1:0`. The merged-map check stays intact.
  Use the required `targets` lookup (`src/test-targets.ts` in tests), with no
  host-specific core branch. Keep modules self-contained: imported helpers
  are not tracked or evicted. Vitest reload tests prove rescan/map invalidation,
  not re-evaluation through its separate module registry (`contracts.test.ts`).
  **Under Node, an edited ESM/TS contracts module (like an ESM/TS sidecar) is
  picked up after a tool restart; Bun reloads it. CommonJS `.cjs` modules
  reload correctly on Node.** Evicting `require.cache` does not clear
  Node's ESM loader cache; this existing loader limitation is deferred to
  `sync-esm-reload-node`. The deterministic Node subprocess test pins a new
  scan-map identity with stale exports and fresh exports after restart.
- **`DiscoveredTag` carries `hosts`, and every integration's scan honors it.**
  `getCustomTags`/`scanCached`/`scanCustomTags` accept an optional `host`
  (`"html"`, `"astro"`, `"solid"`, `"preact"`, `"react"`, `"hono"`,
  `"angular"`) in their options; a tag whose `mx.tags` entry declared `hosts`
  excluding that name is left out of both `ScanResult.tags` and
  `customTags` for that scan entirely, not merely hidden from the compiled
  map — a name a different host owns must stay resolvable from *its* scan of
  the same file. No `hosts` on the entry (and every local `tags/` directory,
  which has no `mx.tags` entry to carry one) means visible to every host,
  `host` unset included. Every call site that scans passes its own host name
  — the Bun loaders (`"html"`, `"hono"`), `@mxlang/astro`'s `.astro.mx` plugin
  (`"astro"`), the Solid and whole-file `.mx` typescript-plugin paths
  (`"solid"`, resolved per file via `resolveTargetPolicy`), the language
  server (`hostPolicy.host`), the Vite plugin (`resolveTargetPolicyDetailed(file)`
  per compiled file), and the Angular build/oracle (`"angular"`) — so a
  scan's cache key (`scanCached`) now also includes the host, since two hosts
  scanning the same directory can get different filtered results.
- **`discoverProjectTags(projectDir, options?)` is the project-wide
  counterpart to `scanCustomTags`'s single-file upward walk**
  (`packages/core/src/scan.ts`). It walks every `tags/` directory reachable
  under `projectDir` (never descending into `node_modules`, a dotdirectory,
  or a nested package's own tree) plus the root `package.json`'s `mx.tags`
  entries, reusing `indexDirectory` and the manifest reader `scanCustomTags`
  uses. Directories are visited shallowest-first so a name two `tags/`
  directories both claim resolves to the one nearer the project root,
  deterministically. Accepts the same `host` filter. For tooling that needs
  the whole tag surface up front rather than per compiled file.
- **Precedence order (spec §4; ref `custom-tags-import-precedence`,
  `custom-tags-local-bindings`, decisions 93, 113):
  core structural tags, then built-in custom tags (`try`, never shadowable),
  then a *PascalCase* name the file itself binds — an `import`, a `<define>`
  name, a `<const>` binding, or a `<for>`/`<define>` tag param, each scoped to
  where the binding is in effect — then a registered custom tag, then a host
  claim (`ctx.declarations.isDelegatedTag`), then components/elements.** `lower.ts`'s
  tag-name switch checks `/^[A-Z]/.test(name) && (ctx.defines.has(name) ||
  ctx.imports.has(name) || (ctx.tagVarShadowed?.has(name) ?? false))`
  directly — a *core* rule inline in `lower.ts`, not a call into a host's own
  `isComponent` (Solid's and Astro's `isComponent` are casing-only and never
  consult `ctx.imports`/`ctx.defines`/`ctx.tagVarShadowed` at all, so there is
  no shared "file-local half" of `isComponent` to call into) — before ever
  consulting `ctx.customTags` or `isDelegatedTag`, so `import Panel from
  "./panel.mx"` in a package that also has a `tags/Panel.mx` or a registered
  `Panel` custom tag resolves to the import, not the custom tag. This was
  previously backwards (`ctx.customTags` was checked first) with no test
  covering the order.
  **The casing guard is load-bearing, not incidental**: Marko's own rule
  (matched by every host's `isComponent` — html `translate.ts`, preact
  `emitter.ts` — and by Marko's own `TAG_NAME_IDENTIFIER_REG =
  /^[A-Z][a-zA-Z0-9_$]*/`) is that a *lowercase* local variable is never
  resolved as a component call — `import panel from "./panel.mx"` then
  `<panel/>` is a parse-time Marko error ("Local variables must be in a
  dynamic tag unless they are PascalCase"), not a component reference. An
  earlier version of this fix checked `ctx.defines`/`ctx.imports` with no
  casing gate, which regressed every lowercase-named custom tag or host claim
  (e.g. `<style>`) sharing a name with an unrelated lowercase import in the
  same file — the binding existed but was never meant to route as a
  component, so it must not shadow the custom tag or host claim either.
  **`<const>`/tag-param bindings now shadow too (decision 113,
  `custom-tags-local-bindings`), closing the gap this bullet used to
  document.** `ctx.tagVarShadowed` — the scope-tracking set `shadowBindings`/
  `scopeBindings` already maintained for binding-aware identifier rewriting
  (see `expr()`'s doc comment in `core.ts`) around every `<const>`,
  `<for|p|>`, and `<define|p|>` body — gives the file-local check correct
  lexical scoping for free: a name bound inside an `<if>` branch or a `<for>`
  body shadows only there, reverting to the registered custom tag immediately
  outside it. Measured against Marko 6.3.51's own translator
  (`normalizeTag`, `@marko/runtime-tags/dist/translator/index.js:5852-5860`):
  `tag.scope.getBinding(tagName)` is checked unconditionally before any
  taglib/custom-tag lookup, for `const`, `for`-params, and `define`-params
  alike, with no divergence between the three — one code path, so MX's fix
  mirrors it with one path too rather than a per-construct special case.
  Because a host's own `isComponent` (html, preact, …) still only consults
  `ctx.imports`/`ctx.defines` and has no way to see `ctx.tagVarShadowed`, the
  component-routing check in `lower.ts` is `fileLocalBinding ||
  ctx.declarations.isComponent(name, ctx)` rather than delegating to
  `isComponent` alone — a `<const>`/tag-param binding proves it is a
  component call on its own, independent of what any host's `isComponent`
  can see.
  **Round 2 (found by review): the "reverts outside the branch" claim above
  was false until `scopeBindings` itself was fixed.** `scopeBindings`
  (`core.ts`) snapshotted only `ctx.bindings`, never `ctx.tagVarShadowed` — so
  a `<const>` written inside an `<if>`/`<else>` branch (which never calls its
  own `shadowBindings` restore, by design: it shadows for the rest of *its
  enclosing scope*) permanently replaced `ctx.tagVarShadowed`, leaking the
  shadow past the branch for the rest of the file. `<for>`- and
  `<define>`-param bindings were unaffected (their own `shadowBindings`
  restore reverts `tagVarShadowed` regardless of the enclosing
  `scopeBindings`), but `lowerDefine` itself had the identical class of bug
  independently: it called `shadowBindings` (params only) with no
  `scopeBindings` wrapper at all, so a `<const>` written *inside* a
  `<define>` body leaked past the `<define>` too. Both are now fixed at the
  root: `scopeBindings` snapshots and restores `ctx.tagVarShadowed` alongside
  `ctx.bindings`, and `lowerDefine` now wraps its body walk in `scopeBindings`
  like every other block (`lowerBlock`, `lowerFor`, the `<if>`/attribute-`<if>`
  branch handlers) already did. `<try>` needed no change — its content
  already routes through `lowerBlock`. Executed-render regression tests
  (`<const>` inside `<if>`, inside `<else>`, inside an `<if>` nested in a
  `<for>`) are in `packages/targets/html/src/translate.test.ts`; IR-level
  coverage for the same three cases is in `custom-tags.test.ts`. Preact
  cannot express a `<const>`/`<define>` nested inside `<if>`/`<for>` markup at
  all (every structural kind there lowers to an expression with no statement
  position — a pre-existing, unrelated host limitation), so it has no
  matching test; see the comment in `packages/hosts/preact/src/index.test.ts`
  for why.
- **The scan is synchronous, and that is load-bearing.** Bun's `onLoad`,
  Volar's `createVirtualCode`, `diagnoseDocument` and `mx-tsc` all call from
  positions that cannot await; only the Vite plugin could. One synchronous
  implementation is what keeps an editor, a `tsc` run and a build from
  resolving different tags for one file.
- **`parseOptions` is read without executing the sidecar**, because it must
  reach Marko before the *calling* file is parsed. It is extracted statically
  from the default export with `@marko/compiler`'s own Babel (not a second
  `@babel/parser`), and the accepted shape is narrow: an object literal, or an
  identifier bound once at module scope to one (optionally through `as` /
  `satisfies`), holding boolean-valued `text`/`preserveWhitespace`/
  `openTagOnly`. A spread, a computed key, a non-boolean or an indirection is
  a positioned diagnostic naming the sidecar, never a guess. Hooks load lazily
  on first use via a synchronous `require`, which both Bun and Node handle for
  a `.ts` file with no transform from MX; a sidecar that throws while loading
  becomes a `TranslateError` naming it, which is what lets the language server
  report a diagnostic instead of dying.
- **Invalidation is by recorded evidence, not by expiry.** A cached scan is
  rechecked against each scanned directory's entry list, each tag file's
  mtime, and the `package.json` that supplied `mx.tags`. Two signatures exist
  on purpose: the *parser-facing* one (names, paths, `parseOptions`) decides
  whether Marko may keep its lookup, while the *loaded* one adds every tag
  file's mtime and decides whether a memoized `CustomTag` — which holds the
  sidecar module it already loaded — may be reused. Conflating them served the
  old hooks after an edit that changed only a `transform` body.
  **Caveat when testing a reload:** under Vitest a deleted `require.cache` key
  does not make `require` re-evaluate a file, because its module runner keeps
  its own registry. Bun re-evaluates the entry; Node's ESM loader cache also
  survives `require.cache` eviction, so ESM/TS entries need a tool restart
  (TODO `sync-esm-reload-node`). A Vitest test therefore asserts that the directory is rescanned (add a tag
  file), not that a rebuilt sidecar's hooks changed.
- **`children["*"]` is resolved in one top-down walk, never by renaming the
  tree (decision 147).** `resolveUnnamedTags` (`default-tag.ts`) carries the
  contract in force (`scopeForChildren`) and records each match per node
  (`matchWildcardChild` in `wildcard-resolve.ts`); `lower.ts` reads the
  record (`activeWildcard`) and routes the child to `lowerCustomTag` with the
  canonical name, `alias` on the IR node. A name is claimable only when
  nothing else resolves it: not a core structural name, not a core-owned or
  registered tag, not a *built-in of the target*: an entry of core's own
  taglib (`CORE_TAG_NAMES`, on every target, data included), a name the host
  declares a disposition for, or a non-element in the target's `ctx.lookup`
  (`isBuiltin`). Core holds no list and no host literal. A native element name is
  claimable (the contract decides inside a contract parent), and a
  PascalCase file-local binding beats a match. The parse-only data scan
  (`@mxlang/data` `scan.ts`) reuses `matchWildcardChild`/`scopeForChildren`
  with no `lookup`. A guard hit (`rejectNearExplicitChild`) is a compile error, not a warning. Cycle rule: only an inline entry object reachable from
  itself is non-terminating; recursion by `contract` reference is fine.
- **A contract-only tag is a `DelegatedTag` on a claimed name (decision 130).** A
  definition with no `transform` and no template is contract-only whatever else
  it declares (`{}` and hooks-only included: an empty declaration is a contract
  with no attributes and no body rules); it fails with "neither a `transform` nor a template" unless
  `isDelegatedTag(name)` is true; then `transformCustomTag` validates the call, runs
  the `analyze` recording like any custom tag, and returns one `DelegatedTag` built
  from the call (`contractOnlyDelegatedTag`; whitespace-only body kept). Core asks
  the host only `isDelegatedTag`, never a host name (decision 126). `lowerCustomTag`
  lowers such a call's attributes as `"element"`, like `lowerDelegatedTag`, so a
  host's `resolveAttributeMethod`/`orderAttrs` see the same `on` either way.
  `/var` and attributes on attribute tags stay rejected (no template).
- **A template-only tag is discovered with no hooks**; calling one routes to
  its compiled unit.
- **The scan never hands a core-owned name onward.** A `tags/try.tag.ts` is
  excluded from the map with a diagnostic naming the file, because
  `rejectShadowedRegistration` refuses the *whole* `customTags` map when a
  built-in name appears in it — so passing it through would break every file
  in the package, including files that never call `<try>`, over one misnamed
  file. P4's rule is unchanged; the scan simply does not feed it a violation.
- **A sidecar may not use top-level `await`, and its relative imports need
  explicit extensions** (`./helper.ts`, not `./helper`). Measured: Bun accepts
  both forms, Node rejects both (`require() cannot be used on an ESM graph
  with top-level await`; `Cannot find module`). A sidecar that breaks either
  works in a `bun` build and fails in the editor — the exact disagreement one
  shared loader exists to prevent — so `loadSidecar` restates the constraint
  in its error when the runtime's message identifies it. Sidecars load through
  Node's type-stripping `require`, so every package that can load one declares
  `engines.node >= 22.18`; an older Node fails with `Unknown file extension
  ".ts"` at first tag use.
- **A tag's name is its filename, case included**: `tags/Icon.tag.ts` is
  `<Icon>`. The name must match `/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/`; dotfiles
  are skipped and anything else is a positioned diagnostic naming the file.
  This is a guard with teeth: `tags/.mx` has an empty basename, and an empty
  tag name makes `@marko/compiler` throw `"tag.name" is required`, which fails
  *every* file in the package rather than only a caller. A host module file
  under `tags/` — `<name>.solid.mx` (the Solid host), `<name>.ng.mx` (the
  Angular host) or `<name>.astro.mx` (the Astro host, decision 134) — is reported rather than ignored, naming the file: a
  different file kind, not a tag template. The check is a closed allowlist of
  host segments (`solid`, `ng`, `astro`), not "any second dotted segment before
  `.mx`" — `TAG_NAME_RE` allows dots in an ordinary tag name, so
  `tags/my.icon.mx` is the valid tag `<my.icon>` and stays indexed; only a
  listed segment is rejected, `.astro.mx` included (it was `.amx`, with no `.mx`
  suffix, and silently ignored here before decision 134). `scanCustomTags` and `discoverProjectTags` share the
  rule through `indexDirectory`, so it cannot drift between the two. Note the
  mtime cache assumes sub-second mtime granularity — true on every platform MX
  targets, but two writes inside one tick can look like one.
- **A missing `mx.tags` directory is a diagnostic, not a throw.** It lands in
  `ScanResult.diagnostics` and the scan continues, so one typo in
  `package.json` does not break compilation of files that never used that
  entry. Every integration that scans must *surface* that array or the typo is
  silent everywhere, which is worse than either a throw or an error: the
  language server publishes each as an LSP **warning** against the open
  document whose message names the offending `package.json` (LSP has no way to
  publish against a different file), and the Vite and TypeScript plugins warn
  once per distinct problem rather than once per compiled file.
- **`package.json` reads are cached by path and mtime, and a parse failure
  keeps the previous good manifest rather than dropping `mx.tags`.** Before
  this the read was `JSON.parse(readFileSync(...))` on every scan, and a
  parse error silently set the manifest to `undefined` — a page edit during a
  broken `package.json` (an editor mid-save, a merge conflict) lost every
  `mx.tags` entry with nothing said. The read lives in `package-json.ts`
  (`readPackageJsonCached`), **shared by `scan.ts` and `host-policy.ts`** so
  the two upward walks cannot disagree about which `package.json` is nearest
  or what a broken one means. It caches the parsed result per path, keyed
  fresh on the file's mtime; on a parse failure it keeps the *previous*
  revision's manifest on the result and carries a `PackageJsonParseError`
  (message, plus a line/column only when the runtime's message has one —
  V8's does, Bun's does not, so `1:0` is the fallback). `scan.ts`'s
  `readManifest` turns that error into the positioned `ScanDiagnostic`
  naming the `package.json` (built once per broken revision, `brokenDiagnostics`
  WeakMap) and pushes it into *every* fresh `ScanResult` built against that
  revision, including a cache hit: two hosts scanning the same directory
  (`scanCached`'s cache key includes `host`, so they are two independent
  `ScanResult`s) both get the diagnostic, and so does a caller that scans the
  same broken `package.json` again after `clearScanCache()`. What *is*
  deduped is a `scanCached` cache hit — its own outer cache short-circuits
  before `readManifest` runs again at all. `scanCustomTags` never throws on a
  broken manifest. `host-policy.ts` ignores the kept manifest on error (a
  stale host is not better than the default) and warns instead. `scanCached`'s
  own freshness check (directory listings, tag file mtimes, `package.json`
  mtimes) invalidates a cached scan when the manifest's mtime changes, so the
  two caches agree without needing to know about each other.
- **Anything that must run the scan is tested where it can be driven.** The
  Bun loaders are exercised through `Bun.plugin` under `bun test`
  (`packages/{targets/html,hosts/hono}/src/bun.test.ts`, both wired into the root
  `test:bun`); a row that calls a host's `compile*` with a map it fetched
  itself stays green with `getCustomTags` deleted from `bun.ts` and therefore
  proves nothing. The language server is driven over stdio with a real
  `file://` URI, because `resolve("file:///a/page.mx")` yields
  `<cwd>/file:/a/page.mx` — passing a raw URI discovered zero tags for every
  real document while a unit test using a plain path stayed green.
- **A template custom tag is a compilation unit, and `input` is a real
  parameter** (decision 95, `packages/core/src/template-tag.ts`). A `tags/x.mx`
  template compiles through the **same per-file pipeline a page uses**, into a
  module exporting the tag; the caller emits an injected `import` plus an
  ordinary `Component` call. Nothing is spliced into the caller. This is not
  new machinery but *less* of it: an explicitly imported tag already lowered and
  emitted exactly this way on all six hosts, so the work was routing a
  *discovered* tag down that same path and deleting the substitution engine
  (~1000 lines: `input` substitution, hygiene renaming, caller-side
  import/static merging, `templateStack`/`templateImports`, the expansion depth
  and node caps, and the cycle detector). Consequences, each one a limit that
  simply stopped existing: N reads are N reads rather than N evaluations; a
  spread attribute is ordinary; bare `input`/`typeof input`/destructuring are
  ordinary; a self-recursive tag is legal ESM. `content` stays reserved as an
  attribute name, and `<@content>` is rejected, because both would collide with
  the body slot. A tag declaring `parseOptions.openTagOnly` reports a
  positioned MX error at the call site (``` `<x>`: does not accept content ```)
  rather than a Marko parse error, which is why `openTagOnly` is deliberately
  *not* forwarded into the injected taglib.
- **The injected import is gensym'd and deduped by resolved path.** A
  discovered tag may be named `icon`, which `lower.ts`'s casing rule will never
  resolve as a component, and the caller may already bind that name for
  something else — so the local is always generated (`$mx_Icon1`), minted from
  the file-level counter against the caller's bindings *and* its source text.
  One import per module per tag, keyed by the template's resolved path; if the
  caller already imports that same path itself, its binding is reused and
  nothing is injected (ruling 3). The specifier is the relative posix path with
  `.mx` kept, since every loader resolves `.mx` per file.
- **`static` in a tag now runs once per process, not once per calling module.**
  The tag's module-level statements are its own module's, evaluated at import
  time — Marko's model. This is an observable behavior change for any tag whose
  `static` block has side effects.
- **A template's caller-facing facts come from cached metadata, not from
  expanding it.** Compiling a unit yields `{ readsContent, attributeTags }`,
  plus `returnsValue` and the `<return>` value's source text when the unit
  declares one, cached by path + mtime + source, bounded at 256 entries, with a provisional entry seeded before the
  compile so direct and mutual recursion terminate. This is what preserves MX's
  improvement over Marko: a body passed to a tag that never reads
  `input.content` still warns at the call site, even though the caller no
  longer sees the template's body. Marko does the same thing through
  `loadFileForTag`.
- **`<return>` hands one value back, and `/var` binds it.** A template may end
  with `<return value=EXPR/>`: value only (no `valueChange`), at most one per
  template, at the **top level** only — not inside a native tag, `<if>`,
  `<for>`, an attribute tag or a `<define>`. It takes a required `value=` and
  nothing else. Every rule is validated in the **tag's own compilation**, which
  is what makes the signature one shape rather than `T | undefined` per path:
  a unit cannot see its callers, so no call site can widen it. The grammar is
  Marko's own, ported with MX wording; its eleven compile-time error fixtures
  each have a counterpart test in `lower.test.ts`. `<return>` in a *page* is
  legal and means the same thing.
  **The export shape is the host's business**: on html, `render(input, out)`
  writes to the caller's sink and returns the value (decision 155, the Marko
  render model; core still only records `returnsValue`); `{ value, output }` on
  the three JSX hosts (where the call is emitted as an ordinary *function
  call*, not a JSX element — a JSX element is a description of a call the
  runtime makes later, so it could never hand the pair back); on Solid a
  generated `$mxReturn` callback prop the unit calls during setup, because a
  Solid component's return value is its view. **The Solid binding is one-shot,
  not reactive** (design §2.4, risk 4) — a tag wanting reactivity returns an
  accessor.
  **Astro** renders an MX component through its own renderer rather than a
  call site; its `.mx` leaf components are html units, so `server.ts` calls
  the default export and gets the markup (the value stays in `render`); a `.astro.mx` template may
  *call* a returning tag but cannot bind one, since it has no statement
  position of its own (`/var` in `.astro.mx` is a positioned error).
  **`/var` is top-level-only on the JSX hosts and Solid.** Every structural
  kind lowers to an expression there — a ternary, a `.map` callback, a `<For>`
  render prop — so a callback scope has no statement position for the binding.
  Hoisting the call to the component body took it out of the scope it was
  written in (it read row bindings that did not exist there, and ran once for
  a body rendered N times), so invariant §7.5-8's "reject the escape" applies:
  a positioned error naming the tag. html keeps supporting the nested case,
  where the temp lands inside the emitted `for`/`if` block. Lifting the
  restriction means a statement position per callback scope — MX 2.
  **A returning unit on a JSX host may not import hooks.** It is invoked as a
  plain function, so Preact's/React's dispatcher would bind its hooks to the
  *calling* component's hook list — order-dependent, broken under conditional
  or looped calls, and `useContext` reads the caller's position. Importing a
  `use*` binding from `preact/hooks`, `preact/compat`, `react` or `hono/jsx`
  into a unit that declares `<return>` is a compile error. Solid is unaffected;
  its callback prop keeps the unit a component.
  Three positioned diagnostics stand in for what JavaScript would leave as
  `undefined` or a TDZ crash: `/var` on a tag whose template has no `<return>`;
  a read **outside** the declaring block (MX rejects the escape rather than
  hoisting the binding into a getter as Marko does, which would change its
  user-visible type — invariant §7.5-8); and a read **before** the declaring
  call. Scope is tracked as a path of block ids rather than a depth, because a
  read in a sibling block sits at the same depth as the binding yet is not in
  scope.
- **A sidecar `transform` may return IR or a `TagCall`.** Returning IR is a
  macro the author wrote — the only expansion left in the language. Returning a
  `TagCall` (or calling `ctx.build.template(call)`) validates or rewrites the
  call and then routes it to the adjacent template unit.
- **The html target augments `Input` only when the template reads
  `input.content`**: the render signature becomes
  `input: Input & { content?: () => string }`, so an imported call passing a
  body typechecks; a tag that ignores the body keeps a bare `Input`. The
  brand/helper rewrites in `translate.ts` key off whichever of the two
  signature lines was emitted — and the `function ` prefix they replace carries
  its trailing space, or the emitted code gets a stray one.
- **`class`/`for` are renamed to `className`/`htmlFor` on *elements only*.** The
  shared JSX emitter's `#attrName` takes the component flag: a component's
  attributes are its author's `Input` contract, so a tag whose template reads
  `input.class` must receive `class` whatever the target calls the DOM
  property. Renaming on a component call silently dropped the value; it only
  became reachable once a template tag became a real component call.
- **Which IR nodes carry spans** (all `span?: SourceSpan`, UTF-16 code-unit
  offsets into the file being compiled, always optional and absent on
  synthesized nodes): `Expr.span` (the expression's authored text); `Attr`
  `nameSpan` (zero-width at the `=` for a default attribute) and a static
  attr's `valueSpan` (quotes included); `DelegatedTag`, `Element`,
  `Component` and `AttributeTag` `nameSpan` + whole-tag `span` (opening tag,
  body and closing tag); `For`/`Define` `paramSpans`; `Define.nameSpan`;
  and — added by core-ir-spans — `Text.span` (the authored text, which
  `value` has Marko-normalized), `Interpolation.span` (the whole
  `${…}`/`$!{…}`, delimiters included), `Comment.span` (delimiters included),
  `IfChain.span` (the `<if>` through the last branch's closing tag, layout
  between branches included) and per-`Branch.span` (that branch's own tag),
  `For.span`, `Const.span`, `Define.span` (whole tag), and `Import`/`Export`/
  `Static.span` (the authored statement with the trailing line terminator
  trimmed — Marko's statement `loc` ends on the next line's column 0; a
  trailing same-line comment is included, as in the statement's `code`).
  `InputInterface`, `Hoisted`, `DocumentType` and a synthesized (`synthesized:
  true`) `Import` carry none. Slicing the source with a span yields the
  authored text; tests in `src/spans.test.ts` assert exactly that, including
  under emoji (UTF-16) and CRLF.
- **Cross-file errors carry their origin structurally.** `metadataForTemplate`
  converts a callee's Marko `CompileError`/`CompileErrors` before the custom-tag
  catch can wrap it at the caller. Its existing `TranslateError.file`, `line`
  and `column` name the callee together (nested failures keep the deepest file).
  Aggregates use the first parser error's position and keep every frame. The
  message keeps frames, not repeated `at <path>:L:C` headers or compiler stacks.
  Scan failures likewise use `file` rather than a message prefix for sidecars,
  manifests and contracts. Structured lines are 1-based, columns 0-based;
  pointer messages print columns 1-based. Tests: `src/cross-file-error.test.ts`.
- **Positions get a third rule** (spec §2): material from a tag template keeps
  that file's line and column, tagged through the optional `Position.file` (and
  `Expr.file`, since an `Expr` carries no `loc` of its own — only the optional
  `span?: SourceSpan` core contract C4 added, file-absolute UTF-16 code-unit offsets into
  `file` when that is set). Neither `Position.file` nor `Expr.file` is written
  anywhere in `packages/core` today; both are read-only plumbing for a future
  writer. `TranslateError` gained a matching optional `file`. Absent means the
  file being compiled, so
  every position that existed before templates is unchanged. The language
  server publishes such a diagnostic against the template's **own URI** at its
  real position and leaves a pointer at the head of the open document (it
  clears the template's diagnostics when the caller stops reporting them, since
  the template is not itself open); the TypeScript plugin and `mx-tsc`
  (`@mxlang/typescript-plugin`'s `foreignTemplateError`, `src/language.ts`)
  report such a `TranslateError` against the template file at its own
  position too, plus a pointer diagnostic on the caller naming the template —
  a plain `CodeMapping` still cannot address two source files, so this is a
  second, file-keyed compile diagnostic rather than a mapped span.
- **Silent-drop reports go through `ctx.warnings`, not `console.warn`.**
  `warn(ctx, …)` records a positioned `MxWarning` when a sink is collecting and
  falls back to printing when none is, so a plain build is as loud as before
  while the language server turns them into Warning diagnostics in the file
  being edited — which is the one place a dropped-content report is worth
  anything. Both P1's unread-`attributeTags` warning and P3's unplaced-content
  warnings use it.
- **The template metadata cache is bounded** (256 entries, oldest-inserted
  evicted), not an unbounded process-wide map — a language server compiling an
  edited file over and over is long-lived, the same discipline P2's scan cache
  owes.
- **`oracle:custom-tags` compiles each fixture's tag units through the caller's
  own host** and writes them beside the caller, because the tag is a real
  import now. All 36 rows pass, Solid included.
- **Every emitted module's default export is named after its file**, never
  anonymous: `icon.mx` becomes `export default function Icon(…)`,
  `table-of.mx` becomes `TableOf`. `Ir.exportName` carries it, derived by
  `exportNameFor` (`-` and `_` separate words, `$` does not; a basename that
  would not start an identifier is prefixed `Tag`) and re-minted if it
  collides with anything the file already binds — `ctx.imports`,
  `ctx.defines`, or a match in the source text, since a name can reach the
  emitted module without passing through either set (a `<const>`, a tag
  param). It is computed in `lower` **before** the body walk, because a
  self-recursive call resolves during that walk.
  **That name is what makes self-recursion need no import** (design invariant
  §7.5-7): when a discovered tag's resolved path is the file being compiled,
  `bindingForTemplate` returns the export name instead of minting an import.
  A module importing itself is legal ESM and does work, but it is a module
  importing a binding it already has. The `tree` oracle fixture is the row
  that proves it end to end on all six hosts.
  **Consequence for anything that matches the emitted module as text:** the
  export line's *name* is now per-file, so four places match its shape and
  read the name back rather than pinning `render` — `@mxlang/html`'s
  `brandRender`/`finalizeModule`, `@mxlang/typescript-plugin`'s
  `createAstroTypeSurface`, and `@mxlang/astro`'s two `vite-pages` patterns.
  Since decision 155 the module also carries `<Name>.render = __mxRender;`
  after the default export; `vite-pages`' `wrapAsPage` renames that line along
  with the function, so a fifth match lives there. The final statement is
  `export default <Name> as ((input: Input) => string) & { render: typeof
  __mxRender };` (the `as` keeps diagnostics printing the signature rather
  than `typeof <Name>`), so the Astro type-surface and `vite-pages` tail
  patterns accept an optional `as …` before the `;`.
  Pinning the literal there is what made every `.mx` import report
  "is not a module" under `mx-tsc --astro` when the name first changed.
- **A synthesized import is told apart from an authored one by
  `Import.synthesized`, and only Solid cares.** A `.solid.mx` MX region is an
  *expression* inside a TypeScript module, so it has no module scope to hold a
  discovered tag's injected import. The Solid host therefore splits its
  module-level-statement rejection **by origin, not by kind**: an authored
  `import`/`static`/`export`/`export interface` inside a region is still the
  same positioned error (the author has a real module to put it in), while a
  synthesized import is handed back on `CompileSolidMxResult.hoistedImports`
  for the caller to place. `packages/parser`'s bridge stamps those on the
  region root's `extra.mx` and `parse` writes them into the surrounding
  module: once per **resolved path** (the node carries `specifier` and
  `resolvedPath` beside `synthesized`, so no consumer parses the statement
  text), reusing the module's own authored *default* import of the same file
  when it has one, inserted after the last import. Every other host emits both
  kinds identically and ignores the flag.
  **A type-only import is never reused** — `import type Icon from "./icon.mx"`
  binds no runtime value, so reusing it would leave the call referencing a
  name erased before the module runs.
  **Nor is one shadowed at the region.** Reuse emits the authored name *inside
  the region*, so a scope between the module and the region that re-declares
  it (`function f(Icon) { <icon/> }`) would make the reference resolve to the
  parameter — silently, to whatever the caller passed. The check is
  deliberately coarse (any binder of that name on the path from module root to
  region), because over-reporting costs one import under a generated name,
  which is always correct, while under-reporting is the silent bug.
  **The rename onto an authored binding is scope- and position-aware**, and
  each guard is a measured bug: it rewrites only inside a region's stamped
  `[start, end)` range (else a module that happens to declare
  `const $mx_Icon1 = …` gets that declaration renamed onto the author's
  import, a duplicate-binding `SyntaxError`), never a binding position, and
  never a non-computed object key or member property (`{ $mx_Icon1: 1 }` and
  `o.$mx_Icon1` are not references to a binding at all).
  The placement decision itself lives in `packages/parser/src/mx/hoist-imports.ts`
  (`planHoistedImports`) because **two** consumers need it: `parse`, and
  `@mxlang/typescript-plugin`'s `.solid.mx` path, which reaches it through
  `print()` — `mx-language.ts` never sees a `.solid.mx` file (`isMx` excludes
  the extension), so the editor and the build agree by construction.
  **The stamp rides the AST rather than a parser-level collector, and that is
  load-bearing**: the bridge runs *speculatively* — the TypeScript plugin
  tries the MX grammar inside a `tryParse` on every `<` in expression
  position, including ones that turn out to be generic arrows — so a losing
  attempt throws its node away. A collector would keep that attempt's imports;
  a stamp goes with the node. Same pattern as `collectMxRegions`.
- **`compileSolidUnit` is the Solid host's whole-file entry point**, beside the
  region entry point `compileSolidMx`. A tag unit is a *file*, so its
  module-level statements are **placed** rather than rejected — which is the
  one thing the region compiler cannot do. It **does** emit
  `export interface Input` and annotates `function Card(input: Input)`, as the
  other JSX hosts do; the output is TSX carrying types and runs through a
  TS-aware step (vite, `.tsx` id) at build time.

## Target contract (unstable; decisions 129 and 132)

`src/target-descriptor.ts` and `src/target-loader.ts` hold the contract a
target registers with. **Nothing consumes it yet**: no tool, host or core path
calls these functions, and `host-policy.ts`, `scan.ts` and `callee-input.ts`
still use their closed host lists. The contract is exported from `index.ts` and
marked `@unstable`; `descriptorVersion` is `0` until core is published under a
stable version.

- **Vocabulary.** A *target* is an output format (the `mx.target` value); a
  *host* is a framework (the `mx.host` value, `host.name`). `html` and `data`
  would be targets with no host. A `TargetDescriptor` is plain data plus an
  optional lazy `load(core)`; its optional `host` part carries host facts (name,
  `default`, file kinds). **Core names no target and no host**: no built-in name
  appears in core code. `createTargetLookup`'s `reservedNames` option
  takes names away from third parties (07 Q5); the registry passes the list.
- **`validateDescriptor(value)`** checks shape only and throws a
  `TargetDescriptorError` naming the **first** failing field in declaration
  order (`field`, a dotted path; `message`, the detail with no prefix; `kind`
  `"version"` for a `descriptorVersion` other than 0). Target and host names,
  and legacy host values, are bare words (never a package specifier, so
  `mx.target` can tell a name from a specifier); a file-kind `segment` is one
  lowercase word, never `mx`. More than one non-deprecated `legacyHostValues`
  entry is rejected (07 Q3): it is the hostless target's filter key. Unknown
  extra fields are ignored.
- **`createTargetLookup(descriptors, { defaultTarget?, reservedNames? })`**
  validates each descriptor, then enforces what only a set can break, each
  with a `TargetLookupError.rule`: `duplicate-target`, `target-is-host-name`
  (a target name equals any host name), `package-conflict` (`packageName`
  unique for a hostless target, shared only between targets of one
  `host.name`), `host-default` (exactly one `host.default` when a host has
  several targets), `host-value-conflict` (every `mx.host` value selects one
  target) and `segment-conflict`, plus `reserved-name` for any name in the
  caller's `reservedNames` option. `fromPackage(pkg)` returns the host's
  default target. `attrTagSources()` dedupes by package name.
  `hostFilterKey(target)` is the host name, else the single non-deprecated
  legacy value, else `undefined`. The default target is the first descriptor
  unless named, so a one-descriptor lookup (a direct host entry) defaults to
  itself.
- **`loadTargetDescriptor(spec, fromDir)`** is `loadSidecar`'s mechanism
  (`scan.ts`) anchored at the **project**
  (`createRequire(fromDir/package.json)`). It caches by resolved path plus the
  `package.json` mtime of the nearest manifest above the file, and does
  **not** evict `require.cache` per call (an installed package is not
  edited). What is re-evaluated, exactly: on an mtime change, when that
  manifest belongs to the target package (its directory is neither `fromDir`
  nor above it), the entry and every module under that directory, except
  modules under a nested `node_modules` (other packages), and the loader's
  own cached descriptors for those files; when the manifest is the project's
  own (a local `./targets/vue.js` has none of its own), the entry file only,
  so the project's modules and its `node_modules` keep their identity. Also
  evicted: `clearTargetDescriptorCache()`, a module that evaluated but
  failed validation (otherwise a fixed install would be served the same
  invalid exports), and a module that threw while evaluating (Bun keeps it
  in its registry and re-throws it after the file is fixed). Failures are
  never cached, and a stale entry is dropped when its reload fails or is
  invalid, so later calls re-evaluate the entry but do not evict the package
  again. Errors are `TargetLoadError`: `not-found`, `load-failed`,
  `invalid-descriptor` (a wrong `descriptorVersion` included). Its messages
  are one line (the thrown text's first line, or `<no message>` when it is
  blank; the full error is `cause`; a non-`Error` throw is stringified, or
  reads `a non-Error value was thrown` when it cannot be) and do not name
  the config key (`mx.host`/`mx.target`); the caller prefixes that. The
  sidecar constraints hold (no top-level `await`, explicit extensions on
  relative imports) and are restated in the message.
- **After a miss, a specifier is resolved in a fresh child process**
  (`src/resolve-after-miss.ts`). Both runtimes keep resolution state per
  process (a miss on Bun; a missing `package.json` on Node, which then
  resolves `index.js` and ignores `main`), and neither can be told to forget.
  So the runtime's own `require.resolve` answers until a specifier misses;
  from then on the same runtime answers in a child (`process.execPath`, its
  resolution flags, `ELECTRON_RUN_AS_NODE`), at most once per specifier per
  change to a stamp of the paths an install touches. Do not reintroduce a
  model of the resolver: review 3 found eight shapes a hand-written one got
  wrong (`module-sync`, a BOM, Bun's tsconfig `paths`, percent-encoded
  segments, ...). `src/target-loader-resolve.test.ts` is the oracle: a
  differential table against each runtime's `require.resolve` in a clean
  process, with and without a miss first, error kinds included.
  `node:child_process` is loaded lazily; `setSpawnSyncLoaderForTesting` swaps
  it in tests.
- **Caller-owned target lookup (decision 126 addendum).**
  `TargetCompileOptions.targets` and `HostRegionInput.targets` are optional
  generic `TargetLookup` fields. A descriptor forwards the supplied lookup
  into its compile entry's `HostOptions`, defaulting to its own lookup only
  when none was supplied. This preserves the caller's full cross-file
  resolution scope without naming any host or target in core.
- **Type-check projections (decision 140).** `TargetCompileOptions.typeCheck`
  is optional and generic. The editor passes it to request type-only checks;
  descriptors forward it to compile entries that support them. Ordinary build
  callers leave it unset, so emitted runtime code is unchanged.
- **`load(core)`** takes the **tool's** core (`typeof import("./index.ts")` in
  core's source, which emits as the same relative type), so a third-party
  target shares its registry, caches, editor buffer overrides and one
  `TranslateError` class. The note's `typeof import("@mxlang/core")` is the
  same type; core's source uses the relative form because a bare
  self-import in the emitted `.d.ts` fails `pack-hygiene` (core does not
  declare itself as a dependency). Proved on the real core: typecheck and
  declaration emit are clean and the parameter is typed, not `any`. A target
  that imports its own core anyway throws an `instanceof`-foreign
  `TranslateError`; the brand check that recognises it is PR 3's (design note
  §4.4), and `fixtures/targets/own-core` pins the divergence until then.
- **Fixtures** under `src/fixtures/targets/` are third-party packages loaded by
  relative specifier (`./ok/index.ts`): `ok`, `missing` (a bare project dir),
  `throws`, `invalid`, `version`, `own-core`. They are real TypeScript loaded
  by Node's strip-only `require`: no parameter properties, no enums, and core's
  own source cannot be imported by one (it uses parameter properties), which is
  why `own-core` carries a stand-in `core-copy.ts`.

## Atoms (decision 156)

- **`expr()` emits the authored source slice, not the printed AST; an
  AST-level rewrite must also splice into the slice through
  `rewriteReferencesSource`.** The slice is what keeps TypeScript type
  arguments (Marko drops them from the AST). `src/atoms.ts` converts each atom
  stand-in to a `StringLiteral` in the tree, and `expr()` splices the same
  `"name"` at each atom's span on both paths (no bindings: `spliceSource`;
  bindings: added to the binding rewrites). Converting the node alone leaves
  `:a` in `Expr.code`, so every host and the virtual code would emit it.
- **The parser hands Babel a same-length numeric stand-in** (`:a` is `0.`),
  recognised by `source[start] === ":"`. `convertAtoms` runs from `lower` and
  from an external `lowerChildren` before `resolveUnnamedTags`; `exprOf`
  asserts no stand-in survives (`assertNoStandIn`). A stand-in reaching an
  emitter would print as a number, silently.
- **A whole-value atom is a `static` attr with `atom`**, so no emitter changed;
  the `:name` sugar's `name` gets `extra.mxAtom` in `sugarAttr`. Nested atoms
  are `Expr.atoms`; `mappedExpr` maps each one to its literal. Hosts mapping an
  expression should call `mappedExpr(expr)`, not `mapped(expr.code, expr.span)`.
- **Stock parser:** `installedParserLexesAtoms` probes `onAtom`; on a stock
  parser `stockAtomError` turns Babel's failure at a `:name` into the
  "atoms need the MX parser" error, in `compileSource`, `parseFragment` and
  `exprOf`'s recovered-parse path.
- **Atom contracts are two phases at the end of a unit's lowering**
  (`src/atom-contracts.ts`, decision 156 PR 2). `transformCustomTag` records a
  `ContractFact` (definition, call, authored ancestor nodes) per call in
  `ctx.contractFacts`, `ctx.declare` from `analyze` fills `ctx.contractDerived`,
  and `checkAtomContracts` (called from `lowerTemplate`) declares everything,
  then checks every `values`/`pattern`/`ref`. Scopes are tag *instances* (Marko
  nodes in `ctx.authoredAncestorNodes`, pushed beside `authoredAncestors`);
  the default scope is the file (decision 156 addendum 7), the outermost link of
  every resolution chain, so top-level siblings share names and a `ctx.declare`
  outside every call is visible too. Attribute-tag attributes (any depth) are
  checked from `call.attributeTags` against `definition.attributeTags`. A call's own atom-vs-string type check stays in
  `validateAttributes` (`checkAtomAttr`), not here.
  Diagnostics list the candidates through `atomList` (sorted, ten, `+N more`)
  and `acceptedNames` (the one filter shared with completion: `pattern`
  filters, `values` and `ref` intersect). `atomCandidates(atomFacts, offset)`
  answers the same for a position and never throws. `AtomFacts` is opaque and
  compact (`atomFactsOf`: resolved declarations, scope ids, atom slots per call;
  no node, definition or hook). `checkAtomContracts` sets `ctx.atomFacts` when
  it starts, so `TranslateError.atomFacts` exists only when the atom check ran
  (complete facts); earlier errors leave it unset. A plain string against a
  `ref` atom is raised by that check (`checkStringForRef`), listing the names.
  Editor completion on top of it is a TODO (the language server is
  diagnostics-only).

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
`packages/hosts/html/src/emitter.ts` for vanilla HTML strings;
`@mxlang/astro` uses `packages/hosts/astro/src/astro-template.ts` for `.amx`'s
expression-shaped Astro syntax. Neither emitter reads a Marko node; a
host-specific resolve-time decision goes in `HostTag.data` through
`claimsTag`/`resolveHostTag`.

Five facts worth knowing before editing it:

- **Attribute-tag IR has three synchronized views (decisions 106–108).**
  `Component` and a dynamic `HostTag` keep `attributeTags`, the flat
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
  A claimed dynamic `HostTag` also retains its tag arguments in `args`; an
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
  `HostTag`/`Component` split) and the strict rule only for `"name"`. The
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
  named-lookup scheme (used for the no-args call shape): params beyond the
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

- **Its parser dependencies are `@marko/compiler` and `@babel/parser`.**
  `core.ts` used to parse
  an `import` line with `@mxlang/parser` — the *SolidMX parser* package — for a
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
  defaults its `on` parameter to `"element"` and a `HostTag` takes that
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
  **Phase B emission (each host recomposes from `attr.event`):** Solid and the
  Preact/hono targets emit `on` + the capitalized DOM name (`click` →
  `onClick`, `dblclick` → `onDblclick` — capitalize-first, so `onDblClick` and
  `on-dblclick` are byte-identical there), and those runtimes lowercase the
  prop at bind time, so `onDblclick` binds `dblclick`. The React target is
  different in kind: React's prop names are camelCase data from react-dom's
  own registration table (`simpleEventPluginEvents`), which no derivation can
  reverse (`keydown` → `onKeyDown`), so the React target vendors the list and
  looks the spelling up (`buildReactEventPropNames` in
  `packages/hosts/react/src/target.ts`, guarded by a drift test against the
  installed react-dom). A custom DOM
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
  `src/lower.test.ts`: `claimsTag`/`resolveHostTag` (the lower-time tag
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
  dependency here. SolidMX's own bridge
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
  `ctx.build.hostTag("try", children, attributeTags)`. `lowerCustomTag`
  passes an `isBuiltin` flag that skips the ordinary `hasContent` gate on a
  custom tag's body: a template-authored tag treats a whitespace-only body as
  "no children supplied", but `<try>` is a structural pass-through wrapper
  and must reproduce the caller's body unchanged, matching what
  `lowerHostTag` always did. Each host's `claimsTag`/`resolveHostTag` for
  `"try"` only decides how the primitive renders now — `@mxlang/html`,
  `@mxlang/solid`, and `@mxlang/preact`'s shared JSX emitter (reused by
  `@mxlang/react`/`@mxlang/hono`) all shrank to that. `@mxlang/astro` never
  claimed `"try"`; its rejection is an ordinary `tags["try"]` disposition
  entry (`ctx.declarations.tags`), checked earlier in `lowerTag` than any
  custom tag, so it is unrelated to this change and untouched. Error wording
  for the shape checks changed from each host's hand-written phrasing (e.g.
  "given twice") to the generic custom-tag messages (e.g. "may not be
  repeated") — a wording change, not a behavior change, so the affected host
  and SolidMX-bridge tests were updated to match rather than left failing. A
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
  compiled file — the Bun loaders, the Vite plugin, the Astro `.amx` plugin,
  the TypeScript plugin, the language server, and `mx-tsc` through the same
  language plugin — because which tags a template may call follows from where
  the template lives. An explicitly passed `customTags` still wins over a
  discovered tag of the same name.
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
  — the Bun loaders (`"html"`, `"hono"`), `@mxlang/astro`'s `.amx` plugin
  (`"astro"`), the SolidMX and whole-file `.mx` typescript-plugin paths
  (`"solid"`, resolved per file via `resolveHostPolicy`), the language
  server (`hostPolicy.host`), the Vite plugin (`resolveHostPolicy(file).host`
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
  claim (`ctx.declarations.claimsTag`), then components/elements.** `lower.ts`'s
  tag-name switch checks `/^[A-Z]/.test(name) && (ctx.defines.has(name) ||
  ctx.imports.has(name) || (ctx.tagVarShadowed?.has(name) ?? false))`
  directly — a *core* rule inline in `lower.ts`, not a call into a host's own
  `isComponent` (Solid's and Astro's `isComponent` are casing-only and never
  consult `ctx.imports`/`ctx.defines`/`ctx.tagVarShadowed` at all, so there is
  no shared "file-local half" of `isComponent` to call into) — before ever
  consulting `ctx.customTags` or `claimsTag`, so `import Panel from
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
  `<for>`) are in `packages/hosts/html/src/translate.test.ts`; IR-level
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
  its own registry; Bun and Node both do re-evaluate, which is what ships. A
  Vitest test therefore asserts that the directory is rescanned (add a tag
  file), not that a rebuilt sidecar's hooks changed.
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
  under `tags/` — `<name>.solid.mx` (the Solid host) or `<name>.ng.mx` (the
  Angular host) — is reported rather than ignored, naming the file: a
  different file kind, not a tag template. The check is a closed allowlist of
  host segments (`solid`, `ng`), not "any second dotted segment before
  `.mx`" — `TAG_NAME_RE` allows dots in an ordinary tag name, so
  `tags/my.icon.mx` is the valid tag `<my.icon>` and stays indexed; only a
  listed segment is rejected. `.amx` has no `.mx` suffix at all (a separate
  three-letter extension), so it never reaches this check either — it is
  silently ignored under `tags/`, the same as any other non-tag file (a
  README, a `.css`). `scanCustomTags` and `discoverProjectTags` share the
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
  `mx.tags` entry with nothing said. `readManifest` in `scan.ts` now caches
  the parsed result per path, keyed fresh on the file's mtime; on a parse
  failure it keeps the *previous* revision's manifest in force and stores the
  positioned `ScanDiagnostic` naming the `package.json` on the cache entry
  itself (`ManifestCacheEntry.brokenDiagnostic`) — parsed once per broken
  revision, but pushed into *every* fresh `ScanResult` built against that
  revision, including a cache hit: two hosts scanning the same directory
  (`scanCached`'s cache key now includes `host`, so they are two independent
  `ScanResult`s) both get the diagnostic, and so does a caller that scans the
  same broken `package.json` again after `clearScanCache()`. What *is*
  deduped is a `scanCached` cache hit — its own outer cache short-circuits
  before `readManifest` runs again at all, so a language server re-scanning
  the same broken file on every keystroke still gets one diagnostic per
  `scanCached` call, not one per `readManifest` call. `scanCustomTags` never
  throws on a broken manifest. `scanCached`'s own freshness check (directory listings,
  tag file mtimes, `package.json` mtimes) already invalidates a cached scan
  when the manifest's mtime changes, so the two caches agree without needing
  to know about each other.
- **Anything that must run the scan is tested where it can be driven.** The
  Bun loaders are exercised through `Bun.plugin` under `bun test`
  (`packages/hosts/{html,hono}/src/bun.test.ts`, both wired into the root
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
  **The export shape is the host's business**: `{ value, output }` on html and
  the three JSX hosts (where the call is emitted as an ordinary *function
  call*, not a JSX element — a JSX element is a description of a call the
  runtime makes later, so it could never hand the pair back); on Solid a
  generated `$mxReturn` callback prop the unit calls during setup, because a
  Solid component's return value is its view. **The Solid binding is one-shot,
  not reactive** (design §2.4, risk 4) — a tag wanting reactivity returns an
  accessor.
  **Astro** renders an MX component through its own renderer rather than a
  call site, so `server.ts` unwraps the pair there; a `.amx` template may
  *call* a returning tag but cannot bind one, since it has no statement
  position of its own (`/var` in `.amx` is a positioned error).
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
- **The html host augments `Input` only when the template reads
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
- **Positions get a third rule** (spec §2): material from a tag template keeps
  that file's line and column, tagged through the optional `Position.file` (and
  `Expr.file`, since an `Expr` carries no `loc` of its own — only the optional
  `span?: SourceSpan` core contract C4 added, file-absolute byte offsets into
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
  one thing the region compiler cannot do. It deliberately does **not** emit
  `export interface Input`: Solid's compiler takes source text and has no
  TypeScript frontend (the caller is stripped before it ever sees it), so a
  type declaration there is a downstream syntax error. Typing a unit's props
  is phase 3, through the same virtual-file projection the TypeScript plugin
  already does for `.solid.mx`.

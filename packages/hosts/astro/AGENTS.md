# astro — agent instructions

## `@mxlang/astro`: the Astro host

`packages/hosts/astro` (`@mxlang/astro`, decisions 70 to 72) renders `.mx`
components inside an Astro project as **static markup**: no islands, no
hydration, no client JS from this renderer. Two files and no third —
`src/index.ts` is the integration, `src/server.ts` the renderer's server
entrypoint. There is no compile step of its own: the integration adds
`@mxlang/vite-plugin` through `updateConfig({ vite: { plugins: [...] } })`,
since an Astro project is a Vite project and that plugin already turns a
`.mx` file into a plain module.

Four facts worth knowing before editing it:

- **`check` tests a brand, and the brand is emitted by the *translator*.**
  Astro's renderer contract hands `check(Component, props, slots)` the
  component as an opaque value with no reserved brand channel, and Astro's own
  docs suggest sniffing `Component.name` — which a minifier may rewrite and
  any function could collide with. Instead `@mxlang/html`'s `postEmit`
  (`brandRender` in `translate.ts`) names the core's anonymous default export
  `render`, marks it, and exports it, so every compiled MX module carries
  `Symbol.for("mx.component")`. `Symbol.for`, through the global registry, not
  a `unique symbol`: the property is written by a compiled module and read by
  a different package, possibly from a different copy of the translator on
  disk, so the two sides cannot agree by import identity. It is written with
  `Object.defineProperty`, not `render[Symbol.for(…)] = true` — the emitted
  module is TypeScript a consumer typechecks, and the assignment form is
  `TS7053` under `strict`, which would make every compiled template a type
  error in the user's own build.
- **Slots are strings; MX's children are thunks.** Astro hands slots in as
  `Record<string, string>` of already-rendered HTML, while MX's compiled
  modules take children as a `content: () => string` prop and each `<@name>`
  attribute tag as `name: () => string`. `renderToStaticMarkup` wraps each
  slot string in a thunk (`default` → `content`, every other key → the
  attribute tag of the same name). Two limits follow, both Astro's contract
  rather than MX's: an attribute tag declaring **params** (`<@footer|year|>`)
  can never receive them from Astro, and is documented rather than detected
  (the renderer sees a compiled function, not the template); and slot HTML is
  inserted verbatim, so a template must use `$!{input.content()}`, never
  `${...}`, or the markup Astro rendered comes out escaped.
- **The host compiles under `strictPolicy`**, so `<let>`, `<effect>`,
  `<lifecycle>`, `<script>`, `client` blocks, `<id>`, `<log>` and `<debug>`
  are compile errors naming the construct (decision 71: stateful tags mean
  whatever the host says, and this host has no reactive target at all;
  decision 111 adds `<log>`/`<debug>` as debug-only tooling rejected the
  same way). That required the one
  change to `@mxlang/vite-plugin` this package needed: a `strict?: boolean`
  option on `MxPluginOptions`, passed straight through to `compile()`. It is a
  passthrough, not a policy of the plugin's own; `.solid.mx` never goes
  through the translator and is unaffected.
- **A capitalized tag resolves through the `---` fence's own value bindings**
  (decision 114 parity, `unresolved-tag-jsx-astro-angular`), not by bare
  casing. `lowerAstroMx` parses the fence's own top-level imports and
  `const`/`function`/`class` declarations with `@mxlang/parser`'s
  `sourceBindings` (type-only bindings excluded, same rule as everywhere
  else decision 114/115 applies) and feeds them into `ctx.imports` before
  lowering — the same operator-ruling extension `.solid.mx`'s
  `moduleBindings` already gave decision 114, since Astro's local-component
  form *is* a fence import and a `.astro.mx` template body has no MX-level
  `import`/`<define>`/`<const>` of its own. `isComponent` used to be a bare
  `/^[A-Z]/` test, so `<TotallyUndefined/>` (no fence import) silently
  emitted a JSX reference to nothing; `rejectUnknownTag` now reports Marko's
  own wording for that case, through the same `lower.ts` hook every other
  host uses. A discovered/registered custom tag is unaffected — checked
  earlier in `lower.ts`'s precedence order, before `isComponent` is ever
  asked.
  **`Fragment` is the one Astro built-in that resolves with no fence
  import.** Measured against `@astrojs/compiler-rs` (astro@7.3.2): the
  compiler auto-injects `import { Fragment, ... } from
  "astro/runtime/server/index.js"` for any `<Fragment>` reference, the
  *only* capitalized name it does this for — every other candidate tried
  (`Markdown`, `Debug`, `Prism`, `Code`, an arbitrary unbound name) compiles
  to a bare reference with **no** import and **no** diagnostic (the Astro
  compiler runs no resolvability check of its own at all), a silent runtime
  `ReferenceError` for anything MX cannot otherwise resolve. `isComponent`
  checks `ASTRO_BUILTIN_TAG_NAMES` (today, just `Fragment`) after
  `ctx.imports`, the same shape as Solid's `SOLID_BUILTIN_TAG_NAMES`.
- **No `clientEntrypoint`, and the host raises the `client:*` error itself.**
  `AstroRenderer` declares the field optional, so a hydration-free renderer is
  a first-class shape. The research note (and this file, before it was
  measured) claimed `client:*` on such a component raises Astro's own
  `NoClientEntrypoint`. **It does not, in astro@7.3.2.** That error is defined
  in `dist/core/errors/errors-data.js` and thrown from nowhere — grepping the
  whole installed package finds only the definition and its `.d.ts`. The render
  path is a bare `if (renderer.clientEntrypoint)`
  (`dist/runtime/server/hydration.js:98`) that skips `renderer-url`,
  `component-export` and `props` when absent, with no else branch. Left alone
  the build would succeed and emit an `<astro-island client="load">` whose
  loader falls back to `Promise.resolve({default:()=>()=>{}})` — an island that
  silently does nothing, on a host whose claim is shipping no client JS.
  Decision 70's intent is that the directive is an error, so
  `renderToStaticMarkup` throws on `metadata.hydrate` (Astro's own fourth
  argument; `AstroComponentMetadata.hydrate` is
  `'load'|'idle'|'visible'|'media'|'only'`, and `displayName` names the
  component). `examples/astro-static/e2e/build-errors.spec.ts` asserts the
  failing build.

### `.astro.mx`: AstroMX templates (decisions 76c, 78)

An `.astro.mx` file is an **Astro component whose template is MX** — a different
file kind from `.mx`, not a variant of it. A `.mx` component compiles to a
runtime-free `(input) => string` and is called *through* this package's
renderer; an `.astro.mx` component **becomes** an Astro component: the `---` fence
passes through byte for byte with Astro's own semantics (`Astro.props`,
imports, `getStaticPaths`), the MX template after it is lowered to Astro
template syntax, and the whole file goes to Astro's compiler. Components and
layouts only: an `.astro.mx` file is **not** a page extension (see the next
list).

Four facts worth knowing before editing `src/astro-template.ts` or
`src/vite-templates.ts`:

- **An `.astro.mx` file cannot be a page, because of Astro's router**
  (decision 134 and its addendum). Astro's route collection keys on `path.extname(basename)`, which returns only the
  **last** extension segment (`create-manifest.js`; `parse-route.js` does the
  same through `@astrojs/internal-helpers`' `fileExtension`, which is
  `path.split(".").pop()`). Measured against astro@7.3.2: a `page.astro.mx`
  under `src/pages` is routed to `/page.astro` (`.mx` is a registered page
  extension) — a literal `.astro` in the URL — and `injectRoute` cannot repair
  it. Note `dist/core/util.js`'s `endsWithPageExt` *does* use `endsWith`, so
  `isPage()` accepts what route collection rejects: two code paths in one
  version disagree. So `.astro.mx` is never registered with
  `addPageExtension`, and `src/pages-guard.ts` (called from `astro:config:setup`)
  throws a positioned error listing every `.astro.mx` file under
  `<srcDir>/pages` (it mirrors Astro's walk, `create-manifest.js:88-96`: a name
  starting with `_` and a dot-name other than `.well-known` are skipped, and
  symlinked directories are entered, with real paths tracked against cycles), with the fix: write `about.astro` and import
  the component, or write the page as `.mx`. When Astro matches the longest
  registered page extension, pages can follow with no language change.
- **This is `Emitter<string>` over core's IR.** `.astro.mx` uses `parseFragment` for
  fence-relative positions, then `lower()` and the shared `drive`/`emit`
  traversal. Astro-specific decisions happen in `HostDeclarations`; the
  emitter consumes IR and opaque `DelegatedTag.data`, never Marko nodes. `static`
  statements resolve into `Ir.hoisted` and are inserted into the fence.
- **Typing composes two maps.** The emitter records the unchanged fence,
  expressions, attribute names, `<for>` params, and whole hoisted blocks at
  their generated write offsets. `createAmxLanguagePlugin` composes those
  `.astro.mx`-to-Astro spans with `@astrojs/compiler/sync`'s `convertToTSX` map;
  only intersections surviving both stages become Volar `CodeMapping`s.
  `.astro.mx` is registered only by `{ astro: true }` and `mx-tsc --astro`.
- **The Vite mechanism is forced.** Astro's `astro:build` `transform` filters
  `include: [/\.astro$/, /\.astro\?/]` **and** re-checks
  `if (!parsedId.filename.endsWith(".astro")) return;`, so an `enforce: "pre"`
  transform on the real `.astro.mx` id can never reach Astro's compiler. The module
  id itself must end in `.astro`: `resolveId` appends that suffix to whatever
  Vite's own resolver returns, `load` returns the lowered source. Same shape
  `@mxlang/vite-plugin` already uses for `.solid.mx`.
- **An attribute method can be a `FunctionExpression` value, not `attr.arguments`.**
  `<button onClick() { … }>` arrives with `arguments` falsy and the method body
  as the attribute's *value* (measured against `@marko/compiler` 5.42.5).
  The resolver detects both shapes and lets Astro provide the target-specific
  diagnostic through `rejectAttributeMethod`.
- **`/var` on a returning tag called from the template is a structural
  host-cannot (ruled 2026-09-28, TODO `amx-tag-var`), not a missing feature.**
  Astro runs the `---` fence to completion before the template's tags are
  ever lowered or called (`component()` in `astro-template.ts`), so there is
  no statement position left anywhere — the fence has already finished, and
  the template is markup, not statements — to bind a value into. Calling the
  same tag *without* `/var` already works today: `server.ts`'s
  `renderToStaticMarkup` calls the unit's default export, which returns the
  markup (the `<return>` value lives only in `render`), deep in Astro's own
  render pass, long after the fence ran. This is not the same gap
  as the JSX-host/Solid `/var`-in-callback-scope restriction (spec's `/var`
  section, MX 2 `tag-var-in-callback-scope`) — that one is liftable by giving
  a callback scope a statement position; `.astro.mx` has no callback scope to give
  one to. The error message explains the ordering and points at the
  workaround: call the unit directly from the fence's own TypeScript, an
  ordinary function call: `X.render(input, createOut())` returns the value, and
  `createOut` comes from `@mxlang/astro/runtime`.

The lowering table and the full error list live in
`packages/hosts/astro/README.md` "AstroMX templates (`.astro.mx`)". Nothing silently
degrades: every construct this target cannot express is a build error naming
the construct, the reason and the `.astro.mx` line.

Astro projects get per-file `.mx` types from
`@mxlang/typescript-plugin`, not an ambient wildcard. The old
`packages/hosts/astro/types/mx.d.ts` and `@mxlang/astro/types` export are
deleted: they erased every component's real `Input`. Configure one Volar
plugin entry, `{ "name": "@mxlang/typescript-plugin", "astro": true }`; do
not also list `@astrojs/ts-plugin`, because the second Volar tsserver plugin is
silently skipped. Command-line checks use `mx-tsc --astro --noEmit`.
Both paths also type-check `.astro.mx` itself through the composed AstroMX plugin;
without Astro mode, `.astro.mx` files are ignored.

### Attribute tags (decisions 106–107)

This host declares `attrTags: 2`; `.astro.mx` emits only core's resolved
`attrTagProps` plan. A singular tag is a `<Fragment slot="name">`, and a
singular plan under `<if>`/`<else if>`/`<else>` becomes a conditional named
slot so Astro receives only the taken branch, including nested conditionals
and empty branches. Arrays (including a declared
`AttrTag[]` with no occurrences), attributes, params, and nested attribute
tags are positioned errors naming `@mxlang/astro`: an Astro slot is keyed by
one name and carries rendered markup only. A bodiless `<@name/>` is also an
error because there is no markup to project.

Astro's renderer gives a named slot one observable payload, `() => string`.
`renderToStaticMarkup` also installs that same thunk as its own `.content`
property, so the default data declaration and `as: "renderable"` are two views
of the same slot; no attribute data is invented. `@mxlang/astro` exports the
matching `AttrTag<C>` and `.astro.mx` inserts its type-only import when core sets
`needsAttrTagImport`.

**Fixed: `custom-tags-template-error-positions` (round 2).** A `TranslateError`
raised while compiling a tag template (`tags/x.mx`) called from an `.astro.mx`
file carries `.file`, the template's own path (spec §2's third position
rule) — and both conversion sites here dropped it. `lowerAstroMx`'s catch
(`astro-template.ts`) converted every `TranslateError` to
`new AstroTemplateError(message, line, column)` with no `file` field at
all, so the information was lost one layer before it could reach Vite.
`AstroTemplateError` now carries an optional `file`, filled from
`error.file` at that same conversion. `vite-templates.ts`'s `load` catch
then built its `.frame` from the **`.astro.mx` file's own source** unconditionally
— so a compile error raised inside a tag template was reported at build
time against the `.astro.mx` file's text at the template's line/column: a
line/column that means something in a different file, read against the
wrong one (the same "coincidence, not a mapping" failure class the
TS-plugin/language-server fix was built to close, see
`packages/tooling/typescript-plugin/AGENTS.md`). It now reads the named
`.file`'s own source through `readTemplateSource` (`vite-templates.ts`,
round 3/4) to build `.id`/`.loc`/`.frame` when one is set, falling back to
the `.astro.mx` source exactly as before when it is not. That helper guards its
own read (the named file may have vanished since the compile's own earlier
read) and takes an injectable reader for exactly that reason — see
`@mxlang/vite-plugin`'s `AGENTS.md` for the full rationale and the
engine-stack-format pitfall an earlier version of this test hit. This file
mirrors that package's copy rather than importing it, the same as its
existing `codeFrame` mirror above.

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
  `<lifecycle>`, `<script>`, `client` blocks and `<id>` are compile errors
  naming the construct (decision 71: stateful tags mean whatever the host
  says, and this host has no reactive target at all). That required the one
  change to `@mxlang/vite-plugin` this package needed: a `strict?: boolean`
  option on `MxPluginOptions`, passed straight through to `compile()`. It is a
  passthrough, not a policy of the plugin's own; `.solid.mx` never goes
  through the translator and is unaffected.
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

### `.amx`: AstroMX templates (decisions 76c, 78)

An `.amx` file is an **Astro component whose template is MX** — a different
file kind from `.mx`, not a variant of it. A `.mx` component compiles to a
runtime-free `(input) => string` and is called *through* this package's
renderer; an `.amx` component **becomes** an Astro component: the `---` fence
passes through byte for byte with Astro's own semantics (`Astro.props`,
imports, `getStaticPaths`), the MX template after it is lowered to Astro
template syntax, and the whole file goes to Astro's compiler. Components,
layouts and pages, all from one extension (`addPageExtension(".amx")`).

Four facts worth knowing before editing `src/astro-template.ts` or
`src/vite-templates.ts`:

- **The extension is single-dot because of Astro's router, not taste.**
  `.astro.mx` was the first spelling and works for components, but Astro's
  route collection keys on `path.extname(basename)`, which returns only the
  **last** extension segment (`create-manifest.js`; `parse-route.js` does the
  same through `@astrojs/internal-helpers`' `fileExtension`, which is
  `path.split(".").pop()`). Measured against astro@7.3.2: a `page.astro.mx`
  under `src/pages` is `continue`d as an unsupported file type, and once `.mx`
  is also registered it is routed to `/page.astro/` — a literal `.astro` in
  the URL. Note `dist/core/util.js`'s `endsWithPageExt` *does* use `endsWith`,
  so `isPage()` accepts what route collection rejects: two code paths in one
  version disagree. `.amx` sidesteps all of it.
- **This is `Emitter<string>` over core's IR.** `.amx` uses `parseFragment` for
  fence-relative positions, then `lower()` and the shared `drive`/`emit`
  traversal. Astro-specific decisions happen in `HostDeclarations`; the
  emitter consumes IR and opaque `HostTag.data`, never Marko nodes. `static`
  statements resolve into `Ir.hoisted` and are inserted into the fence.
- **Typing composes two maps.** The emitter records the unchanged fence,
  expressions, attribute names, `<for>` params, and whole hoisted blocks at
  their generated write offsets. `createAmxLanguagePlugin` composes those
  `.amx`-to-Astro spans with `@astrojs/compiler/sync`'s `convertToTSX` map;
  only intersections surviving both stages become Volar `CodeMapping`s.
  `.amx` is registered only by `{ astro: true }` and `mx-tsc --astro`.
- **The Vite mechanism is forced.** Astro's `astro:build` `transform` filters
  `include: [/\.astro$/, /\.astro\?/]` **and** re-checks
  `if (!parsedId.filename.endsWith(".astro")) return;`, so an `enforce: "pre"`
  transform on the real `.amx` id can never reach Astro's compiler. The module
  id itself must end in `.astro`: `resolveId` appends that suffix to whatever
  Vite's own resolver returns, `load` returns the lowered source. Same shape
  `@mxlang/vite-plugin` already uses for `.solid.mx`.
- **An attribute method can be a `FunctionExpression` value, not `attr.arguments`.**
  `<button onClick() { … }>` arrives with `arguments` falsy and the method body
  as the attribute's *value* (measured against `@marko/compiler` 5.42.5).
  The resolver detects both shapes and lets Astro provide the target-specific
  diagnostic through `rejectAttributeMethod`.

The lowering table and the full error list live in
`packages/hosts/astro/README.md` "AstroMX templates (`.amx`)". Nothing silently
degrades: every construct this target cannot express is a build error naming
the construct, the reason and the `.amx` line.

Astro projects get per-file `.mx` types from
`@mxlang/typescript-plugin`, not an ambient wildcard. The old
`packages/hosts/astro/types/mx.d.ts` and `@mxlang/astro/types` export are
deleted: they erased every component's real `Input`. Configure one Volar
plugin entry, `{ "name": "@mxlang/typescript-plugin", "astro": true }`; do
not also list `@astrojs/ts-plugin`, because the second Volar tsserver plugin is
silently skipped. Command-line checks use `mx-tsc --astro --noEmit`.
Both paths also type-check `.amx` itself through the composed AstroMX plugin;
without Astro mode, `.amx` files are ignored.

### Attribute tags (decisions 106–107)

This host declares `attrTags: 2`; `.amx` emits only core's resolved
`attrTagProps` plan. A singular tag is a `<Fragment slot="name">`, and a
singular plan under `<if>`/`<else if>`/`<else>` becomes a conditional named
slot so Astro receives only the taken branch. Arrays (including a declared
`AttrTag[]` with no occurrences), attributes, params, and nested attribute
tags are positioned errors naming `@mxlang/astro`: an Astro slot is keyed by
one name and carries rendered markup only.

Astro's renderer gives a named slot one observable payload, `() => string`.
`renderToStaticMarkup` also installs that same thunk as its own `.content`
property, so the default data declaration and `as: "renderable"` are two views
of the same slot; no attribute data is invented. `@mxlang/astro` exports the
matching `AttrTag<C>` and `.amx` inserts its type-only import when core sets
`needsAttrTagImport`.

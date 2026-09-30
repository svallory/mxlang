# parser — agent instructions

## MX parser

`packages/parser` vendors `@babel/parser` 7.29.8 and forks one method of its JSX plugin so `<` in expression position is parsed as MX. Entry points:

- `parse(source, filename, options?)` — parses `.solid.mx`, returns a Babel `File` of standard node types only (MX facts go in `node.extra.mx`). The parser imports no host: every MX region is lowered by whichever `mxRegionCompile` hook the caller supplies — for `.solid.mx`, that is `@mxlang/solid`'s `compileSolidMx`, passed explicitly by every caller — before being re-parsed and spliced back in. See "`@mxlang/solid`: the Solid host on `@mxlang/core`" in `packages/hosts/solid/AGENTS.md` for that lowering, and `packages/parser/README.md` for this package's own, now-narrower job (region discovery only).
- `parseBabel` / `parseBabelExpression` — the untouched vendored `@babel/parser` surface, for plain `.ts`/`.tsx`.

MX parsing is opt-in through the `mx` parser option, which `parse` sets. Without it the vendored parser is byte-equivalent to npm `@babel/parser` — `src/vendored.test.ts` pins that, so keep those tests on `parseBabel` rather than `parse`. `packages/parser/UPSTREAM.md` "Local modifications" records exactly what the fork changed.

Consumers typecheck against `src/public.d.ts`, not `src/index.ts`: the vendored tree needs tsconfig relaxations that must not leak into packages that merely call `parse`. The package's published `types` is `dist/index.d.ts`, which `scripts/emit-declarations.ts` generates from `src/public.d.ts` (the `declare module` wrapper unwrapped, statements unchanged) as part of `bun run build`; `files` is `dist` + `README.md`, and `src/pack-contents.test.ts` pins the tarball contents and that the two export lists match. Edit `src/public.d.ts`, never `dist/`.

A host can reject an MX region's syntactic position (e.g. Angular's `.ng.mx` only allowing one as `@Component({ template: … })`'s value) through the `mxRegionPositionCheck` parser option — see `packages/parser/README.md` and `src/mx/region-context.ts`.

`<>…</>` is a TSX fragment by default. The `mxRegionFragment` option (off; `.ng.mx` turns it on) makes it an MX **fragment region** instead: `jsxParseElementAt` sends `<>` to the bridge, `walkMxRegion(..., { fragment: true })` walks it as a synthetic dynamic-named root (htmljs has no nameless open tag, and a static root ignores `</>`), and the host gets the children with `fragment: true` on `MxRegionCompileInput` (the replaced span is `<>`+source+`</>`). Separately and unconditionally, `noteSiblingRoot` (bridge) records a well-formed root that directly follows a region, and `parse` (`babel/index.ts`) rewrites a *Babel* failure that lands inside it to `MxErrors.MultipleRoots`. It never rewrites an MX-raised error (`syntaxPlugin === "mx"`: TypeScript's generic-arrow retry re-enters the bridge and leaves stale hints) and never rejects input that parses.

A host claims the **lowering** of each region through the `mxRegionCompile` parser option, on the same options-bag channel: the bridge hands it the region text, filename, base position and the surrounding module's `importSpecifiers`, and takes back `{ code, hoistedImports?, returnVars?, dependencies? }`. Imports are collected by a declaration-only pre-pass whose region compiler returns `null`, so imports after a region are visible without running host lowering twice. Before compiling a region, the bridge removes imported local names shadowed by an active non-program lexical scope; a function parameter or local binding named like an import must never resolve that import as a custom-tag callee. Region dependencies ride the accepted region root (like hoisted imports, so speculative parses cannot leak them); `print`/`printAst` return their deduplicated union. **`mxRegionCompile` is required whenever the grammar is on** (`.solid.mx` by name, or `mx: true`): the parser has no host of its own and no default, so an absent hook is a positioned compile error at the first region, naming the option and pointing at `compileSolidMx` from `@mxlang/solid` for `.solid.mx`. `print` forwards `mx`/`mxRegionCompile` to `parse` unchanged (`printAst` takes an already-parsed AST, so it has no `parse` call to forward through). `parse` also honours an explicit `mx?: boolean` gate, since a `.ng.mx` filename never matches its `.solid.mx` extension test. See `src/mx/region-compile.ts` and `UPSTREAM.md` item 8.

**A type the host generated has no location.** A host's emitted region is one line; the authored region may span several. `remapExpressionLocations` (`src/mx/bridge.ts`) moves nodes inside a copied expression back to their source span and leaves the rest at their generated offsets, which can name any later source line. For the type of a generated `satisfies`/`as` (one outside every matched expression) the bridge removes the location instead. `print` retains lines, and `@babel/generator` may not break a line between a type's name and its type arguments, so when those two landed on different lines it parenthesized the arguments: `NonNullable(\n<Parameters<...>>)`, which is not TypeScript. Measured on `main` `cbe607f4` as well, where a declared `AttrTag[]` in a multi-line region prints its type with line breaks inside it and stays valid only because none falls between the name and its arguments. A `satisfies` the author wrote inside `${...}` is inside a matched expression and keeps its location.

Two syntax decisions are settled and encoded in `@mxlang/solid`'s lowering (`packages/hosts/solid/README.md`'s table is the authoritative version; this is the summary):

- **Whitespace follows Marko, not JSX.** A whitespace-only text run containing a newline is dropped entirely, so indented markup renders nothing between children; a whitespace-only run without a newline collapses to one space. `${" "}` is the escape hatch. Comments are dropped from the output and do not count as content when trimming. This is Marko's own `onText` rule (decision 33), the same one every host relies on — see the four Marko facts below.
- **Void elements need no slash.** `<input value=x>` parses. The set (`area base br col embed hr img input link meta param source track wbr`) is declared to htmljs-parser as `TagType.void`; a void tag written with a closing tag is a parse error.
- **Shorthand `class` merges with a string or an object; anything else is a parse error.** Shorthand plus a *string* `class="x"` merges to `class="card x"` (shorthand first). Shorthand plus an **object literal** merges to Solid 2's array form, `class={["card", {...}]}`, the string entry always-on and the object toggling; a static `class="x"` present as well folds into that string entry (`class={["card x", {...}]}`) rather than being emitted as a second `class` attribute. Shorthand plus any *other* dynamic `class=` expression (an identifier, a call, a ternary) is a parse error. `#id` shorthand combined with an explicit `id=` is a parse error. `style=` only accepts an object-literal value (`style={color: c()}` → `style={{color: c()}}`); any other `style=` expression is a parse error for v1.
- **Tag params and attribute tags are generic, not control-tag-only**
  (decision 51), for any tag Marko itself accepts them on — decision 72's
  subset rule (`divergences.md`) removed the cases real Marko rejects (tag
  params on `<if>`, tag params and attribute tags on native HTML elements).
  `<Tag|p1, p2|>body</Tag>` lowers to `<Tag>{(p1, p2) => body}</Tag>`, which is
  what lets Solid's own render-prop components be called from MX
  (`<For|item, i| each=xs()>`, `<Show|u| when=user()>`). Inside a component,
  `<@name>body</@name>` becomes the prop `name={body}`, and `<@name|p|>`
  becomes `name={(p) => body}`; ordinary children stay the child callback, and
  props are emitted as the parent's own attributes in source order followed
  by the attribute tags in source order. `<try>` is expressed *on top of*
  this in `@mxlang/solid`'s `resolveHostTag`: it reads `<@catch>`/
  `<@placeholder>` out of the same attribute-tag resolution every other tag
  uses, so the special and generic paths cannot drift. An attribute tag whose
  name is already an attribute on the parent is a parse error rather than a
  second `name=` the last writer wins — and `children` counts, since ordinary
  children lower into that prop, so `<@children>` beside any ordinary child
  collides too.
- **Tag params (`|a, b|`) come before `=value`.** `<if|u|=user()>`, not `<if=user()|u|>` — the latter parses but folds `|u|` into the condition expression and reports no params, matching `<for|item, i| of=...>`'s own order. `notes/solidmx-spec.md` §5.1 writes `<if=user()|u|>` as loose prose; the real grammar is params-first.

## `.mx` is the only template extension (decisions 72, 2026-09-15)

Decision 68 retired the old `.mx` *dialect* (required explicit imports,
`<fragment>`, required `export interface Input`, lowercase-by-scope) —
`@mxlang/html` and `packages/mx-html` stay deleted, and those conventions do
not come back. Decision 72 re-establishes `.mx` as MX's own **identity**,
distinct from that dialect: MX is its own language with Marko as its origin,
and MX 1.0 is a strict subset of Marko syntax — every MX 1.0 file is a valid
Marko file with the same meaning for the structural core.

**Decision 2026-09-15 (Saulo) superseded decision 72's `.marko` alias**:
no product path of MX accepts or advertises `.marko` any more — MX only
supports the MX 1.0 subset of Marko syntax, so treating an arbitrary
`.marko` file as MX would silently claim support it does not have. `.mx`
(plus `.solid.mx` and `.amx`, different file kinds) is the only template
extension across every host loader (`@mxlang/html/bun`, `@mxlang/hono/bun`,
`@mxlang/vite-plugin`), the language server, the TypeScript plugin/`mx-tsc`,
and the VS Code/Zed extensions. Porting a Marko component that stays within
the MX 1.0 subset is a rename. `@marko/compiler`'s own `tags/` auto-discovery
convention (`tagDiscoveryDirs: ["tags"]`, used by `@mxlang/html` and
`@mxlang/preact`) is the one narrow exception that still touches real
`.marko` files: `@marko/compiler`'s `scanTagsDir` only discovers files whose
*actual* extension is `.marko` (measured in 5.42.5's `loadTaglibFromDir.js`,
`ext === ".marko"`) — a `.mx` file placed in a `tags/` directory is not
discovered at all. This is Marko's own compiler behavior during a whole-file
`.mx` compile, not a second entry point MX advertises.

The oracle (`packages/oracle`, `packages/hosts/html/fixtures-marko/*`) still
keeps its 43 stock fixtures as real `.marko` files, because Marko's own
compiler and its `tags/` scan only accept `.marko` — but it feeds them to MX
by reading the file content and compiling under a virtual sibling `.mx`
filename in the same directory (`translator-render.ts`'s `renderTranslator`),
not by the real `.marko` path. `tags/*.marko` fixture files stay on disk as
real `.marko` (Marko's own discovery convention above), and every other
fixture `.marko` file's `from "./x.marko"` imports are rewritten for the MX
side the same way the oracle already rewrites them to `.ts`. `.solid.mx` is
unaffected either way — a different file kind (TSX with MX regions), never
covered by the `.marko` alias in the first place.

- `parse(source, filename)` in `@mxlang/parser` — a `.solid.mx` file: a
  TypeScript module in which `<` in expression position opens an MX element,
  lowered to Solid 2 JSX by `@mxlang/solid` (see below). This is the parser
  package's only mode; there is no `mxMode` option. SolidMX is a separate
  host from the vanilla one below, and is not affected by `.mx` being the
  only template extension or by decision 68's dialect retirement.
- `compile(source, filename)` in `@mxlang/html` — a whole-file MX
  template (`.mx`, stock Marko syntax with no dialect layered on top).
  `@marko/compiler` parses, validates and supplies the tag registry; the
  package supplies only a translator (`packages/hosts/html/src/translate.ts`)
  and its own taglib (`packages/hosts/html/taglib/marko.json`).
  `@mxlang/parser` is not on this path at all. `compile()`/`compileFile()`
  themselves do not gate on the filename extension (it is inert in
  `@mxlang/core`'s `compileSource` too — the extension check lives at the
  loader boundary instead); the Bun loader (`@mxlang/html/bun`) and
  `@mxlang/vite-plugin`'s `mx()` both accept only `.mx`, excluding
  `.solid.mx`.

Four Marko facts that are easy to get wrong (all measured against
`@marko/compiler` 5.42.5, all cost real debugging time):

- **Marko's `onText` already implements decision 33.** `<p>\n  a\n</p>` gives
  `MarkoText "a"` — a whitespace-only run containing a newline is dropped —
  and `a   b` gives `"a b"`. The string translator therefore does **not**
  re-normalize, and does not call `normalizeText()`. Do not add a second
  normalization pass on that path; it would double-collapse.
- **`import` / `static` / `export` parse as *tags*, not statements**, whose
  attributes are the remaining words. To recover the statement text, slice by
  **`loc` line/column**: `start` and `end` are **`undefined`** on these nodes.
  (An earlier version of this file said "the tag's range is the statement's
  source span" — true of `loc`, not of `start`/`end`.) Import binding names
  are then re-parsed with `parseBabel`, never regex-scraped.
- **A bare top-level `${expr}` line is a `MarkoTag` whose `name` is the
  expression**, not a `MarkoPlaceholder` — concise mode has no other shape for
  it, and it is the dynamic-tag construct, the same as the tagged
  `<${expr} .../>` form: `@mxlang/core`'s `lowerTag` routes both shapes to a
  claiming host's `HostTag` (`shape` "bare"/"tagged"), or, when no host
  claims `DYNAMIC_TAG`, to a `Component` with a dynamic target. Marko's own
  fixture `error-dynamic-tag-name`
  (`packages/hosts/html/fixtures-marko/error-dynamic-tag-name/`) is the
  proof: `static const tagName = "hello world"` then `${tagName}` at column 0
  fails at render with "Invalid tag name" — it compiled to a dynamic tag, not
  a placeholder. Text on its own line needs the escape hatch, `-- ${x}`. A
  placeholder inside an HTML-syntax body (`<div>${x}</div>`) is unrelated: it
  parses as a real `MarkoPlaceholder`, never a `MarkoTag`, and never reaches
  `lowerTag` at all. See `divergences.md`'s "Fixed: undocumented divergence
  in the bare `${expr}` line" for the history — MX 1.0 used to treat every
  unclaimed bare shape as a silent interpolation, which was never a
  documented divergence from Marko.
- **`<!doctype html>` arrives as a `MarkoDocumentType` node** whose `value` is
  `doctype html` (delimiters stripped), so it is re-emitted as `<!${value}>`.
  Marko strips comment delimiters too, which is why an HTML comment and a `//`
  line comment are told apart by re-reading the source at the node's `loc`.

`@mxlang/html`'s translator (`translate.ts`'s dispatch) decides
component-vs-HTML dispatch by **in-scope binding, not case**: a tag name
matching an `import`, a `<define>`, or a tag Marko discovered via taglib/
`tags/` is a component call whatever its case; anything else is an HTML
element (Marko's own registry) whatever its case, hyphenated custom elements
included. This is Marko's own rule (custom tags are lowercase there), not an
MX invention. `import layout from "./layout.marko"` then `<layout>` calls the
component; `<my-widget>` with no matching binding stays a literal element. A
capitalized tag with no matching binding is a compile error, not a literal
element — no HTML element is ever capitalized. Import binding names are
extracted by parsing the hoisted import line with `parseBabel` (default,
namespace, named, aliased, and combined forms), not by regex. An unbound
*lowercase* tag that is neither hyphenated nor a real HTML/SVG/MathML element
is a translate error naming it, rather than silently rendering as an unknown
custom element. SolidMX's own PascalCase-means-component convention
(`packages/hosts/solid/src/emitter.ts`'s `isComponent`) is unrelated and
unchanged by this — it follows JSX, and is a separate host on a separate
lowering path.

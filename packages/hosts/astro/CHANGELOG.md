# Changelog

- **Fix (render-sink, decision 155):** the page wrapper (`wrapAsPage`) moves the compiled module's `NAME.render = __mxRender;` line along with the rename to `__mxRenderPage`. Without that, an `@mxlang/html` module from decision 155 would reference a removed binding when it loaded.

- **Fix (solid-astro-angular-primitive-attr-parity, decision 149):** dynamic native attributes and spread keys in `.astro.mx` go through `__mxAttrOut`, so primitives render as Marko does: `false` omitted and `true` bare on data/aria/title/value, falsy `class`/`style` omitted and `true` printed as `"true"`, and Astro's boolean-attribute names present for everything but null/undefined/false (presence only, see divergences.md). Static attributes are unchanged.

- **Fix (astro-html-comment-literal-element):** `<html-comment>` lowers to a real `<!--…-->` instead of a literal `<html-comment>` element (with `${x}` left as `{input.x}`). It matches Marko 6.3.51: only `>` is escaped, falsy values render nothing except `0`, an all-placeholder comment that renders empty is `<!-- -->`, and a value that renders as `[object Object]` throws, as Marko's debug build does (optimized Marko prints it). A nested `<!-- -->` is kept as text with its `>` escaped. `<textarea ...x set:html=…/>` is refused like every other element.

- **Fix (astro-textarea-value-content):** `<textarea value=x/>` renders the value as escaped content, as Marko does, instead of a `value` attribute on an empty textarea. A spread's `value` is split out at render time, a spread's `value` yields to a body, `value` with a body is a build error, and a textarea body is raw text (a literal `<` no longer crashes the Astro compiler). Dynamic tags stay unsupported on this host.

- **Test (html-imported-return-tag-object-object):** `imported-return-render.test.ts` renders an `.astro.mx` page that imports a `.mx` tag declaring `<return>` and calls it without `/var`, through Astro's compiler, container and the MX renderer: markup rendered, value dropped. `server.test.ts` pins the renderer's own unwrap. No code change.

- **Fix (marko-parity-trio, `:modifier`):** `<div :foo="y"/>` in a template body emits `value:foo={y}`, which the real Astro compiler renders as `value:foo="y"`; MX previously rejected the form.

## Unreleased

- **Fix (default-tag-contracts r3):** a `.astro.mx` template refuses a contract's dashed `defaultTag` (`sl-card`), as `astro-html`'s registration does, so the two agree.

- **Fix (default-tag-contracts r2):** the `.astro.mx` Vite plugin reports an invalid contract `defaultTag` once at its declaration.

- **Added (default-tag-contracts, decision 145):** the parent contract's `defaultTag` is the first rung for the unnamed tag in `.astro.mx` templates.

- **Fix (default-tag-ladder r2):** the `.astro.mx` Vite plugin validates `mx.astro-html.defaultTag` (`astroDefaultTag`) and warns once at the `package.json` value.

- **Added (default-tag-ladder, decision 145):** the descriptor declares the html target's `defaultTag`; the `.astro.mx` template lowering answers `mx.astro-html.defaultTag` first, then `div` (`lowerAstroMx` takes `defaultTag`; the Vite template plugin reads the package's key, unchecked: it cannot reach the registry's `invalid-default-tag` check).

- **Feat (default-tag-core, decision 145):** declares `resolveDefaultTag: () => "div"`, the interim answer for the unnamed tag until the registry ladder lands. Output is byte-identical.

- **Fix (astro-fence-top-level-return):** a top-level `return` in a `.astro.mx` `---` fence — `return Astro.redirect("/")`, the documented Astro redirect — no longer fails with ``syntax error in the `---` fence: 'return' outside of function``. Astro compiles the fence into the component function's body, so the return is legal there; MX parsed the fence as a plain ES module, where it is not. The fence's three parses (`sourceBindings`, `unknownSourceBindings`, core's `checkReservedSource`) now allow it, for the Astro fence only. The relaxation cannot be scoped by wrapping the fence in a function body instead: the fence's imports and top-level `const`s share module scope with the template, so wrapping would strand the template's `${…}` references.

  A fence syntax error now also reports the **file** position in its message text, 1-based in both line and column (#227), where it previously printed Babel's fence-relative one and pointed at the opening `---`. A break on the fence's third content line reports `(4,11)`. The structured `line`/`column` are unchanged, and both reporters (`mx-tsc`, Vite) still print one position, not two. Real Astro compiler/container renders pin both.

- **Fix (range-loop-name-collision):** a `<for from/to>` mapper's own parameters are named `__mxUnused`/`__mxIndex` instead of `_`/`$i`. Both are in scope for the authored `from`/`to` expressions written inside the same callback, so a fence binding of the same name was shadowed and the loop rendered `NaN` once per row. `until=` alone was never affected. Pinned by real Astro compiler/container renders.
- **Fix (reserve-mx-identifiers):** frontmatter bindings beginning with `__mx` receive core's shared positioned reservation error before generated native-attribute helpers are injected. Template bindings are checked by core too; ordinary property names remain legal.

- **Fix (attr-value-parity review):** native guards are hoisted once into frontmatter, with authored mapping offsets retained. Ordinary function/symbol values receive Marko debug errors; null/false serialization remains unchanged.

- **Fix (attr-value-parity):** ordinary native attributes in `.astro.mx`, including computed plain colon-name attributes and final merged spreads, reject unrenderable objects with Marko's render-time diagnostic. Authored expressions evaluate once; class/style, controlled writers and component props are unchanged. Real Astro compiler/container renders pin the fix.

- **Fix (colon-attr-followups round 3):** ordinary native `define:`, `is:`, `transition:`, `client:` and `server:` names and the exact `slot` attribute render as escaped plain attributes through computed spreads, not Astro directives or implicit slot projection. Refuse `set:html`/`set:text`, directive-shaped component props and special style/script/slot contexts at the authored name when plain Marko semantics cannot be preserved. Real Astro container tests pin the behavior; MX-generated directives are unchanged.

- **Fix (scriptlet-hint-let-var):** `.astro.mx` fence advice preserves the original `let`/`var` keyword, not `const`. Ordinary `.mx` under strict policy omits keyword advice for mutable scriptlets; both paths still reject `<let>`. `$ const` advice is unchanged.

- **Fix (jsx-whitespace-body-parity, decision 141):** `.mx` templates rendered inside Astro now pass same-line whitespace-only content through imported components and discovered `tags/*.mx`, rendering one space through Astro's renderer. Uses core's host-independent body-presence correction; newline indentation stays absent. Pinned by the Astro compiler and container's rendered output.

- **Changed (refactor/target-open-set, decision 137):** `mxTemplates()` excludes a dotted tag file name from the tag map with a positioned diagnostic but leaves peer `mx.tags[].hosts` restrictions unresolved without a warning; only full-registry tooling validates host names (PR 3 round-2 ruling); package specifiers stay silent. It takes an optional `targets` lookup (default: this package's own descriptor), and `lowerAstroMx` accepts `options.targets`.

- **Added (fix-hints-batch round 2):** a `$` scriptlet that declares a value now says to declare it in the `---` fence (`const y = …;`), since a template rejects `<const>` (new optional `scriptletReplacement` host declaration).

- **Added (fix-hints-batch, audit item 14):** an unresolved capitalized tag now ends ``Import it in the `---` fence (`import Card from "./Card.astro"`) or add `tags/Card.mx`.`` (or ``Did you mean `<Badge>`?`` for a near-miss fence import).


- **Breaking (amx-to-astro-mx, decision 134):** the Astro template file kind is renamed from `.amx` to `.astro.mx`, like `.solid.mx` (`<name>.<host>.mx`). No `.amx` alias: a `.amx` file is no longer an MX file. `ASTRO_MX_EXT` is `.astro.mx`, the diagnostic and language id is `astromx`, and `.astro.mx` is no longer registered with `addPageExtension`.

- **Added (amx-to-astro-mx, decision 134 addendum):** an `.astro.mx` file under the pages directory (`src/pages`, or the configured `srcDir`) is now an error from the integration, in `astro dev` and `astro build`, listing every offending file at `path:1:1`. Astro strips only the last extension, so `about.astro.mx` routes to `/about.astro`. The message gives the fix: write `about.astro` and import the `.astro.mx` component from it, or write the page as `about.mx`. `.mx` pages are unaffected. New: `findAstroMxPages`, `assertNoAstroMxPages` (`src/pages-guard.ts`).

- **Added, unstable (target-registry, decisions 129 and 132):** `./descriptor` subpath exports the `astro-html` target descriptor (host `astro`, `strict: "always"`, html's declarations, a `typeSurface`, and `load()` returning `@mxlang/html`'s `compile`). `src/type-surface.ts` holds a copy of `@mxlang/typescript-plugin`'s `createAstroTypeSurface`; the registry's parity test pins the two. The Astro template (`.astro.mx`) is a file kind of the `astro` host (decision 134): segment `astro`, language id `astromx`, diagnostic source `astromx`, no region compile and no callee reader. Nothing consumes it yet; see `@mxlang/target-registry`.

- **Fix (dup-attr-last-wins-core round 2, decision 135):** an element with a spread now folds its attributes into one spread object in authored order (`<div {...{ "a": 1, ...x, "a": 2 }}>`), because Astro rendered `a={1} {...x} a={2}` as three `a` attributes and a browser kept the first. Components and spread-free elements are unchanged. The `<input>` `value`-first reorder moved from the `orderAttrs` hook to emission. Pinned by `src/dup-attr-render.test.ts`, which renders through Astro's own compiler and container.
- **Fix (dup-attr-last-wins-core round 2, decision 135):** an element with a spread now folds its attributes into one spread object in authored order (`<div {...{ "a": 1, ...x, "a": 2 }}>`), because Astro rendered `a={1} {...x} a={2}` as three `a` attributes and a browser kept the first. Components and spread-free elements are unchanged. The `<input>` `value`-first reorder moved from the `orderAttrs` hook to emission. Pinned by `src/dup-attr-render.test.ts`, which renders through Astro's own compiler and container.

- **Fix (dup-attr-last-wins-core round 3, decision 135 addendum):** on the folded (spread) path a structured `class={...}` is rendered into the plain `class` key as `class:list` would, instead of a separate `class:list` key, so a spread's `class` and this one are one key and the merge is real (`<div ...x class={a: true}>` is `class="a"`, `<div class={a: true} ...x>` is `class="from-x"`, as in Marko). `class:list` stays for an element without a spread.

- **Fix (dup-attr-last-wins-core round 2, decision 135 and its spread-precedence addendum):** attributes written after a spread now win over the spread, as in Marko (`<div ...x id="p">` renders `id="p"` even when `x.id` is set; it used to print both and a browser kept the spread's). Emitted attribute order may change. an element with a spread now folds its attributes into one spread object in authored order (`<div {...{ "a": 1, ...x, "a": 2 }}>`), because Astro rendered `a={1} {...x} a={2}` as three `a` attributes and a browser kept the first. Components and spread-free elements are unchanged. The `<input>` `value`-first reorder moved from the `orderAttrs` hook to emission. Pinned by `src/dup-attr-render.test.ts`, which renders through Astro's own compiler and container.

- **Fix (dup-attr-last-wins-core, decision 135):** a repeated attribute now emits only the last; before, both were emitted as authored. The earlier occurrence gets a positioned warning naming the surviving one. See `@mxlang/core`.

- **Breaking (delegated-tag-rename, decision 132):** follows the `@mxlang/core` rename of `claimsTag`/`resolveHostTag`/`HostTag`/`ctx.build.hostTag` to `isDelegatedTag`/`resolveDelegatedTag`/`DelegatedTag`/`ctx.build.delegatedTag`; the host's `Emitter.hostTag` method is now `delegatedTag`. No output or diagnostic change.

- **Fix (audit-02-for-by-parity):** `<for by=x.id>` (any read of a loop param in `by=`) is now a positioned error, as in Marko 6.3.51, instead of passing silently. See `@mxlang/core`.

- **Fix (audit-01-prop-attr-parity):** an attribute name outside Marko's grammar (`[prop]=`, `#ref`, `*ngIf`) is now a positioned "Invalid attribute name" error, as in Marko 6.3.51, instead of passing through. See `@mxlang/core`.

### Docs: `/var` on a returning tag from `.amx` explains why, and shows the workaround (amx-tag-var)

The `/var` refusal on a returning tag called from an `.amx` template previously read as an unshipped feature ("is not supported in `.amx` yet"). Ruled 2026-09-28: it is a structural host limit, not a missing one — Astro runs the `---` fence to completion before the template's tags are ever lowered or called, so there is no statement position left, in the fence or the template, to bind a value into. The message now says why and points at the route that already works: calling the unit directly from the fence's own TypeScript, an ordinary function call since a `.mx` unit compiled for this host still exports the plain `{ value, output }` shape. Documented in the language spec's `/var` section, this package's README and AGENTS.md, and a new pinned test alongside the existing `astro-template.test.ts:689-720` cases. No behavior change — the refusal itself is unchanged, only its wording.

### Added

- Attribute-tag IR v2 support for singular named slots, including mutually
  exclusive `<if>`/`<else if>`/`<else>` branches, the Astro-specialized
  `AttrTag<C>` type, and its automatic `.amx` type import.

### Fixed

- **`source-bindings-silent-parse-failure` (filed from the PR #156 review):**
  a syntax error in the `---` fence used to be silently swallowed by
  `sourceBindings`, treating the fence as binding nothing — so every
  capitalized tag in that file, including a genuinely imported one,
  misreported "Unable to find entry point for custom tag" instead of the
  real syntax error. `lowerAstroMx` now surfaces the fence's own parse
  error (`AstroTemplateError`, positioned at the actual broken line/column
  in the file) when `sourceBindings` reports one, instead of silently
  falling through to component resolution with no bindings. No downstream
  layer had reported it yet at that point — `lowerAstroMx` never runs
  Astro's own compiler itself, so there is no risk of a duplicate
  diagnostic for the same error.
- `rejectUnknownTag`'s Marko-wording message now comes from `@mxlang/core`'s
  `unresolvedCustomTagMessage` instead of a hand-copied literal. No
  behavior change.

### Changed

- **Behavior change (local extension of decision 116, firstmate's ruling):**
  a `---` fence binding used as a tag now classifies the same way `.solid.mx`
  does — `@mxlang/parser`'s new `unknownSourceBindings` marks a non-import
  `const`/`function`/`class` whose value isn't statically a function/arrow/
  class as "unknown". A function-like fence binding (the common case) is
  entirely unaffected. Astro has no dynamic-tag construct at all (unlike
  every other host, `component()`'s own pre-existing guard rejects any
  non-`"name"` target unconditionally), so an unknown binding now fails at
  MX compile time with its own named error — `` `<Tag>` is bound in the
  frontmatter to a value MX can't prove is a component, and @mxlang/astro
  can't render a tag name decided at runtime. `` — instead of the
  pre-existing silent misroute (a literal `<Tag>` JSX reference that failed
  only at Astro's own render time with an opaque `NoMatchingRenderer`-class
  error).

- Named slots now expose both the callable renderable view and the default
  data view's `.content` thunk to `.mx` components. Arrays, attributes,
  params, and nested attribute tags remain positioned host errors because an
  Astro slot is keyed only by name. Nested conditionals and empty branches now
  emit valid Astro expressions, and bodiless tags are rejected because they
  have no markup to project.
- **Behavior change (decision 114 parity, `unresolved-tag-jsx-astro-angular`):**
  `<TotallyUndefined/>` — a capitalized tag with no `---` fence import,
  binding, or taglib entry — now fails to compile with Marko's own error
  ("Unable to find entry point for custom tag `<TotallyUndefined>`."),
  matching `@mxlang/html` and `@mxlang/solid`. `isComponent` used to be a
  bare `/^[A-Z]/` casing test, so every capitalized `.amx` tag resolved as a
  component whether or not the fence actually imported it. `lowerAstroMx`
  now parses the fence's own top-level value bindings
  (`@mxlang/parser`'s `sourceBindings`, new dependency) into `ctx.imports`
  before lowering — the same operator-ruling extension decision 114 already
  gave `.solid.mx`'s surrounding module — so a fence `import Card from
  "./Card.astro"` still resolves `<Card/>` exactly as before; only a
  genuinely undeclared capitalized tag now errors instead of silently
  compiling. A type-only fence import does not resolve a tag either
  (decision 114/115). `<Fragment>` — the one Astro built-in the real
  compiler auto-imports (`@astrojs/compiler-rs`, astro@7.3.2; measured, the
  only such name) — resolves with no fence import needed.

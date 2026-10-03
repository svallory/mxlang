# Changelog

## Unreleased

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

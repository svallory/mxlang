# @mxlang/tsx-bridge changelog

## 0.1.0-alpha.38 — 2026-11-17

- **Changed (attr-tag-prototype):** Every value host (html, Preact, React, Hono, Solid) now passes a callee Marko's attribute-tag record for `<@name>`: the first occurrence's attributes plus `content`, with every later occurrence reachable through iteration and through `map`, `filter`, `length`, `at` and `toArray` on its prototype. The value no longer depends on the callee's `Input`: repeated, conditional and looped occurrences fold into one record in source order, nested attribute tags are records, a bodiless occurrence has no `content`, and a dynamic tag given a record renders its `content` (nothing of its own for a bodiless one, as in Marko). The helper is core's `ATTR_TAG_RUNTIME`, inlined once per module that uses it. `AttrTag<T>` now takes the occurrence's attributes (`AttrTag<{ label: string }>`, `AttrTag<{ content: (row: Row) => … }>`) and is assignable to `Marko.AttrTag<T>`; the `{ as, attrs, params }` config form, `AttrTagProp` and `HostDeclarations.attrTags` are deprecated and read by nothing. The diagnostics that came from reading the callee's `Input` (missing or repeated attribute tags, undeclared tags, params mismatches, unreadable callees) are gone; a typed callee's `AttrTag` props are checked by TypeScript in `mx-tsc` and the editor plugin, at the attribute, or at the tag name for a missing attribute and for a repeated or conditional tag. Astro and Angular project from `attributeTagTree`. Solid's own components (`<Show>`, `<Switch>`, `<For>`, `<Repeat>`, `<Loading>`, `<Errored>`) still take a lone, attribute-free `<@fallback>` as its `content`; any other library component given `<@fallback>` receives the record, so pass `fallback=` instead.
- **Fixed (babel-fork-third-party-notices):** The `@mxlang/tsx-bridge`, `@mxlang/host-angular`, `@mxlang/typescript-plugin`, `@mxlang/language-server` and `@mxlang/vite-plugin` dists now ship `dist/THIRD-PARTY-NOTICES.md` with the MIT licence of the bundled `@babel/parser` fork and its two inlined helpers (`@babel/helper-validator-identifier`, `charcodes`), as `@mxlang/core` already does. Each notice's heading names the dist files that bundle the fork, and so does core's.
- **Fixed (file-kinds-deps):** File-kind suffix checks follow one rule, the lower-cased name ends with the suffix: `Counter.Solid.MX` and `Card.MX` are now the same file kind in the build, the Bun loader, the editor plugin, the language server and the Angular host (its `include` matching, watcher and output paths) as their lower-case names. For `.marko`, only the Vite plugin's import claiming and the discovered-tag lowering checks follow it; the `tags/<name>.marko` tag-file probe, the extensions a dialect claims and the default import that marks a tag import stay case-sensitive, so `import Card from "./Card.MX"` still lowers as a dynamic tag. A failed compile of a Preact/React/Hono region, an `.astro.mx` template or an `.ng.mx` file, and a Solid error thrown after lowering, now carries `dependencies` naming the callees it read (for a Solid/Preact/React/Hono region file, those of the regions accepted before the failing one too), so the editor and the language server re-check the caller when the callee changes; core exports `attachDependencies` and `errorDependencies` for this, and `AstroTemplateError` gains `dependencies`. tsconfig `paths` aliases now reach `.mx` callee imports in region files, `.astro.mx` and `.ng.mx` callers in the TypeScript plugin and `mx-tsc` (a new optional `resolveImport` on `HostRegionInput`, `RegionCompileOptions` and each host's region, Astro and Angular entry). `mx-tsc --astro` loads the project's own `@astrojs/language-server` before its bundled copy.
- **Added (followups-b-added):** `sourceBindings` returns the source's value imports as a new `imports` field (`SourceImports`: each local's specifier, the default imports from a `.marko`/`.mx` file, and where each import statement starts; empty on a parse failure). `compileNgMx`'s result has a `dependencies` field: the callee files core read across every region, each once, in first-seen order.
- **Fixed (jsx-mappings):** A `.preact.mx`, `.react.mx` or `.hono.mx` region compile now returns the emitter's recorded `mappings` (`CompileJsxRegionResult.mappings`, generated offsets into `code`, source offsets file-absolute), so the parser bridge places a define's name, a direct call and a later read of a rewritten or repeated name without searching the emitted text; the emitted `code` is unchanged. On the JSX hosts a `$!{value}` sole child, a structured `class=[…]` beside a spread or passed to a called unit, a spread entry's attribute name, `<if>`/`<else-if>` conditions, `<for>` `of`/`in`/`from`/`to`/`step`, a function-form `by=` and attribute-tag `<if>`/`<for>` values are mapped to their authored text; on the html target `<if>`/`<else-if>` conditions and the `<for>` and attribute-tag loop sources are. In the type-check projection, a host-component call bound to an import with no attribute tags (`import { Card as C } from "./barrel"` then `<C title=1/>`) is written as the JSX element it renders, so a wrong prop is reported at the attribute as it is through a direct `.mx` import; build output is unchanged. The parser bridge keeps the location of a name a host recorded inside a type the host generated (`typeof Row` in `(__mxDef_Row as typeof Row)(1)`), so rename and find-references from a define's direct call in a region reach the define and its other reads; such a type with no recorded mapping is still detached. Because recorded mappings place JSX tag and attribute names at their authored lines, a printed JSX region module's line layout can differ; its code is unchanged.
- **Fixed (jsx-misc):** A lone sequence placeholder (`<if=c>${0, x}</if>`) as the only child of a branch compiles to valid TSX on React. A `NaN` `class`, `className` or `style` is omitted, as stock Marko omits it, instead of printing `class="NaN"`. A method shorthand in a dynamic tag's props or an attribute-tag attribute maps its head and body exactly. `<html-script>` with an event handler (`onclick() {}`, `onClick=fn`) is refused on the JSX hosts, as it is on the html target. In `.<host>.mx` regions, a type error in a generic constraint of a method shorthand's head (`onClick<T extends Missing>(e: T) {}`) is reported at the authored span. On Preact and React, a `<try>` whose body threw directly stays on `<@catch>` when the input changes and the body no longer throws, as Marko does; it used to re-render the body.
- **Fixed (solid-region-atoms):** A TypeScript error inside a region expression the host rewrote (an atom, a `<for>` index or key read) is no longer dropped: a host may return optional `mappings` from `mxRegionCompile`, and the bridge maps emitted nodes back to the authored span from them instead of searching the emitted text for each authored expression.
- **Fixed (third-party-notices-all-inlined):** Each dist's `THIRD-PARTY-NOTICES.md` now carries the licence of every npm package it inlines (such as `@babel/generator`, `magic-string`, `preact` and `entities`), and of the vendored htmljs-parser copy, not only the Babel fork's. The notices are generated from the modules each built file actually inlines.

## 0.1.0-alpha.33 — 2026-10-18

- **Changed (parser-split):** this package is what `@mxlang/parser` was before the split, minus the vendored Babel fork and the htmljs-parser template parser. The fork moved to `@mxlang/babel` (`packages/babel`) and the template parser stays in `@mxlang/parser`. The public surface (`parse`, `print`, `printAst`, `sourceBindings`, …) and `dist/index.d.ts` are unchanged apart from the module name, `@mxlang/tsx-bridge`; every in-repo importer moved with it. The bridge now injects the MX grammar into the fork through the `mxHooks` option (`bridge.ts`'s `mxHooks`) instead of the fork importing it. Solid-lowering tests moved to `@mxlang/solid` (`src/bridge/`), so the package depends on no host. Earlier entries below were written under the old package name.

- **Added :** `MxRegionCompileInput.importSites` (and the `mxImportSites` option `parse` pre-collects): where each import binding's `import` statement starts, so a host can position the lowercase-tag diagnostic at the import.
- **Changed (bridge-host):** the parser names no host and no file suffix. `parse`/`print` turn the MX grammar on when `mx: true` is passed or an `mxRegionCompile` hook is supplied; the `.solid.mx` filename default is gone (a hook-less `parse("x.solid.mx")` is now a plain TSX parse, and every tool passes `mx: true`). `MissingRegionCompile` names the region-entry contract (`HostFileKind.compileRegion`) instead of `compileSolidMx`.

- **Fix:** a host helper hoisted with an identical binding and text by several regions of one file (Solid's attribute guard) is declared once instead of being renamed into a copy per region.

- **Fix (marko-parity-trio, `:modifier`):** `:foo=1` in an MX region is no longer a syntax error. It is Marko's attribute named `value:foo`, so it now parses to the JSXNamespacedName `value:foo` (and a valueless `:foo` to `value:foo=""`, HTML's empty attribute); `a:b:c=1` is still refused as malformed.

- **Changed (beta-hygiene-2):** - tsx-bridge: publish-ready at `0.1.0-alpha.1` (was private `0.0.0`), because the beta's `@mxlang/angular` depends on it. Adds an `exports` map resolving from `dist`, `publishConfig.access: public`, repository metadata, a LICENSE and a CHANGELOG. The exports are unchanged. - language-server: marked `private`; it is outside the beta and on no registry. - tree-sitter-mx: the CHANGELOG heading for `0.1.0-alpha.2` carries its publish date (2026-10-05) instead of "unreleased".

- **Changed (beta-readme-note):** Every published package's README now carries the same beta note right after its title/intro: the package is at 0.x and its API may change in any release until 1.0.0 (npm publishes plain `0.1.0` on the `latest` dist-tag for the beta).

- **Changed (pr6-s2-lexer):** Core's parse-error rewrites (the mismatched-close opener, a failure inside a tag's `|params|`, sugar right after a default value, the atom hints, the shorthand-word probe) replay the source with MX's own template lexer (`@mxlang/parser/lexer`) on every run, never with `htmljs-parser` through `@marko/compiler` (PR 6 slice S2). The dist already lexed with MX's parser; running from source now does too. No diagnostic text or position changes. `@mxlang/tsx-bridge` declares the `htmljs-parser` 5.18.0 its region walk bundles, which it used to resolve from the install around it; its output is unchanged. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).

- **Fixed (hosts-colon-astro-rethrow):** An undeclared colon tag in an `.astro.mx` file (`<ns:tag/>`, `<Ns:Tag/>`) is now a compile error at the tag, as in the JSX hosts: Astro used to emit it silently as a namespace element. The fix the error names is now true for every name. It suggests an `mx.tags` `prefix` only when some prefix can produce the name (the name ends in a file stem: `<a:-x/>` takes `prefix: "a:-"`), and for a name no tag file can end (`<uuid:/>`, `<a:b$/>`) it says only to write the name without the colon. The error now carries the end of the name, so an editor underlines all of it. A lowering error inside a region of a `.solid.mx`, `.preact.mx`, `.react.mx` or `.hono.mx` file, and in an `.astro.mx` file, now reaches `mx-tsc` and the TypeScript plugin with its `MX_*` code and its whole range, where it showed `TS80001` and one character. The language server shows the same code and underlines the whole range for such an error, where it showed one character.

- **Added (diagnostic-fix-its):** A diagnostic can now say how to fix itself. `IrDiagnostic.fixes` (`@unstable`) is a list of fixes, each `{ title, edits }` where an edit is `{ offset, end, newText }`: UTF-16 offsets into the same text the diagnostic's `offset` indexes (the file named by `file` when the diagnostic is positioned in another file), `end` exclusive, edits within one fix never overlapping, so applying all the edits of one fix to the original source gives the fixed source. The types are exported as `IrDiagnosticFix` and `IrDiagnosticEdit`, and a compile error carries the same list as `TranslateError.fixes`. The `<effect>` error (`MX_RESERVED_EFFECT_TAG`) now offers one fix, "Rename to `<script>`", that renames the open tag and, when there is one, the close tag; a self-closing tag, a concise tag and a `</>` close have only the open name. A host's "not supported" error for `<effect>` and the strict html policy's own row offer no fix. `fixes` travels wherever a diagnostic's `code` and `end` already do: the tag-file and tag-template errors, a JSX-region error re-raised by `@mxlang/tsx-bridge` (a non-enumerable `fixes`, offsets in the whole file), `AstroTemplateError`, `DialectDiagnostic` from `@mxlang/targets/dialect-check`, and the TypeScript plugin's `MxCompileDiagnostic`. The language server puts a diagnostic's fixes in its `data.fixes` and offers each one as a quick fix (code action) that edits the document, only while the text is the one the diagnostic was computed from. A fix for a diagnostic raised inside another file (a tag template) is not offered across files. The TypeScript plugin's tsserver diagnostics and `mx-tsc` do not show fixes.

## Unreleased

- **Types (public-dts-customtags-any):** `PrintOptions.customTags`, `MxRegionCompileInput.customTags` and `MxParseOptions.mxCustomTags` are now `Record<string, CustomTag>` (type-only `@mxlang/core` import; no runtime or declaration cycle). They were `any`/`unknown`, so a loose tag definition that used to typecheck can now fail to build.

- **Fix (astro-fence-top-level-return):** `sourceBindings` and `unknownSourceBindings` take an optional `allowReturnOutsideFunction` for source a host compiles *inside a function body*, where a top-level `return` is legal — Astro's `---` frontmatter is the case. Default is off, so every other caller (`.solid.mx`, `.ng.mx`, `appendSolidBuiltinImport`) keeps rejecting a stray `return` in real module scope. New export: `SourceBindingsOptions`. `sourceBindings` still reports a parse failure rather than swallowing it.

- **Added (default-tag-ladder):** `print`/`parse` accept `defaultTag` (`mxDefaultTag`), forwarded to the host that lowers each MX region as `MxRegionCompileInput.defaultTag`.

- **Fix (reserve-mx-identifiers):** check authored bindings in MX-enabled TypeScript modules before region emission, even when callers supply binding sets. Generated regions are excluded; plain TypeScript and `mx: false` keep upstream behavior.

- **Test fix (jsx-text-lt-unescaped):** `<div><b/> < c</div>` inside a `.solid.mx` region now *parses* — the solid host escapes the authored `<` for JSX, so Babel's old "Unexpected token (1:26)" splice failure is gone and the region prints `<div><b></b> &#60; c</div>;`. The row moved from the "leaves the error alone" table to the "still parses" table in `fragment-region.test.ts`; no parser behavior changed.

- **Fix (zero-based-cols-in-message-text):** a diagnostic raised through the MX grammar no longer prints Babel's trailing 0-based ` (L:C)`. `Unexpected token (1:32)` becomes `Unexpected token` — the position is on the error's `loc` (1-based line, 0-based column), which every consumer already reads, so the text no longer carries a second, differently-based one. Every MX-raised error is affected: a host parse failure wrapped as `MxErrors.HostError`, the MX grammar's own rules (`An MX region has exactly one root element…`, `NestedFragment`, `Unterminated fragment`, `PositionRejected`, `MultipleRoots`) and Babel's own failures inside a `.solid.mx`/`.ng.mx` file. A message that quotes a *foreign* file's parser position (a wrapped callee's `(1:32)`) still keeps it: that position belongs to another file and nothing else records it.

  The change is at MX's parse entry (`parse`), not in the vendored tree, so `parseBabel` stays byte-equivalent to npm `@babel/parser` — `src/vendored.test.ts` pins that, and a new case asserts an explicit `mx: false` parse and a plain `.ts` parse still carry upstream's `(2:14)`. Recovered errors (`errorRecovery`) are stripped too, not only thrown ones.

- **Test fix (vite-plugin-colored-marko-header):** the tarball test's `bun pm pack --dry-run` parser strips VT control characters first; bun colourises the report (filename column included) under `FORCE_COLOR`, and the plain-text line regex then matched nothing.

- **Fix (ng-mx-tag-import-in-decorator):** the statements `parse` synthesizes and splices into `program.body` (the hoisted tag imports, the `/var` `let`, the hoisted defines) no longer carry `start`/`end`/`loc`/`range`. They were parsed from a snippet of their own, so those were snippet offsets read as source positions: a host taking the last import's `end` inserted inside a decorator, and `print`'s source map put their tokens at (0, 0). The location is removed rather than repaired, as for a generated `satisfies` type; the printed code is unchanged.

- **Fix:** the opener position for a fragment region's own `<>` (`.ng.mx`, `mxRegionFragment`) is now its real column; it was 4 too small because the synthetic root sat in the shifted prefix.

- **A mismatched closing tag in an MX region names the opener's position** (audit item 12). `walkMxRegion` appends ` at line:column` (1-based, UTF-16) of the innermost unclosed tag's `<` to htmljs-parser's `The closing "x" tag does not match the corresponding opening "y" tag`, for `.solid.mx` and `.ng.mx` regions. The error stays at the closer.

- **`mxRegionFragment` parser option, and the `MultipleRoots` error** (TODO
  `angular-ngmx-multi-root`). Default off: `<>` stays a TSX
  fragment, so `.solid.mx` is unchanged. On (`@mxlang/angular` sets it for
  `.ng.mx`), `<>…</>` in expression position is a *fragment region*: the host's
  `mxRegionCompile` receives the fragment's children as `source` with the new
  `fragment: true` flag on `MxRegionCompileInput` (the replaced span also
  covers the `<>` and `</>`). Independent of the option, a second well-formed
  root directly after a region (`<a/><b/>`) now fails with `An MX region has
  exactly one root element. Wrap sibling elements in a fragment, `<>…</>`.`
  positioned at the second root, instead of `Unexpected token` or
  `Unterminated regular expression`. It only replaces a failure; input that
  parsed before (`<b/> < c`, `<b/> <c`, JSX siblings) parses and prints
  identically.
- **`MxRegionContext.fragment?`** (additive). Set by the bridge to `true` on the
  context handed to `mxRegionPositionCheck` and to `mxRegionCompile` when the
  region is a fragment (`mxRegionFragment`); absent otherwise. `@mxlang/angular`
  reads it to word its position error for a fragment outside `template:`.
- **The packed tarball is now `dist/` + `README.md`, and `types` points inside
  it** (TODO `parser-package-types`, LiUNA gap G8). `package.json` gains
  `"files": ["dist", "README.md"]` and `"types": "dist/index.d.ts"` (was
  `src/public.d.ts`, which only resolved because the whole of `src/`,
  `scripts/`, `moon.yml` and the test config shipped: 2.4 MB unpacked, now
  1.3 MB). `bun run build` now clears `dist/` and runs
  `scripts/emit-declarations.ts`, which writes `dist/index.d.ts` from
  `src/public.d.ts` with the ambient `declare module` wrapper removed, so the
  exported surface is identical. In-repo consumers still map the specifier to
  `src/public.d.ts` through `paths`. `src/pack-contents.test.ts` pins the
  tarball contents and the export-list equality.

- **`hoistRegionImports` now declares a `.solid.mx` region's `/var` binding
  as `let n: any;`, not a bare `let n;`** (TODO `tag-var-type-from-return`,
  filed from PR #159 round 2; firstmate's ruling: option C — the real
  `<return>` type cannot be inferred without changing the emitted runtime
  JS). A bare `let n;` reported its own `noImplicitAny` TS7005 at every
  read; an explicit `: any` silences that unrelated noise. The bound
  variable's type is still `any`, not the `<return>` expression's real
  type — a known Solid-only limitation, documented in the spec's `/var`
  section and `@mxlang/solid`'s AGENTS.md, pinned by a regression test.

- **Breaking: `sourceBindings(source)` now returns `{ bindings, error? }`
  instead of a bare `Set<string>`** (source-bindings-silent-parse-failure,
  filed from the PR #156 review). A parse failure used to be caught and
  silently treated as "binds nothing" — indistinguishable from source that
  genuinely binds nothing — so every capitalized tag in a file with a real
  syntax error (an Astro fence, or the text handed to
  `@mxlang/typescript-plugin`'s `appendSolidBuiltinImport`) misreported
  Marko's "Unable to find entry point for custom tag" instead of the actual
  syntax error. `bindings` is always present (empty on failure, matching the
  old fallback for a caller that ignores `error`); `error` is set only on a
  parse failure, positioned from Babel's own `SyntaxError.loc`. Every
  in-repo caller updated to read `.bindings`/`.error` explicitly.
  `programBindings` (the already-parsed-`Program` variant) is unchanged.

- **New exports: `unknownProgramBindings`/`unknownSourceBindings`** (the local
  counterpart of the default-import set). The subset of `programBindings`'/
  `sourceBindings`' non-import names whose value is not statically a
  function/arrow/class, computed over the same declaration-only pre-parse.
  `unknownSourceBindings` returns a bare `Set<string>` (unaffected by the
  `sourceBindings` shape change above — it has no parse-failure-vs-empty
  ambiguity of its own to report, since it is only ever consulted after
  `sourceBindings`'s own bindings already resolved). `MxRegionCompileInput`
  gained `unknownModuleBindings: ReadonlySet<string>`, threaded through
  `parse`'s `mxUnknownModuleBindings` option the same way `mxModuleBindings`
  already is, so a `.solid.mx` region's surrounding module-scope locals
  classify identically to a whole-file `.mx`'s.

- **New dependency: `@mxlang/core`**. `MxRegionCompileInput`
  gained `importDefaultFromMarkoOrMx: ReadonlySet<string>` — the subset of
  `importSpecifiers`' bindings that are a *default* import from a
  `.marko`/`.mx` source, computed by `collectModuleScope`'s same
  declaration-only pre-parse (reusing `@mxlang/core`'s
  `isMarkoOrMxSpecifier` rather than duplicating the extension test) and
  threaded through the bridge the same way `moduleBindings`/`importSpecifiers`
  already are, shadow-filtered like `importSpecifiers` (a name a nearer
  scope shadows is not the module's own import any more, so it cannot carry
  the import's provenance either). A host uses it to tell a `.marko`/`.mx`
  default import (Marko's own statically-resolved component case) apart
  from every other value import, which now lowers as a dynamic tag
  (`@mxlang/core`'s routing).
- **New exports**: `sourceBindings(source)` and
  `programBindings(program)` — the names a piece of TypeScript/TSX source
  binds at its top level (import locals plus top-level `const`/`function`/
  `class`, type-only bindings excluded) — and `SOLID_BUILTIN_TAGS`, the Solid
  JSX built-ins (`Show`, `For`, `Switch`, `Match`, `Repeat`, `Errored`,
  `Loading`, `Dynamic`) that resolve on Solid with no import. Both moved here
  from `@mxlang/typescript-plugin`'s `language.ts` (`sourceBindings`,
  `SOLID_BUILTIN_IMPORTS`), shared now by that package's
  `appendSolidBuiltinImport` and `@mxlang/solid`'s `isComponent`, rather than
  duplicated.
- `MxRegionCompileInput` gained `moduleBindings: ReadonlySet<string>` —
  every value the surrounding module binds at its top level, computed the
  same way `importSpecifiers` already was (a declaration-only pre-parse with
  regions replaced by `null`) and passed to every `mxRegionCompile` call.
  Unlike `importSpecifiers`, it is **not** filtered by local shadowing:
  Marko's own rule (`tag.scope.hasBinding(tagName)`) is that any in-scope
  binding, shadowed or not, resolves a capitalized tag reference. A new
  `mxModuleBindings` parser option carries it; both new options default to
  computed values when omitted, so every existing `mxRegionCompile` caller
  is unaffected.
- `MxRegionCompileResult` gained an optional `hoistedDefines` field
  (`MxRegionHoistedDefine[]`), the `<define>` counterpart to
  `hoistedImports`: a region hosted by Solid can now hoist a `<define>` to
  module scope, and the bridge writes those declarations
  into the surrounding module alongside any hoisted imports, after the
  module's own import block. Every other `mxRegionCompile` caller is
  unaffected — the field defaults to empty.

- Added the surrounding module's import-specifier map to each region compile
  input and optional dependencies to its result. `print` and `printAst` now
  expose the deduplicated region dependency list.

- **BREAKING:** `MxRegionContext.decoratorNames` no longer accumulates every
  enclosing decorator — it now reports only the innermost enclosing
  decorator's name (`[]` when none), scoped to match
  `propertyKey`/`isDirectPropertyValue`/`argumentIndex`, which were already
  computed relative to the innermost decorator only. Nesting is possible: a
  class expression inside an outer decorator's own argument can itself carry
  a decorator whose argument encloses the region. A new
  `enclosingDecoratorNames: readonly string[]` field carries the rest of the
  chain (outermost first, excluding the innermost) for a host that needs the
  full nesting. No in-repo consumer reads `decoratorNames` yet, so this has
  no downstream fix in this repo — any external host built against the old
  accumulated-list shape must switch to `decoratorNames` +
  `enclosingDecoratorNames`.
- **BREAKING:** `parse`/`print` of a `.solid.mx` (or any file with `mx: true`)
  now require `mxRegionCompile`. The parser no longer imports `@mxlang/solid`
  or any other host — with the grammar on and no `mxRegionCompile` supplied, a
  region raises a positioned compile error naming the option and pointing at
  `compileSolidMx` from `@mxlang/solid` for `.solid.mx`. Every in-repo caller
  (the Vite plugin, the TypeScript plugin, the language server, the oracle)
  now imports `@mxlang/solid` itself and passes `compileSolidMx` explicitly.
  `@mxlang/solid` moved from `dependencies` to `devDependencies` in this
  package's own `package.json`.
- Fixed: `src/public.d.ts` re-exported `MxRegionContext`/`MxRegionPositionCheck`
  and the `mxRegionCompile` types through relative imports inside the ambient
  `declare module` block — a TS2439 every consumer's `skipLibCheck: true`
  silently swallowed into `any`. Those types are now declared inline in
  `public.d.ts`, with `src/public-types.test.ts` asserting two-way
  assignability against the real shapes so the two copies cannot drift
  unnoticed.

- **Changed (release-changelog-in-package):** `CHANGELOG.md` is now part of every published tarball (`files` lists it in all packed packages); `bun pm pack` honours `files` only, so the alpha.11 tarballs carried just `README.md` and `dist`.

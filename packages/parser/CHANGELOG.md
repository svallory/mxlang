# @mxlang/parser changelog

- **Fix (marko-parity-trio, `:modifier`):** `:foo=1` in an MX region is no longer a syntax error. It is Marko's attribute named `value:foo`, so it now parses to the JSXNamespacedName `value:foo` (and a valueless `:foo` to `value:foo=""`, HTML's empty attribute); `a:b:c=1` is still refused as malformed.

## Unreleased

- **Fix (astro-fence-top-level-return):** `sourceBindings` and `unknownSourceBindings` take an optional `allowReturnOutsideFunction` for source a host compiles *inside a function body*, where a top-level `return` is legal — Astro's `---` frontmatter is the case. Default is off, so every other caller (`.solid.mx`, `.ng.mx`, `appendSolidBuiltinImport`) keeps rejecting a stray `return` in real module scope. New export: `SourceBindingsOptions`. `sourceBindings` still reports a parse failure rather than swallowing it.

- **Fix (reserve-mx-identifiers):** check authored bindings in MX-enabled TypeScript modules before region emission, even when callers supply binding sets. Generated regions are excluded; plain TypeScript and `mx: false` keep upstream behavior.

- **Test fix (jsx-text-lt-unescaped):** `<div><b/> < c</div>` inside a `.solid.mx` region now *parses* — the solid host escapes the authored `<` for JSX, so Babel's old "Unexpected token (1:26)" splice failure is gone and the region prints `<div><b></b> &#60; c</div>;`. The row moved from the "leaves the error alone" table to the "still parses" table in `fragment-region.test.ts`; no parser behavior changed.

- **Fix (zero-based-cols-in-message-text):** a diagnostic raised through the MX grammar no longer prints Babel's trailing 0-based ` (L:C)`. `Unexpected token (1:32)` becomes `Unexpected token` — the position is on the error's `loc` (1-based line, 0-based column), which every consumer already reads, so the text no longer carries a second, differently-based one. Every MX-raised error is affected: a host parse failure wrapped as `MxErrors.HostError`, the MX grammar's own rules (`An MX region has exactly one root element…`, `NestedFragment`, `Unterminated fragment`, `PositionRejected`, `MultipleRoots`) and Babel's own failures inside a `.solid.mx`/`.ng.mx` file. A message that quotes a *foreign* file's parser position (a wrapped callee's `(1:32)`) still keeps it: that position belongs to another file and nothing else records it.

  The change is at MX's parse entry (`parse`), not in the vendored tree, so `parseBabel` stays byte-equivalent to npm `@babel/parser` — `src/vendored.test.ts` pins that, and a new case asserts an explicit `mx: false` parse and a plain `.ts` parse still carry upstream's `(2:14)`. Recovered errors (`errorRecovery`) are stripped too, not only thrown ones.

- **Test fix (vite-plugin-colored-marko-header):** the tarball test's `bun pm pack --dry-run` parser strips VT control characters first; bun colourises the report (filename column included) under `FORCE_COLOR`, and the plain-text line regex then matched nothing.

- **Fix (ng-mx-tag-import-in-decorator):** the statements `parse` synthesizes and splices into `program.body` (the hoisted tag imports, the `/var` `let`, the hoisted defines) no longer carry `start`/`end`/`loc`/`range`. They were parsed from a snippet of their own, so those were snippet offsets read as source positions: a host taking the last import's `end` inserted inside a decorator, and `print`'s source map put their tokens at (0, 0). The location is removed rather than repaired, as for a generated `satisfies` type; the printed code is unchanged.

- **Fix:** the opener position for a fragment region's own `<>` (`.ng.mx`, `mxRegionFragment`) is now its real column; it was 4 too small because the synthetic root sat in the shifted prefix.

- **A mismatched closing tag in an MX region names the opener's position** (audit item 12). `walkMxRegion` appends ` at line:column` (1-based, UTF-16) of the innermost unclosed tag's `<` to htmljs-parser's `The closing "x" tag does not match the corresponding opening "y" tag`, for `.solid.mx` and `.ng.mx` regions. The error stays at the closer.

- **`mxRegionFragment` parser option, and the `MultipleRoots` error** (TODO
  `angular-ngmx-multi-root`, decision 120). Default off: `<>` stays a TSX
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

- **New exports: `unknownProgramBindings`/`unknownSourceBindings`** (local
  extension of decision 116). The subset of `programBindings`'/
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

- **New dependency: `@mxlang/core`** (decision 116). `MxRegionCompileInput`
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
  (`@mxlang/core`'s decision-116 routing).
- **New exports** (decision 114): `sourceBindings(source)` and
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
  module scope (decision 110b), and the bridge writes those declarations
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

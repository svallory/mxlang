# Upstream provenance

`src/babel/` is a vendored copy of `@babel/parser`'s TypeScript source. There
is no public plugin API for `@babel/parser` (see
`/Users/svallory/work/mx/notes/research/parser-fork-strategy.md` section 1),
so shipping a parser with a modified JSX plugin means owning and building
this source ourselves.

## Pin

- Upstream repo: `babel/babel`
- Tag: `v7.29.8`
- Commit: `5de11ca9234379b78ef95df72aebbec93f28bf45`
- Commit date: 2026-07-31
- Vendored: 2026-09-09/10
- Source path: `packages/babel-parser/src` (fetched via a sparse, shallow
  `git clone --filter=blob:none --sparse --depth 1 --branch v7.29.8`, not
  from `node_modules` — that only contains the compiled `lib/index.js`
  bundle, not source)

## Dropped

- `plugins/flow/` — MX has no Flow story; deleted entirely.
- `flow` removed from the `mixinPlugins`/`mixinPluginNames` registration in
  `plugin-utils.ts` (the import and the two map entries). This also removed
  the 4-line `flow`+`typescript` mutual-exclusion check in
  `validatePlugins` (`if (pluginsMap.has("flow") && pluginsMap.has("typescript")) { throw ... }`,
  upstream `plugin-utils.ts:44-47`) — dead code once `flow` can never be
  registered, since `pluginsMap.has("flow")` is now always `false`; listed
  here explicitly since it's a deletion inside a kept file, not a whole
  dropped file. Stray runtime guards elsewhere in the tree
  (`this.hasPlugin("flow")`, the `flow`/`flowComments` plugin-name
  string-literal unions in `typings.d.ts`) were left as-is: they're inert
  once `flow` can't be registered, and touching them would widen the diff
  against upstream for no behavioral change.

Kept: `estree`, `jsx`, `typescript`, `placeholders`, `v8intrinsic` — the
build didn't force dropping any of these.

## Local modifications (all build-related; no parser behavior changed)

1. **`parser/index.ts`**: `import type { ParserOptions, ParseResult, File } from "@babel/parser"` (a self-referential import Babel's own monorepo resolves via TS path-mapping back to this same package) rewritten to `from "../index.ts"`. Standalone, there is no `@babel/parser` self-reference to resolve.
2. **`tokenizer/state.ts`**: the `@bit`/`@bit.storage` decorators are Babel's own build-time bit-packing transform (`scripts/babel-plugin-bit-decorator`, a Babel plugin that runs as part of Babel's monorepo build, not available standalone). Reimplemented the same packing (mask starts at 1, left-shifts once per `@bit`-decorated accessor, in declaration order) as a small native stage-3 accessor decorator directly in the file, backed by the existing `flags: number` field. **Round 2 fix**: the first version only defined `get`/`set` on the returned accessor descriptor, so field initializers (e.g. `@bit accessor canStartJSXElement = true`) never folded into `flags` — upstream's transform (`plugin.cjs:118-128`) does fold each initializer's boolean literal into the storage field's own initial value at build time, so upstream `new State()` starts with `flags` already carrying every `true`-initialized bit set. Added an `init(this: State, v: boolean)` hook to the descriptor (native accessor decorators call `init` with the field's own initializer value, before `flags` itself — declared first — has been assigned, so `this.flags |= mask` there correctly ORs into whatever `flags` will resolve to); this makes `new State().canStartJSXElement` `true` again, matching upstream, and was verified directly (`new State().canStartJSXElement === true`) plus via a `tokens: true` parse of `<div/>` matching npm's first token.
3. **`util/string-parser.ts`** (new file, not part of the original vendored tree — see below): one non-null assertion added (`/^[0-7]+/.exec(...)!`) — the regex always matches at that call site (it starts scanning from a position already confirmed to be `0-7`), but the vendored code's ambient strictness settings let this slide where our stricter base config didn't.
4. **`util/string-parser.ts` added as a new file**: `@babel/parser`'s own `package.json` depends on `@babel/helper-string-parser` and `charcodes` for these two runtime helpers, but neither publishes `.d.ts` files to npm (a known gap in Babel's own release — `helper-string-parser`'s source comment literally says `// We inline this package`, confirming Babel's own build inlines it rather than treating it as a real external import). Vendored `packages/babel-helper-string-parser/src/index.ts` at the same tag/commit as `util/string-parser.ts`, unmodified except the import rewrite in `tokenizer/index.ts` (`@babel/helper-string-parser` → `../util/string-parser.ts`). **`@babel/helper-string-parser` is not a devDependency** anywhere in this repo — it's fully inlined as source, never imported by name, so there's nothing for a package manager to resolve. The version vendored is pinned here instead of in a `package.json`: **`@babel/helper-string-parser` 7.27.1** (matches the version range `@babel/parser`'s own `package.json` devDependency listed at the vendored tag).

5. **`plugins/jsx/index.ts` — the MX fork itself** (the only behavioral change to the vendored tree). Three edits:
   - One import added at the top of the file: `import { mxParseElementAt } from "../../../mx/bridge.ts";`.
   - `jsxParseElementAt(startLoc)` is now a dispatcher: when the `mx` option is on and the tag is not a fragment (`!this.match(tt.jsxTagEnd)`), it returns `mxParseElementAt(this, startLoc)`. Otherwise (including for `<>` fragments), it calls `jsxParseElementAtOriginal(startLoc)`. Babel's original body is **preserved verbatim** under the new name `jsxParseElementAtOriginal`.
   - The one recursive call inside that original body (`children.push(this.jsxParseElementAtOriginal(startLoc))`, for nested JSX children) now calls `jsxParseElementAt(startLoc)`, so that fragment children are routed back into the MX hook.

   `parseExprAtom` and the `.tsx` generic-arrow disambiguation are untouched: MX relies on both to route `<` in expression position here in the first place, and on the TypeScript plugin's `tryParse` to back out when a `<` turns out to be a generic arrow.

6. **`options.ts`**: added the `mx?: boolean` option (interface field plus a `false` default in `createDefaultOptions`). It has to be a real option because `getOptions` copies only known keys onto its defaults object, so an unknown `mx` key would be silently dropped. Default `false` means the vendored parser behaves exactly like upstream `@babel/parser` unless a caller opts in — which is what keeps the equivalence tests in `src/vendored.test.ts` meaningful.

7. **`tokenizer/state.ts`, `parser/expression.ts`, `parser/statement.ts` — the `mxRegionPositionCheck` parent-frame tracking.** `State` gained `mxRegionParents: MxRegionParentFrame[] = []` (and a matching line in `clone()`), a minimal explicit syntactic-parent stack — the tokenizer's own `context: TokContext[]` is brace/template disambiguation, not a parent path, so it cannot answer "what encloses this region" on its own. Five push/pop sites, all no-ops when the `mxRegionPositionCheck` option is unset:
   - `parseObjectLike` (`expression.ts:2131`) pushes `{ kind: "boundary", valueStart, argumentIndex: null }` around an object literal's own properties, `valueStart` captured before the opening `{` is eaten — the object literal's own start offset. `argumentIndex` is always `null` here: an object literal's own braces are never themselves one of a decorator's top-level call arguments.
   - The object-spread branch of `parsePropertyDefinition` (`expression.ts:2256`) pushes `{ kind: "property", key: null, valueStart }` around a spread element's operand (`...expr` inside an object literal) — keyless, since a spread has no key to report, but it still opens exactly the kind of nested value position a named property's value does.
   - `parseObjectProperty` (`expression.ts:2419`) pushes `{ kind: "property", key, valueStart }` around a static (non-computed) property's value parse, `valueStart` captured right after eating `:`.
   - `parseExprListItem` (`expression.ts:2882`, the single choke point call arguments and array elements both go through) pushes `{ kind: "boundary", valueStart, argumentIndex }` around one list item, `valueStart` captured before anything is parsed. `argumentIndex` is the item's own position in the enclosing list, handed off through the transient `state.mxNextBoundaryIndex` field (set right before each `parseExprListItem` call, read and cleared inside it) by *both* of its two callers' own loops — `parseExprList` and, separately, `parseCallExpressionArguments` (a decorator's own call arguments go through the latter, not `parseExprList`, since `parseMaybeDecoratorArguments` calls it directly) — non-`null` only for a decorator's own top-level argument list; any other list (a plain call, an array, a non-top-level argument) leaves it `null`.
   - `parseMaybeDecoratorArguments` (`statement.ts:865`) pushes `{ kind: "decorator", name }` around a decorator's call-argument parse.

   `computeMxRegionContext` (`src/mx/region-context.ts`) computes `isDirectPropertyValue` by walking the frames after the innermost decorator (or from the start of the stack) while they are `boundary` frames sharing one common `valueStart` — the first frame's own — then requiring the frame right after that run to be a `property` whose own `valueStart` equals the region's start. Every `boundary` frame is always pushed unconditionally (no coalescing of any kind between `parseObjectLike`'s and `parseExprListItem`'s pushes): the position-exact chain-walk is what distinguishes `@Component({ template: <div/> })` (the decorator's own argument-slot boundary and the object-literal boundary share one `valueStart`, since nothing sits between the `(` and the `{`) from `@Component(wrap({ template: <div/> }))` (the two boundaries' `valueStart`s diverge, since `wrap(` sits between them) — not a count of frames. `argumentIndex` is read straight off that same first frame after the decorator, whenever one exists and is a `boundary`.

   `options.ts` gained `mxRegionPositionCheck?: MxRegionPositionCheck`, following the same "must default to `undefined`, not be left out" rule `mxCustomTags` already established (`getOptions` only copies known keys). See `src/mx/region-context.ts` for `MxRegionContext`/`computeMxRegionContext`, and `packages/parser/README.md` for the design summary.

8. **`options.ts`, `src/mx/bridge.ts`, `src/index.ts` — the `mxRegionCompile` host hook.** Which host lowers a discovered MX region used to be fixed at `bridge.ts`'s import site: it imported `compileSolidMx` from `@mxlang/solid` and called it for every region in every file, defaulting the filename to `"input.solid.mx"`. That is correct for `.solid.mx` and unusable for any other file kind — Angular's `.ng.mx` lowers the same region to a template string for `@Component({ template: … })`, sharing nothing with Solid's JSX but being text the surrounding grammar can parse.

   `options.ts` gained `mxRegionCompile?: MxRegionCompile` (same `undefined`-default rule as the two options above), and the bridge calls it in place of `compileSolidMx` when it is set. The hook's input mirrors exactly what the bridge already passed the Solid host (region text, filename, `baseOffset`/`baseLine`/`baseColumn`, `customTags`), and its result is deliberately narrower than any one host's own return type: `{ code, hoistedImports?, returnVars? }` is precisely the three fields `mxParseElementAt` consumes. A host returning more — a source map, expression mappings, warnings, the tags a template used — keeps those on its own richer type and hands them to its caller directly, so the parser grows no dependency on their shape.

   `src/index.ts`'s `parse` also now honours an explicit `mx` option (`options.mx ?? filename.endsWith(".solid.mx")`) rather than always overwriting it, since a `.ng.mx` filename would never match that extension test and its regions would otherwise never be discovered. Unset, the `.solid.mx` test still decides, and an absent `mxRegionCompile` still means `compileSolidMx` — so every existing caller is byte-for-byte unaffected, which `src/vendored.test.ts` and the rest of this package's suite pin.

   The hook's input also carries the region's own `MxRegionContext` (C3's), so a host needing the enclosing syntax downstream needs no side channel back into the parser; it is `undefined` when no `mxRegionPositionCheck` is set, since the parent-frame stack is only tracked then.

   **Error positioning.** The catch around the hook used to trust `error.line`/`error.column` from anything thrown. It now distinguishes three cases: a *positioned* error (one carrying its own numeric `line`/`column`, a Babel syntax error, or a real `loc.start.index`) keeps its coordinates, which the contract requires be file-absolute — a host applies `baseLine`/`baseColumn` itself, as `compileSolidMx` does by pre-padding its source. A plain `Error` is raised at the region's start instead, because an ordinary `Error`'s `line` is V8's *throw site inside the host's own module* (measured: a host throwing from its line 11, for a region on line 3, reported 14:1 — a position in neither file). A thrown non-`Error` is raised at the region's start too, rather than rethrown raw, which escaped the positioned-`SyntaxError` contract `toSyntaxError` relies on. The predicate is keyed on **deliberate** markers only (`error.name === "TranslateError"`, Babel's `code`/`reasonCode`, a real `loc.start.index`) and never on the presence of `line`/`column`: under Bun (JavaScriptCore, which this repo runs on) *every* plain `Error` carries own numeric `line`/`column` naming its JS throw site, while V8 does not — so a presence check is correct under vitest (Node) and wrong at runtime. That asymmetry is why `src/mx/region-compile.bun.test.ts` exists and runs under `bun run test:bun`: the vitest suite cannot observe the bug it pins.

   **Not done here, deliberately:** the `@mxlang/solid` import stays in `bridge.ts` as the default. Inverting that dependency (making the parser import no host at all, with every caller supplying its own hook) is a follow-up for the tag-unit squad to weigh, since it is a breaking change for every current `parse` caller. See `src/mx/region-compile.ts` for the types and `packages/parser/README.md` for the design summary.

## tsconfig relaxations (`packages/parser/tsconfig.json`, whole-package)

Attempted a `src/babel/**`-only scoped tsconfig via TypeScript project
references first (a second `composite: true` project just for `src/babel`).
It typechecks correctly in isolation and under `tsc -b`, but the repo's
per-package convention is a single `tsc --noEmit -p <dir>` invocation (root
`package.json`'s `typecheck` script, and the `.claude/hyper.json` edit-check
hook both call it that way) — plain `--noEmit` does not build TS project
references first, so `src/index.ts`'s import of the referenced project
failed with `TS6305` unless something ran `tsc -b` first. Rather than special-
case this one package's typecheck invocation, relaxed at the package level
instead. Documenting so a future re-scope (e.g. if the repo moves to `tsc -b`
everywhere) is easy to identify and revert:

- `allowImportingTsExtensions: true` — required for the vendored tree's own
  `.ts`-suffixed relative imports (Babel's source imports `./foo.ts`
  throughout; this is a `moduleResolution: bundler`-era style our base
  config didn't otherwise need).
- `noUncheckedIndexedAccess: false` — our base config enables this; Babel's
  own tsconfig does not, and stays internally consistent about `undefined`
  handling (e.g. `TokContext[]` / `State` fields) without it. Re-enabling it
  surfaces ~20 "possibly undefined" errors, none of which are indicative of
  a real bug at this file's actual call patterns.
- `strictFunctionTypes: false` — several of Babel's own `ParseErrorConstructor<T>`
  usages (e.g. `this.raise(Errors.ParseExpressionExpectsEOF, loc, { unexpected: codePointAt(...) })`
  in `parser/expression.ts`) infer a narrower `T` at the call site than the
  error's own template declares, which fails contravariant function-type
  checking under `strictFunctionTypes: true`. This is a pre-existing type
  looseness in Babel's own source (8 call sites, all structurally the same
  shape), not something introduced by vendoring.

None of `src/index.ts` (the package's public, non-vendored entry) or a
future `htmljs-bridge.ts`/lowering table currently depend on either
relaxation — re-scoping later is a mechanical change, not an unpicking of
code that relies on the looser settings.

## Re-vendoring procedure

Run `packages/parser/scripts/vendor.sh <tag>` (defaults to the currently
pinned tag if omitted). It deletes `src/babel/` and re-fetches both
`packages/babel-parser/src` and `packages/babel-helper-string-parser/src`
(the latter into `util/string-parser.ts`), then reapplies the `flow` drop.
It does **not** reapply the four numbered local modifications above, rerun
the build, or rerun the equivalence test — the script prints a reminder to
do all three by hand, since a new tag may shift line numbers, add new
plugins, or change the `ParseErrorConstructor`/`@bit` call sites enough
that these fixes need re-diffing rather than blindly reapplying.

After running it:

1. Re-check whether `plugins/flow/` still exists at the new tag and whether
   `plugin-utils.ts` still needs the same edit (including the
   `flow`+`typescript` mutual-exclusion check deletion).
2. Re-check `parser/index.ts`'s self-import and `tokenizer/state.ts`'s
   `@bit` decorators (get/set/**init**, all three) for the same patterns
   (upstream could change either).
3. Re-check whether `@babel/helper-string-parser`'s version moved (compare
   against the version `@babel/parser`'s own `package.json` devDependency
   lists at the new tag) and update the pin recorded above if so.
4. `bun run build` and `bun run test` (from `packages/parser`), and fix
   whatever the equivalence test or the build surfaces.

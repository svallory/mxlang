# @mxlang/parser

MX's parser is a fork of `@babel/parser` with one plugin function replaced:
the JSX element parser, so `<` in expression position opens an MX region
instead of a JSX element. `@babel/parser` has no public plugin API, so a fork
means owning and building its source ourselves; see
`notes/research/parser-fork-strategy.md` at the space root for why the
alternatives (patching the published bundle, acorn, oxc/swc) were rejected.

## What this package does

This package's job is **region discovery only**: finding where an MX region
starts and ends inside a `.solid.mx` file's surrounding TypeScript, and
handing the region's raw text off to be lowered elsewhere. It does no MX
lowering itself.

- `walk.ts` — walks one MX region with `htmljs-parser` (`walkMxRegion`) and
  returns its raw tree (`MxElement`, `MxAttr`, `MxChild`, …) plus the byte
  range the region occupies in the file. This layer does no lowering and no
  TypeScript parsing: it only records what htmljs-parser found and where.
- `bridge.ts` — the parser-facing surface (`mxParseElementAt`), called from
  the vendored JSX plugin in place of `jsxParseElementAt` wherever `<`
  appears in expression position. It calls `walkMxRegion` to find the
  region's end, slices the region's raw source text, and passes it to
  `@mxlang/solid`'s `compileSolidMx` (which does the actual MX-to-Solid-JSX
  lowering, over `@mxlang/core`'s IR) along with the region's file-relative
  base position (`baseOffset`/`baseLine`/`baseColumn`). The resulting JSX
  text is re-parsed with Babel's own expression parser and spliced back into
  the surrounding TypeScript AST at the tokenizer position the MX region
  occupied, so error positions and source maps stay anchored to the original
  `.solid.mx` file. See `packages/hosts/solid/README.md` for the lowering
  table itself and everything downstream of the region hand-off.

  **Note on fragments:** TSX fragments (`<>...</>`) are supported in `.solid.mx` files, but their text children are parsed by Babel as standard TSX text, not MX text. MX parsing rules (like Marko's whitespace collapsing) only apply inside an explicit MX element. Because `${x}` would silently parse as literal text `$` followed by a JSX expression `{x}` in TSX, the parser detects and throws an error for `${` in fragment text. Use standard `{x}` for expressions outside of an MX element.

**A host can veto a region's syntactic position** through the
`mxRegionPositionCheck` parser option, carried on the options bag beside
`mxCustomTags` for the same reason (the bridge runs inside the tokenizer and
has no other channel to the caller). Before compiling a region,
`mxParseElementAt` computes an `MxRegionContext` — `propertyKey` (the
innermost enclosing object-property key, or null; a computed key or a
method-shorthand key, which has no `:` to anchor a value position at,
contributes none), `decoratorNames` (every enclosing decorator's name,
innermost first) and `isDirectPropertyValue` (an *exact-position* test: true
iff the region is the immediate value of a property of the decorator
argument object itself — the *first* frame directly enclosed by the
decorator, or by nothing if the region isn't inside a decorator at all, must
already be that property. A call wrapping the object, a ternary choosing it,
an array holding it, or a further-nested object
(`{ x: { template: <region/> } }`, `false` even though `propertyKey` reports
the innermost `"template"`) all make it `false`, whether or not the region is
an exact match one level deeper — there's no need to special-case each
wrapper shape, since any of them either shifts the immediate frame's own
start away from the region, or opens a boundary before the property is ever
reached. It carries **no decorator-adjacency guarantee** — a region can be
the direct, unwrapped value of some property with no decorator anywhere
above it at all, so a host must also check `decoratorNames`) — and
`argumentIndex` (the index of the decorator-call argument that (transitively)
encloses the region, or null when there isn't one; distinguishes
`@Component({ template: <div/> })` (`0`) from `@Component(opts, { template:
<div/> })` (`1`), which `propertyKey`/`isDirectPropertyValue` alone can't) —
from a small explicit parent-frame stack the
vendored parser now tracks (`parseObjectProperty` in `src/babel/parser/expression.ts`
pushes the property frame; `parseMaybeDecoratorArguments` in
`src/babel/parser/statement.ts` pushes the decorator frame around a
decorator's own call-argument parse; both push/pop `state.mxRegionParents`;
see `src/mx/region-context.ts` for how the frames are turned into a
context). No host knowledge (Angular's or anyone else's) lives in this
package: the option is a plain callback returning `{ ok: true }` or
`{ ok: false, message }`, and a rejection raises a positioned parse error at
the region's own start. Absent, nothing is tracked and parsing is unchanged
— see `notes/investigations/angular-ng-mx-spike.md`
§Q4 for the design rationale (this is the `.ng.mx` host's C3 contract).

**A host can also claim the lowering itself** through the
`mxRegionCompile` parser option, on the same options-bag channel and for the
same reason. Where `mxRegionPositionCheck` vetoes *where* a region may
appear, this decides *who lowers it*: the bridge hands the hook the region's
text, its filename, its `baseOffset`/`baseLine`/`baseColumn` and the
registered `customTags` — exactly what it already passed the Solid host —
and takes back `{ code, hoistedImports?, returnVars? }`, the three fields it
consumes. The result type is deliberately narrower than any one host's own:
a host with a source map, expression mappings, warnings or a used-tag list
keeps those on its richer return type and gives them to its caller directly,
so this package never learns their shape. Absent, the region goes to
`compileSolidMx` exactly as before. Angular's `.ng.mx` is the first caller
to supply one (`@mxlang/angular`'s `compileNgMx`), paired with its own
position check; see `src/mx/region-compile.ts`. The input also carries the
region's own `MxRegionContext` — the same one the position check saw — so a
host that needs the enclosing syntax to shape what it *emits*, not merely to
accept or reject it, needs no side channel (undefined when no position check
is set, since the parent-frame stack is only tracked then).

**A hook that throws** must give file-absolute coordinates on a positioned
error (1-based line, 0-based column): the bridge does not shift them by the
region's base, so apply `baseLine`/`baseColumn` yourself, as `compileSolidMx`
does by pre-padding its source. Anything else a hook throws — a plain `Error`,
or a non-`Error` value — is reported at the region's own start with its
message preserved, rather than at `error.line`, which for an ordinary `Error`
is V8's throw site inside the host's own module.

Because a `.ng.mx` filename would never match `parse`'s own `.solid.mx`
extension test, `parse` honours an explicit `mx: boolean` option as the
grammar gate, falling back to that test when it is unset.

`@mxlang/parser` depends on `@mxlang/solid` for the **default** hand-off;
tooling packages (`vite-plugin`, `tsc`, `babel-plugin`, `eslint-plugin`,
`typescript-plugin`) keep importing `@mxlang/parser` unchanged — the
`compileSolidMx` call is internal to the bridge, not part of this package's
public surface (`src/public.d.ts`). Dropping that dependency entirely, so
every caller supplies its own `mxRegionCompile`, would be a breaking change
for each of them and is left as a follow-up.

`lower.ts`, `control.ts` and `attrs.ts` — the modules that used to lower the
raw `walk.ts` tree to Solid JSX text directly inside this package — are
deleted; that lowering now happens in `@mxlang/solid` over the shared core
IR, the same as the HTML and Astro hosts. Their test files
(`control.test.ts`, `attrs.test.ts`, `render-props.test.ts`) stay, now
exercising the same behavior end to end through `mxParseElementAt`.

The vendored Babel tree is still on the parse path: it is what recognizes
`<` in expression position and calls into `walk.ts`/`bridge.ts` in the first
place. Whether that recognition could instead happen without a vendored
Babel fork (region discovery driven some other way) was not attempted in
this task.

## Build

```
bun run build   # from packages/parser, or `bun run build` at the repo root
```

Produces `dist/index.js` (ESM) from `src/index.ts`, re-exporting `parse`,
`parseExpression`, and the option/result types from the vendored entry.
Babel's compile-time flags (`process.env.BABEL_8_BREAKING`,
`process.env.USE_ESM`, `process.env.IS_PUBLISH`) are resolved via `bun
build --define` so no `process.env` lookups survive in `dist/`.

## Re-vendor

```
packages/parser/scripts/vendor.sh [tag]   # defaults to the pinned tag
```

Idempotent: deletes `src/babel/` and re-fetches. Does not reapply the local
modifications, rebuild, or rerun tests — see `UPSTREAM.md`'s "Re-vendoring
procedure" for what to do after running it.

## Pinned versions

See the root `README.md` "Pinned versions" table for `@babel/parser`,
`@babel/types`, and friends. This package additionally pins two vendoring-
only devDependencies not otherwise used at runtime by any other package:

| Package | Version | Why |
|---|---|---|
| `charcodes` | 0.2.0 | `@babel/parser`'s own runtime dependency for character-code constants; not published with types under npm's normal resolution for the way `@babel/parser` ships, so pinned directly. |
| `@babel/helper-validator-identifier` | 7.28.5 | `@babel/parser`'s own runtime dependency for identifier validation. |
| `@types/charcodes` | 0.2.2 | `charcodes` ships no types of its own. |
| `@types/babel__helper-validator-identifier` | 7.15.2 | `@babel/helper-validator-identifier` ships no types of its own (a gap in Babel's own npm publish). |

`@babel/helper-string-parser` (7.27.1) is **not** a devDependency here — it's
vendored as source into `src/babel/util/string-parser.ts` instead of
installed as a package, since it ships no `.d.ts` and is meant to be
inlined (see `UPSTREAM.md`). Its version is pinned in `UPSTREAM.md`, not in
this table, since there's no `package.json` entry to pin.

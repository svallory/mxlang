# data — agent instructions

## `@mxlang/data`: the hostless data target

`packages/targets/data` (`@mxlang/data`) is MX's first **hostless** target
(decision 132: a target with no `host` part; `targets/` holds hostless
targets, `hosts/` holds framework hosts). A `.mx` file under it is **data**:
`parseData(source, filename)` compiles with core's own `compileSource` —
delegate-everything declarations plus a data taglib — and projects the IR
into a small, closed, serializable **static tree** (`src/tree.ts`). The tree
describes what is written, never what it evaluates to; the consumer (mash is
the first) decides what any tag or expression means. Design:
`notes/investigations/data-target.md` at the space root; rulings in decision
131's addendum.

- `src/tree.ts` — the tree types. Expressions are Marko's Babel nodes plus
  printed `code` and a UTF-16 `span` (slice the source by `span` for the
  authored text; `code` is generated). `Text` and the structural nodes carry
  the spans core adds at `feat(core): spans on Text, Comment and structural
  IR nodes` (#234, the 131 addendum's item 7); a text node's `value` is
  Marko-normalized while its `span` slices the text as authored.
- `src/taglib.ts` — the data taglib. The 19 HTML parse-rule neutralizations
  (`openTagOnly`/`text`/`preserveWhitespace` to `false`) are **derived from
  Marko's own lookup**, not hand-listed; `taglib.test.ts` pins the measured
  19 names and compiles a child tag under each, so a Marko change fails
  loudly. The structural entries (`if`…`export`) are copied from
  `packages/targets/html/taglib/marko.json`; host-owned entries (`let`, `id`,
  `class`, …) are deliberately omitted so they stay data tag names. TODO
  `core-export-structural-taglib` would give both packages one copy.
- `src/declarations.ts` — delegate-everything `HostDeclarations`
  (`isDelegatedTag` claims every name but `DYNAMIC_TAG`), plus `error`
  dispositions for the reserved names `else`/`else-if`/`try` and for
  `<define>`/`<return>`, and `resolveAttributeMethod: () => true` (the Ash
  fixture's method shorthand needs it).
- `src/build.ts` — the IR→tree projection and every reject: tag variables,
  dynamic tags, `Component` (a call of an imported component, or of a `customTags` entry that has a template), `<!doctype>`, and
  the `structural: "reject"` walk ("the data tree is static; this file's
  consumer does not evaluate `<if>`").
- `src/parse.ts` — `parseData`/`parseDataFile` → `{ tree, diagnostics }`.
  Fail fast: one positioned error and `tree: undefined`, never a partial
  tree. Marko `CompileError`s report their `label`, not the framed `message`.
- `src/descriptor.ts` + `src/compile.ts` — the `data` `TargetDescriptor`
  (`./descriptor` export) and its `compileModule`, which emits
  `export default <literal> as const`: the tree minus every Babel `node`
  (`SerializedDataDocument` in `tree.ts` is the shape; the literal is
  assignable to it). The module **imports nothing**, so it type-checks in a
  consumer with no `@mxlang/*` package (this package is source-only and its
  `tree.ts` pulls in `@babel/types` and core). Light import: the descriptor
  imports `declarations.ts` only; `compile.ts` requires `./parse.ts` (and so
  `@marko/compiler`) inside `compileModule`, on a relative path, so `load()`
  loads no compiler. A source error throws one positioned `TranslateError`
  (the `TargetCompiler` contract; no partial tree to emit); warnings go to the
  caller's `options.warnings` as raised, so those before an error are kept.
  No `translator`: only the mapping pass reads it. No `mappings` either: the
  mapping mode is chosen in data PR 4, together with the TS plugin's guard for
  a target that returns no `map` and no `mappings` (the plugin's merge path
  dereferences both).
- **`load()` needs Bun or a bundler.** A descriptor's `load()` is synchronous
  by contract and reaches its compile module with a relative `require`. That
  works under Bun and inside a bundle, but under plain Node ESM `require` is
  not defined and `load()` throws. Tooling that loads the registry under plain
  Node must bundle it (not mark it external). The seven hosts use the same
  idiom; the language server bundles them today.

Reserved names (no data tag may use them): core's structural names plus
`else`, `else-if` and `try`. `<define>` and its calls, `<return>`, tag
variables and dynamic tags are always rejected; text, `${}`,
`<if>`/`<for>`/`<const>`, comments and `import`/`export`/`static` pass
through by default and error under `structural: "reject"`.

Tag and attribute-tag names are **not** restricted to plain identifiers:
XML-style namespaced names (`svg:rect`, `soap:Envelope`) and non-ASCII names
are legal and pass through. The only names refused are ones that are not
names — a leading `$` or `!`, or a `{`/`}`/whitespace — because Marko parses
a concise `$!{x}` line or a `$const x = 1` scriptlet as a tag, and MX has no
scriptlets (decision 54).

Shorthand: `#id` and `.cls` arrive with **no** `nameSpan` (core records no
name for a name that is not written; TODO `core-shorthand-attr-spans` would
give it a real span). A shorthand `class` **together with** an authored
`class` on the same tag (`<x.a class="b"/>`) is one positioned reject —
core merges them into a synthesized `class` with no span, so there is no
source range for the tree to carry. That reject also lifts under the same
TODO.

Raw-text trade: with `text: false` on `script`/`style`/`textarea`/`title`, a
tag-like `<name` in those bodies parses as a tag, not text (a `<` that
starts no tag stays text).

`fixtures/ash-resource/post.mx` is copied from the mash plan
(`~/work/mash/notes/Ash-style Resource Framework on MX + TypeScript
Implementation Plan.md`); re-copy it if the plan changes.
`src/timing.test.ts` is the §10 `readCalleeInput`-per-tag measurement over a
generated 1,000-tag file; it prints the timing and asserts nothing about it.

The duplicate-attribute test follows decision 135 (last-wins in core): the
tree keeps the last occurrence, and core's warning sits on the dropped one.

## Gates

`bunx vitest run --project @mxlang/data` from the repo root, and
`bun run typecheck` here. The package builds to `dist/` (`bun run build`,
run first by the root `build`, right after core), and its `exports` point at
`dist`, so the workspace consumers (target-registry, the tooling bundles, the
tsc goldens) read the build: rebuild before trusting them. Its own tests import
`src/`. Keep `parse.ts` free of any import of `descriptor.ts` (an entry-point
cycle makes Bun drop `dist/parse.js` silently), and keep `@marko/compiler`
behind a lazy `require` (a static import is hoisted in the bundle and breaks
the registry's light import). Publishing: the space-level `notes/release-alpha.md` (outside the repo).

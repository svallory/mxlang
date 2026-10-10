# `@mxlang/data`

MX's tree target: a `.mx` file as **data**, not UI. `parseData` compiles a
source with `@mxlang/core` and returns a static tree — what is written,
never what it evaluates to — for consumers like spec and config tools that
walk tags and attributes rather than render them. The first consumer is the
Ash-style resource framework (mash); the fixture in
`fixtures/ash-resource/post.mx` is its resource dialect.

> **Beta.** This package is at 0.x. Its API may change in any release until 1.0.0.

It ships a built `dist/` with declarations and needs `@mxlang/core` at a
matching version.
There is no host: the target is registered as `tree` (decision 187) and is hostless (decision 132).

```sh
bun add @mxlang/core@alpha @mxlang/data@alpha
```

## Usage

```ts
import { parseData } from "@mxlang/data";

const { tree, diagnostics } = parseData(source, filename, {
  customTags, // contract-only tags; see below
  structural: "reject",
  unknownTags: "reject",
});
if (!tree) {
  // One positioned error; there is never a partial tree.
  console.error(diagnostics[0]);
}
```

`parseData(source, filename, options?)` and `parseDataFile(path, options?)`
return `{ tree, diagnostics }`. Options:

- `structural: "pass" | "reject"` (default `"pass"`). Pass-through keeps
  text, `${}`, `<if>`/`<for>`/`<const>` and
  `import`/`export`/`static` in the tree for the consumer to interpret.
  Comments are never structural: a `//` line or `<!-- -->` stays in the
  tree as the `Comment` node it already is under either value (decision 131
  addendum 5).
  `"reject"` makes each structural construct a positioned error ("the data
  tree is static; this file's consumer does not evaluate `<if>`"), for a
  consumer that wants tags and attributes only.
- `imports: "pass" | "reject"` (default: the effective `structural` value, so
  nothing changes unless it is set). With `structural: "reject"` and
  `imports: "pass"`, control flow, `export` and `static` stay rejected and the
  top-level `import`s come back verbatim as `tree.imports`
  (`Array<{ code, span }>`, file order, UTF-16 spans); they are not in
  `tree.statements` then. A tag-body `import` is not an import at all: Marko parses it as body text, so `structural: "reject"` rejects it as text and `imports` does not apply. With
  `structural: "pass"` and `imports: "reject"`, only the `import`s are errors.
  With `structural: "pass"` the imports stay in `statements` and `tree.imports` is absent. Each entry is one authored statement line (Marko's statement granularity), so two declarations on one line are one entry.
- `unknownTags: "allow" | "reject"` (default `"allow"`). `"reject"` makes a
  tag at any depth with no entry in `customTags` a positioned error naming
  the tag (with a nearest-declared-name hint when one is close), so a typo at
  the top level of a closed dialect cannot pass silently. `#root` placement
  stays the job of `parents`; reserved names are never "unknown", and `<@name>`
  attribute tags are governed by the parent's `attributeTags`, not this
  option. The check runs on a tag before anything inside it, in document
  order: an unknown parent is reported before its children's `parents` /
  `children` errors (`resourse` before the `<attributes>` inside it), and
  against a `structural: "reject"` hit the construct that comes first wins. A
  known parent's `children` error positioned at the unknown tag itself, or
  any error that comes earlier in the file, still wins.
- `customTags` — contract-only custom tags (decision 130): required
  attributes and attribute types, validated by core with no data-specific
  code.

## The tree

A `DataDocument` is `statements` (`import`/`export`/`static`, sorted by
position) plus `children`: `tag`, `text`, `expression` (`${}`), `comment`,
`if`, `for`, `const`. Tags carry attributes (string / boolean / expression /
bound / spread), arguments, params and attribute tags (`<@y>`, with
`<if>`/`<for>` among them kept). Expressions are Marko's Babel nodes plus a
printed `code` and a UTF-16 `span`: **`code` is the printed form; slice the
source by `span` for the authored text.**

Always rejected, each with a positioned message: `<define>` and its calls,
`<return>`, tag variables, dynamic tags, calls of an imported component, `<!doctype>`.
No data tag may be named `if`, `else`, `else-if`, `for`, `const`, `define`,
`return`, `import`, `export`, `static` or `try` — core consumes those names
before any target sees them.

`parseData` never scans `tags/` or `package.json`; `customTags` is the whole
vocabulary it knows. A `tags/card.mx` template next to the file is therefore
not rejected: `<card/>` is an ordinary data tag. A call is rejected ("calls a
template tag; a data file cannot call a template tag") when the name is an
imported component, or when `customTags` holds an entry with a template, as a
map from core's `getCustomTags` does for a `tags/` file.

Marko's HTML parse rules are neutralized through the target's own taglib
(`openTagOnly`, `text` and `preserveWhitespace` to `false` on the 19 names
derived from Marko's own lookup), so a data tag named `source`, `input`,
`title` or `script` may have child tags. The trade: a tag-like `<name` in a
`script`/`style`/`textarea`/`title` body parses as a tag, not text.

## Wildcard children

A parent's `children["*"]` entry claims child names no explicit entry, registered
tag or target built-in resolves (decision 147,
[ADR 147](../../../apps/docs/docs/design-notes/adr-wildcard-children.md)). The
tree keeps what was written and says what claimed it, on the matched `tag`:

| field | meaning |
|---|---|
| `name` | the authored name (`title`), as for every tag; `nameSpan` slices it |
| `contract` | the canonical tag whose contract applied (`attribute`); for an inline contract, equal to `name` (equality alone does not mean inline: a by-reference entry whose contract tag has the authored name gives the same) |
| `groups` | the entry pattern's named capture groups; absent without any |

Both fields are absent on every tag no wildcard claimed, so a tree without
wildcards serializes exactly as before. With
`attributes: { children: { "*": { pattern: "^[a-z][a-z0-9_]*$", contract: "attribute" } } }`,
`<attributes><title type="string"/></attributes>` has this `title` tag
(`attrs` omitted here):

```json
{ "kind": "tag", "name": "title", "contract": "attribute",
  "nameSpan": { "sourceStart": 16, "sourceEnd": 21 },
  "span": { "sourceStart": 15, "sourceEnd": 37 },
  "args": [], "params": [], "attrTags": [], "children": [] }
```

A name no entry matches is the E2 error listing the patterns, and one a typo
away from an explicit child is an error (the did-you-mean guard) on every target;
`mx-tsc` reports both for a data package at the child's position.
`unknownTags: "reject"` counts a claimed child as known.

## The unnamed tag

`<#id>`, `<.class>` and concise `#id` / `.class` carry no tag name (decision
145, [ADR 145](../../../apps/docs/docs/design-notes/adr-default-tag.md)). On the
tree target `div` means nothing, so the name is resolved through `defaultTag`.
The first of these that answers wins:

1. **The parent's contract**: `defaultTag` beside `children`, in a sidecar or
   an `mx.contracts` module (also on attribute-tag declarations).
2. **`defaultTag` in `package.json#mx.data`**, or the `defaultTag` option of
   `parseData` (already validated; `parseData` itself never reads
   `package.json`).
3. **The built-in `object`**, the anonymous node.

`object` is a built-in tag of this target: an open contract, always known, never
an unknown-tag error under `unknownTags: "reject"`, no declaration needed. `id`
and `class` arrive as ordinary attributes. An authored `<object>` is the same
tag, and a declared `object` contract replaces the built-in.

```mx
<#a/>
<.b/>
```

`parseData` gives two tags named `object`; the first has `id="a"`, the second
`class="b"`. With `parseData(source, file, { defaultTag: "item", customTags: {
item: {} } })` (what `mx-tsc` passes for `{ "mx": { "data": { "defaultTag":
"item" } } }`) both are tags named `item`.

**Mesh.** `attributes` declares `defaultTag: "attribute"`, so a bare shorthand
under it is an `attribute`:

```ts
// contracts.ts
export default {
  attributes: {
    defaultTag: "attribute",
    children: { attribute: { repeatable: true } },
  },
  attribute: { attributes: { id: {}, type: {} } },
};
```

```mx
<attributes><#title type="string"/></attributes>
```

is `<attribute id="title" type="string">` inside `<attributes>` in the tree (a tag
named `attribute` carrying `type="string"` and `id="title"`). The parent's
`defaultTag` beats `mx.data.defaultTag`, which would apply anywhere else.

**`:name` for Mesh** (decision 146). `:title` sets `name="title"` where `#title` sets
`id`, which is the attribute a vocabulary of named things wants. With `name` declared
on `attribute` (`attribute: { attributes: { name: {}, type: {} } }`):

```mx
<attributes><:title type="string"/></attributes>
attributes
  :year type="number"
```

is `<attribute name="title" type="string">` and `<attribute name="year"
type="number">` under `<attributes>` (the concise line is the same). An E1 error on
the sugar names the token and the attribute, positioned at the token. For the
document `attributes` / `  :title type="string"` with `name` left out of
`attribute`'s declared `attributes` (`attribute: { attributes: { type: {} } }`):

```text
doc.mx(2,3): error TS80001: `<attribute>`: unknown attribute `:title` (`name`)
```

After the name is resolved the tag is ordinary, so the parent's closed `children`
and the tag's own closed `attributes` apply, positioned at the shorthand. With
`children: { other: {} }`:

```text
doc.mx(2,3): error TS80001: `<attributes>`: `<attribute>` is not allowed here; allowed children: `<other>`
```

and with `attribute: { attributes: { type: {} } }` (no `id`):

```text
doc.mx(2,3): error TS80001: `<attribute>`: unknown attribute `id`
```

A closed parent `children` that lists neither the resolved name nor `object` is
the same E2 error.

**Invalid values.** A `defaultTag` must be `object` or a custom tag of the
package, and must parse as a plain tag. Any html name, `div` and `input`
included, is not an element of this target:

```text
package.json(1,45): error TS80003: invalid `defaultTag` value: `<input>` is not an element of this target
contracts.ts(1,1): error TS80003: invalid `defaultTag` value: `<nope>` is not a tag reachable from this package (contract of `<attributes>`)
```

An invalid value is dropped and the next rung answers. When a parent
contract's value was invalid and `object` then fails the parent's closed
`children`, the use-site error says so:

```text
doc.mx(1,13): error TS80001: `<attributes>`: `<object>` is not allowed here; allowed children: `<attribute>` (the parent's `defaultTag` `nope` is invalid; see the declaration)
```

**Tooling.** `mx.data.defaultTag` is read by `mx-tsc`'s data check and passed to
`parseData` by its caller. The language server, the TypeScript plugin and Vite
do not compile data files yet (TODO `data-target-tooling-dispatch`).

# Divergences from Marko

Decision 72: MX 1.0 is a strict subset of Marko syntax. Every MX 1.0 file is
a valid Marko file with the same meaning for the structural core, and
hosts may only *forbid* a tag they cannot honor, never add syntax, attribute
forms, or file conventions Marko's parser and language server would reject
(decision 71). Divergence from Marko is permitted only from MX 2 on, and only
deliberately: each divergence gets a line below (what, why, test), and a
divergence that changes syntax lands only together with the tooling it
breaks (grammar, Prettier, language server) — until then MX stays a subset.
The real-Marko oracle (`bun run oracle:marko`) remains a regression guard for
the structural core, no longer a contract in itself.

## Recorded divergences

| Divergence | Since | Reason | Test |
|---|---|---|---|
| _(none yet — MX 1.0 has no deliberate divergences)_ | | | |

## Fixed: undocumented divergence in the bare `${expr}` line

A standalone concise-position `${expr}` line (no attributes, no body) used to
lower to an escaped interpolation whenever no host claimed `DYNAMIC_TAG` —
treating Marko's placeholder-shaped `MarkoTag` as though it always meant a
text placeholder. Real Marko does not: Marko's own fixture
`error-dynamic-tag-name`
(`packages/hosts/html/fixtures-marko/error-dynamic-tag-name/`,
`static const tagName = "hello world"` then `${tagName}` at column 0) fails at
render with `"Invalid tag name"`, because it compiled to a dynamic tag, not a
placeholder. A bare `${expr}` line and `<${expr}/>` parse to the identical
Marko node (see the "four Marko facts" in `AGENTS.md`); MX 1.0's bare-is-text
special case was an undocumented divergence from that, never a recorded one.
Fixed: `@mxlang/core`'s `lowerTag` now treats both shapes as the dynamic-tag
construct — a claiming host still gets its `HostTag`, and an unclaiming host
gets a `Component` with a dynamic target instead of a silent `Interpolation`.
Text on its own line is written `-- ${x}`, and a placeholder inside an
HTML-syntax body (`<div>${x}</div>`) is unaffected — it parses as
`MarkoPlaceholder`, never `MarkoTag`, and never reaches `lowerTag`. Test:
`packages/core/src/lower.test.ts`, "a dynamic tag's bare shape".

## Deferred to MX 2

| Construct | Why it was wanted | Marko verdict | Test |
|---|---|---|---|
| Tag params on `<if>` (`<if\|u\|=cond>`) | Solid's `<Show>` callback form narrows the condition value for the branch body. | Rejected: `Tag does not support parameters.` | `packages/parser/src/mx/control.test.ts` — `uses the callback child form for tag params on if` |
| Tag params on native elements (`<div\|x\|>`) | A uniform “tag params make children a render prop” rule for every tag. | Rejected: `Tag does not support parameters.` | `packages/parser/src/mx/render-props.test.ts` — `lowers params on an HTML element the same way` |
| Attribute tags on native elements (`<div><@head>…</@head></div>`) | A uniform “attribute tags become props” rule for every tag. | Rejected: `Tag does not support nested attribute tags.` | `packages/core/src/resolve.test.ts` — `rejects an attribute tag outside a component` |
| `<fragment>` wrapper | An explicit wrapper for multiple Solid JSX children (in `.solid.mx`, use a TSX fragment `<>…</>`). | Rejected: `Unable to find entry point for custom tag <fragment>. Marko templates and tag bodies may have multiple root nodes; no fragment wrapper is needed.` | `packages/parser/src/mx/control.test.ts` — `lowers <fragment> to a JSXFragment` |

## Fixed: former `@mxlang/html` bugs

Two `@mxlang/html` implementation bugs against decision 67's rule ("the
translator should follow Marko") were recorded here as open. Both are now
fixed, and each fixture under `packages/hosts/html/fixtures-marko/` asserts
Marko's own error instead of carrying a `translator-bug` reason. No fixture
records a translator bug today, and `bun run oracle:marko` reports **0
translator bug** over 43 stock fixtures.

- **`unknown-element`**: real Marko treats an unresolved hyphenated tag as a
  failed custom-element lookup and refuses to compile ("Unable to find entry
  point for custom tag `<my-widget>`", verified against `@marko/compiler`
  5.42.5 / `marko@6.3.51`). `@mxlang/html` used to render it as literal HTML
  unconditionally. Fixed: `rejectUnknownTag` (`translate.ts`, called at resolve
  time) now rejects an unresolved hyphenated name with Marko's own wording.
- **`lowercase-component`**: real Marko rejects a lowercase local-variable tag
  reference outright ("Local variables must be in a dynamic tag unless they
  are PascalCase. Use `<${layout}/>` or rename to `Layout`.", same versions).
  `@mxlang/html` was binding-based regardless of case, so it called the import
  instead of erroring — strictly *more permissive* than Marko. Fixed:
  `rejectComponentTag` (`translate.ts`, called at resolve time) now rejects the
  same reference with Marko's own wording. The
  two forms that do work are covered by the `dynamic-tag-lowercase-import` and
  `nested-layout` fixtures.

## Candidates for MX 2

Not divergences today, and not bugs — behaviour MX could deliberately choose
to diverge on from MX 2 on, each still needing its own recorded row and the
tooling that goes with it before it ships.

- **Unknown custom elements in the vanilla host.** MX 1 follows Marko and
  refuses to compile an unresolved hyphenated tag (above). A future MX could
  instead let it through as a literal custom element, which is what a plain
  HTML author would expect from `<my-widget>`.

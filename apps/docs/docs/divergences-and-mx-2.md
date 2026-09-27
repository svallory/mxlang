---
title: "Divergences and MX 2"
description: "Divergences from Marko and the MX 2 deferred list."
---

# Divergences from Marko

MX 1.0 uses a strict subset of Marko syntax. Every MX 1.0 file remains valid
Marko syntax, but decision 106 deliberately changes the runtime value of
attribute tags so a consumer can state its cardinality and shape. Syntax
divergences remain reserved for MX 2 and must land with the tooling they affect.

## Recorded divergences

### Attribute-tag values

The syntax is shared; the received value is not.

| Question | Marko 6 | MX |
| --- | --- | --- |
| Cardinality | One `attrTag`/`attrTags` record is iterable even for one occurrence. | `x?: AttrTag`, `x: AttrTag`, or `x: AttrTag[]` chooses 0..1, exactly 1, or a real array. |
| Repeated attributes | Direct property reads expose the first item's attrs; iteration reaches all occurrences. | Each array item owns its attrs, nested tags, and `content`. |
| Attribute passing | Marko can tree-shake attributes the callee never reads. | MX passes every authored attribute. |
| Untyped body-only fallback | A bare renderable works in render-prop APIs. | The same bare renderable is preserved by decision 108. Attrs or nested tags switch every occurrence of that property to data; repeats/loops independently switch it to an array. |

The reason is an explicit consumer contract: MX can reject a repeated singular,
an omitted required block, or a loop that would violate cardinality before a
host silently loses data. Arrays are ordinary JavaScript arrays across value
hosts.

For migration, declare every named block in the callee's exported `Input`.
Use `AttrTag[]` anywhere Marko code iterates, change direct body rendering of a
data tag to `.content`, and opt into `as: "renderable"` only for body-only
render-prop APIs. Code that reads attributes directly from a repeated Marko
record should select an MX array item explicitly. See the complete
[AttrTag guide](/language/attr-tag/).

## Deferred to MX 2

| Construct | Why it was wanted | Marko verdict |
|---|---|---|
| Tag params on `<if>` (`<if|u|=cond>`) | Solid's `<Show>` callback form narrows the condition value for the branch body. | Rejected: `Tag does not support parameters.` |
| Tag params on native elements (`<div|x|>`) | A uniform "tag params make children a render prop" rule for every tag. | Rejected: `Tag does not support parameters.` |
| Attribute tags on native elements (`<div><@head>…</@head></div>`) | A uniform "attribute tags become props" rule for every tag. | Rejected: `Tag does not support nested attribute tags.` |
| `<fragment>` wrapper | An explicit wrapper for multiple Solid JSX children (in `.solid.mx`, use a TSX fragment `<>…</>`). | Rejected: `Unable to find entry point for custom tag <fragment>.` |

## Fixed: former HTML host bugs

Two cases where the HTML host was more permissive than Marko were implementation bugs against the rule "the translator should follow Marko", not intentional divergences. Both are fixed, and the Marko-parity oracle reports no translator bugs across the stock fixture set:

- **`unknown-element`**: real Marko treats an unresolved hyphenated tag as a failed custom-element lookup and refuses to compile. The host used to render it as literal HTML unconditionally; it now rejects it with Marko's own wording.
- **`lowercase-component`**: real Marko rejects a lowercase local-variable tag reference outright. The host was binding-based regardless of case, so it called the import instead of erroring; it now rejects it with Marko's own wording. The forms that do work are `<${layout}/>` and `<Layout/>`.

## Candidates for MX 2

Not divergences today, and not bugs — behaviour MX could deliberately choose to diverge on from MX 2 on, each still needing its own recorded row and the tooling that goes with it before it ships.

- **Unknown custom elements in the vanilla host.** MX 1 follows Marko and refuses to compile an unresolved hyphenated tag. A future MX could instead let it through as a literal custom element, which is what a plain HTML author would expect from `<my-widget>`.

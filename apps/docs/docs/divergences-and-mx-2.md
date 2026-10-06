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

### Modifier on a bound attribute

Decision 169 (with 158.1). Measured against Marko 6.3.51 (`@marko/compiler` 5.42.10, `marko/translator`, html output):

| Input | Marko 6.3.51 | MX |
| --- | --- | --- |
| `<div v:fn:=q/>` | binds `v`; client change handler `vChange` runs `q = fn(_new_q)` | one positioned error at the colon |
| `<div is:raw:=x/>` | binds `is`; handler `x = raw(_new_x)` | same error |
| `<div v:raw:=q/>`, `<div v:scoped:=q/>` | binds `v`; handler applies `raw` / `scoped` | same error |
| `<div v:no-update:=q/>` | error: "Bound attribute refinement shorthand must be a valid JavaScript identifier." | same MX error as the others |
| `<foo v:fn:=q/>` (custom tag) | passes `{ v: q }` in the html output, handler on the client | same error |
| `<div v:fn=q/>` (not bound) | attribute named `v:fn` | unchanged |

Marko has no fixed modifier list: any identifier is a function applied to the incoming value in the change handler. MX has no refinements, and lowering `v:fn:=q` as a bound `v` would drop the handler silently, so core refuses it and names the explicit form (`v=q` plus `vChange(next) { q = fn(next) }`). The empty modifier `x::=q` is the same error.

## Deferred to MX 2

| Construct | Why it was wanted | Marko verdict |
|---|---|---|
| Tag params on `<if>` (`<if|u|=cond>`) | Solid's `<Show>` callback form narrows the condition value for the branch body. | Rejected: `Tag does not support parameters.` |
| Tag params on native elements (`<div|x|>`) | A uniform "tag params make children a render prop" rule for every tag. | Rejected: `Tag does not support parameters.` |
| Attribute tags on native elements (`<div><@head>…</@head></div>`) | A uniform "attribute tags become props" rule for every tag. | Rejected: `Tag does not support nested attribute tags.` |
| `<fragment>` wrapper | An explicit wrapper for multiple Solid JSX children (in `.solid.mx`, use a TSX fragment `<>…</>`). | Rejected: `Unable to find entry point for custom tag <fragment>.` |

## Fixed: former html target bugs

Two cases where the html target was more permissive than Marko were implementation bugs against the rule "the translator should follow Marko", not intentional divergences. Both are fixed, and the Marko-parity oracle reports no translator bugs across the stock fixture set:

- **`unknown-element`**: real Marko treats an unresolved hyphenated tag as a failed custom-element lookup and refuses to compile. The host used to render it as literal HTML unconditionally; it now rejects it with Marko's own wording.
- **`lowercase-component`**: real Marko rejects a lowercase local-variable tag reference outright. The host was binding-based regardless of case, so it called the import instead of erroring; it now rejects it with Marko's own wording. The forms that do work are `<${layout}/>` and `<Layout/>`.

## Withdrawn MX behaviour

- **`<define>` per-parameter name lookup (4ba13a4ea):** withdrawn by decision 160. This is NOT a Marko divergence: MX now matches Marko 6.3.51 on html, preact, react and hono, where a `<define>` called with attributes receives one attribute object in its first parameter; a define with 2 or more params called that way gets a positioned warning there. Solid and Angular keep their older shape until `define-call-attrs-solid` and `define-call-attrs-angular` land.

## Candidates for MX 2

Not divergences today, and not bugs — behaviour MX could deliberately choose to diverge on from MX 2 on, each still needing its own recorded row and the tooling that goes with it before it ships.

- **Unknown custom elements in the vanilla host.** MX 1 follows Marko and refuses to compile an unresolved hyphenated tag. A future MX could instead let it through as a literal custom element, which is what a plain HTML author would expect from `<my-widget>`.

---
title: "Layer 1: tags and contracts"
description: "Extending MX without touching the parser: custom tags, sidecars, contracts, package tag sets and the hooks they get."
---

# Layer 1: tags and contracts

**Status:** planned; most of it is shipped and documented under
[Custom tags](/custom-tags/). This page states what the layer is and what it
can and cannot express, so the layers above are measured against it.

Layer 1 is every extension that needs no parser involvement. The surface it
offers today:

- **Template tags** (`tags/x.mx`), compiled as units and called like
  components; `<return>` and `/var`.
- **Sidecars** (`tags/x.tag.ts`) with `transform`, `analyze`, `finalize`, and
  `parseOptions` read statically before the parse.
- **Contracts** (`mx.contracts`, a "dialect package" in the custom-tags
  docs: a tag vocabulary with validation rules): `attributes`,
  `attributeTags`, `children`, `parents`, `declares`.
- **Package tag sets** (`mx.tags`) with per-host filtering, discovered from
  the nearest `package.json` upward.
- **Build hooks** a transform may use: `ctx.build`, `ctx.hoist`,
  `ctx.bindings.register`, delegated tags (`isDelegatedTag`).
- **Wildcard children** (`children["*"]`) resolved in one top-down walk.

## What layer 1 can express that MX itself used to carry

- `<try>` is a core-owned custom tag today; the same shape is reachable from
  a sidecar transform plus a host claim.
- `<fragment>` is a transform that returns its children.
- A narrowing conditional (`<when|u|=cond>`) is a custom tag; the name `<if>`
  itself is core and cannot be shadowed, so the layer adds forms under new
  names, never changes core ones.

## What layer 1 cannot express

Anything that changes where a token begins or ends: a new delimiter, a sigil
in expression or text position, a block form, a filter block. Those are layer
2. Anything that changes an existing core form's meaning (attribute grammar,
structural tags, element resolution) is the core and is not extensible.

## Hooks shared with layer 2

`afterLower(ir, ctx)` runs once per unit after lowering. The first user is
the Mesh contract checker (atom contracts), which moves out of core behind
it. A layer-1 package may use it for whole-unit checks that `finalize`
cannot do, because `finalize` sees one tag's calls, not the unit.

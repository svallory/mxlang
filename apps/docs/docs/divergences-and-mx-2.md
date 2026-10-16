---
title: "Divergences and MX 2"
description: "Where MX departs from Marko, and what is deferred to MX 2."
---

# Divergences from Marko

Marko is the default for `.mx`: where MX has no rule of its own, a `.mx` file
means what Marko says it means. MX does not promise to be a subset or a
superset of Marko. It departs from Marko where it has a reason to, and every
departure is recorded, with its reason and the test that pins it, in
[`divergences.md`](https://github.com/svallory/mxlang/blob/main/divergences.md)
at the repository root. That file is the canonical list; this page summarises
it.

A divergence is a rule MX applies on a web-UI target or host (html, the JSX
hosts, Solid, Angular, Astro) that contradicts Marko on the same source.
Behaviour that exists only under a dialect, the `none` tag-rules preset, core's
IR entry point or a non-web target is never a divergence: a dialect is a
language of its own built on MX's machinery.

## What the list covers

- **Errors where Marko is silent.** MX refuses some sources Marko compiles:
  `<effect>` in any form (use `<script>`), a `<let>` write in render position,
  reading a derived `<const>` after writing the `<let>` it depends on, reading a
  tag variable where it has no value yet, an `import` that is not one ES import
  declaration, a module name declared twice, and Unicode space characters that
  look like whitespace inside a tag.
- **Host limits.** A host refuses what its framework cannot express (`/var` on
  a dynamic tag on the JSX hosts, statement-bodied handlers on Angular,
  `<define>` attributes on Solid and Angular), and renders a few attributes the
  way its framework does (boolean properties on React, Astro and Angular).
- **Files Marko reads that MX does not.** `.marko` files are not an MX input,
  and `marko.json` is not read.
- **Small widenings.** A duplicate attribute is a warning, a dynamic tag that
  resolves to a plain function keeps its return value, and the template parser
  treats non-ASCII letters and Unicode whitespace as a JavaScript reader would.

## Attribute tags

An attribute tag (`<@item>`) has the same value on every target as in Marko:
Marko's own record, iterable over every occurrence, with a hidden `rest`. MX
adds `map`, `filter`, `length`, `at` and `toArray` on the record's prototype,
so the record's own properties are unchanged and the extra members are never
spread or serialized. An absent attribute tag is `undefined`, as in Marko. See
[specification §8](/specification/); the [AttrTag guide](/language/attr-tag/)
still describes the shape that ships today.

## Deferred to MX 2

These were wanted, and Marko rejects them. They wait for MX 2, where each will
need its own row and the tooling that goes with it.

| Construct | Why it was wanted | Marko verdict |
|---|---|---|
| Tag params on `<if>` (`<if|u|=cond>`) | Solid's `<Show>` callback form narrows the condition value for the branch body. | Rejected: `Tag does not support parameters.` |
| Tag params on native elements (`<div|x|>`) | A uniform "tag params make children a render prop" rule for every tag. | Rejected: `Tag does not support parameters.` |
| Attribute tags on native elements (`<div><@head>…</@head></div>`) | A uniform "attribute tags become props" rule for every tag. | Rejected: `Tag does not support nested attribute tags.` |
| `<fragment>` wrapper | An explicit wrapper for multiple Solid JSX children (in `.solid.mx`, use a TSX fragment `<>…</>`). | Rejected: `Unable to find entry point for custom tag <fragment>.` |

## Candidates for MX 2

Not divergences today: behaviour MX could choose to diverge on from MX 2 on.

- **Unknown custom elements on the html target.** MX follows Marko and refuses
  to compile an unresolved hyphenated tag. A future MX could let it through as
  a literal custom element, which is what a plain HTML author expects from
  `<my-widget>`.

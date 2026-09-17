---
title: "Custom tags"
description: "Define portable compile-time tags once, as templates or TypeScript sidecars."
---

# Custom tags

A custom tag gives a project its own markup vocabulary. Define `<icon>` once and call it like any other tag, without importing it at each call site. A tag's template is a **compilation unit**: it compiles to a module through the same per-file pipeline a page uses, and the caller emits an import plus a call. Discovery only maps a tag name to a path, so the same definition works on HTML, Astro, React, Preact, Hono, and Solid.

Custom tags do not add an IR kind and cannot inspect the active host. An emitter sees only the ordinary elements, branches, loops, expressions, host primitives and component calls it already knows how to render.

## Two authoring layers

| Layer | File | Reach for it when |
| --- | --- | --- |
| **L1: template** | `tags/x.mx` | Markup and structural tags can express the tag. This is the default: smallest surface, readable as MX, portable by construction. |
| **L2: sidecar** | `tags/x.tag.ts` | The tag must validate a contract, compute IR, reject a call, change parsing, or collect all calls in a file. |

The layers compose. Put both files beside each other when a template needs declarations or a small amount of compile-time logic. A declaration-only sidecar adds validation and parse options while the call still routes to the template. A sidecar with `transform` takes control: it may build its own IR, or hand the call back to its template with `ctx.build.template(call)`.

Raw parser hooks are a later layer, deferred until after MX 1.x. They are not part of the current custom-tag API.

## Thirty seconds to a tag

Create `tags/icon.mx`:

```marko
<svg width=input.size ?? 24 class=input.class>
  <title>${input.name}</title>
</svg>
```

Then use it from a template below the same package root:

```marko
<p><icon name="check" size=16 class="row"/></p>
```

There is no import or registration step. The scanner walks upward from the calling file, finds `tags/icon.mx`, and registers its basename as `<icon>`. This exact pair is the core's passing end-to-end discovery fixture.

## Discovery in one paragraph

For each file, MX walks toward the nearest `package.json`, collecting `tags/` directories as it goes. The nearest definition of a name wins. A package can add shared directories through `package.json#mx.tags`; those entries have lower precedence than local `tags/`. A programmatically supplied `customTags` definition has highest precedence. The Bun loaders, Vite and Astro integrations, TypeScript plugin, language server, and `mx-tsc` all use the same synchronous scanner, so builds and editor diagnostics resolve the same tag set.

## Continue

- [Template tags](/custom-tags/templates/) — inputs, slots, returning a value with `<return>`, hygiene, limits, and errors.
- [Sidecars](/custom-tags/sidecars/) — declarations, builders, transforms, and file-wide collection.
- [Discovery](/custom-tags/discovery/) — directories, package configuration, invalidation, and diagnostics.
- [API and diagnostics reference](/custom-tags/reference/) — the exported TypeScript contract and every custom-tag diagnostic.

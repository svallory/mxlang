---
title: "Core and hosts"
description: "How @mxlang/core and each host divide responsibility."
---

# Core and hosts

`@mxlang/core` is the half of MX that is the same for every host. It depends on `@marko/compiler` and nothing else: it consumes Marko's AST, applies the structural lowerings — `<if>`, every `<for>` form, `<define>`, `<const>`, statement tags, and a set of guards that reject unsupported node shapes — and resolves the result into a host-independent [IR](/architecture/ir/).

## Resolve, then emit

The pipeline has three stages, with lowering and emission kept as separate interfaces:

1. **Parse.** `@marko/compiler` produces the Marko AST for a whole file or fragment.
2. **Lower.** `lower()` validates structure and expands [custom tags](/custom-tags/) here, recursively, until only ordinary host-independent IR remains. It asks the host's `HostDeclarations` object the questions it cannot answer itself — is this name an element or a component, is this tag inert or an error here, how should this modifier be rejected in your words.
3. **Emit.** The host's `Emitter<Out>` walks that IR, one method per kind, driven by the core's `drive()`. An emitter never sees a Marko node or a custom-tag call; a lower-time host decision reaches it through `DelegatedTag.data`.

Keeping the two apart is what stops a host from re-deriving structure while it prints, and it is why the IR is the only thing an emitter needs to understand.

## What belongs where

| Belongs to the core | Belongs to a host |
| --- | --- |
| The structural tag lowerings (`<if>`, `<for>`, `<define>`, `<const>`, statement tags) | The disposition table: which tags are inert, which are errors, and why |
| Guards against unsupported fields and node shapes | Component-versus-element resolution |
| Resolving Marko's AST into the IR | Emitting each IR kind into the target's own syntax |
| Expanding custom tags into ordinary IR | Defining the primitive a custom tag may request by name |
| The two front doors (`compileSource`, `parseFragment`) | Structured attribute values (`class`, `style`), attribute order, modifiers |
| The `escape` helper | Stateful tags (`<let>`, `<effect>`, `:=`), through three hooks |
| Positions on every IR node | Its own integration — a Vite plugin, a Bun loader, a TypeScript plugin |

A host is small because most of the work — parsing, structural lowering, guarding against nonsense — never has to be rewritten. See [Declarations and hooks](/architecture/policy-and-hooks/) for the full contract a host implements.

## Two front doors

**`compileSource(source, filename, policy, host?)`** compiles a whole file through `@marko/compiler`'s translator seam. This is what a host uses when the entire file is MX — the html target's `.mx` files, for example.

**`parseFragment(source, { filename, baseOffset, baseLine, baseColumn })`** parses a Marko *substring* embedded inside a larger file, with every position shifted so error locations and source maps point at the right place in the outer file. This is what a host uses when MX syntax sits inside something else — Astro's `.astro.mx` templates (MX after a frontmatter fence) and SolidMX's `.solid.mx` files (MX in JSX's position inside a TSX file) both use this door.

## Statement-shaped and expression-shaped hosts

Every host emits from the same IR, but targets fall into two shapes, and the difference shows up in the emitter rather than anywhere in the core.

**Statement-shaped.** The html target builds a string by appending: `out += "..."`, one block per function, ending in a conventional module (an `escape` import, the author's hoisted statements, one branded default-exported render function). An `<if>` becomes a real `if` statement.

**Expression-shaped.** JSX has no equivalent of `out += "..."`, so the Solid, Preact, React, Hono and `.astro.mx` emitters produce a single expression instead. An `<if>` becomes a ternary, a `<Show>`, or a `<Switch>` — whatever that target's own author would have written.

Both walk the same IR through the same `drive()`. What differs is only what each method writes, which is why adding a target to an existing emitter can be as small as a vocabulary object: the React and Hono hosts are both the Preact emitter plus a `JsxDialect` naming the JSX import source, the class/for attribute spelling, and the runtime module.

## What a host emits, and what it does not

A host emits its target framework's **ordinary public input language** — plain JSX source text, or an ordinary string-concatenation function body — exactly the shape a human would have written by hand. The target's own toolchain then runs over that text unmodified.

This is what keeps a host from becoming a second compiler for its framework. MX prints; Solid's compiler, Babel, or the bundler compiles. A host that emitted optimized or pre-compiled output would have to track its target's internals forever.

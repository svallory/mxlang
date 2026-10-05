---
title: "The IR"
description: "The intermediate representation between the core and hosts."
---

# The IR

The core resolves structural markup into an intermediate representation (IR) first, and a host acts as a thin emitter that prints that IR into its target framework's own public input language.

"Prints into its target framework's own public input language" is the important constraint. A host does not emit compiled or optimized output — it emits ordinary JSX source text, or an ordinary string-concatenation function body, exactly the shape a human author would have written by hand. The host's normal toolchain (Babel, a bundler, the target framework's own compiler) then runs on that text unmodified, the same way it runs on anyone else's code. This is what keeps a host from becoming a second compiler for its target framework: it is a printer, not a compiler.

A host's job is to: resolve structure once in the core, then write an emitter for one IR to one target syntax.

This page introduces the IR. The normative contract — every field, which are required, the position rules, and the invariants emitters rely on — is the [IR specification](/architecture/ir-spec/).

## The node kinds

Every kind carries a source position (`loc`, the start of the construct), which is what lets a diagnostic point back at the original MX file; most also carry source spans, which is what source mappings are built from.

| Kind | What it holds |
| --- | --- |
| `Text` | Literal text, already whitespace-normalized by Marko's own rules |
| `Interpolation` | An expression, plus whether it is escaped (`${}`) or raw (`$!{}`) |
| `Element` | A native HTML/SVG/MathML element: attributes, children |
| `Component` | A component call: attributes, children, attribute tags, tag params |
| `IfChain` | The whole `<if>` / `<else-if>` / `<else>` chain as a list of branches |
| `For` | Any `<for>` form — its source is `of`, `in`, or a `range` (with an optional `step`) — plus the resolved `key` |
| `Define` | A `<define>`, with its name and params |
| `Const` | A `<const>` binding: name and initializer |
| `DelegatedTag` | A tag this host claimed, with whatever `resolveDelegatedTag` recorded in its `data` slot |
| `DocumentType` | `<!doctype html>` |
| `Comment` | A comment, and whether it was an HTML comment or a `//` line comment |
| `Hoisted` | A statement a host lifted with `ctx.hoist`; it reaches the walk only at the head of a `Define`'s children, and the render function's own hoists are in `Ir.prelude` |

Four more kinds are *module-level* and never reach the emitter's walk. `lower()` lifts them out of the body into `Ir`'s own fields, so a host places them from there rather than filtering the tree: `Import`, `Static`, `Export`, and `InputInterface`. Each carries an `end` position beside its start, as `Hoisted` does, because their code is a plain string mapped whole-block rather than per expression. `drive()` throws if one reaches the walk.

## The emitter side

A host implements `Emitter<Out>` — one method per kind, plus `done()` returning the finished output — and the core's `drive()` owns the walk:

```typescript
interface Emitter<Out> {
  text(node): void;
  interpolation(node): void;
  element(node): void;
  component(node): void;
  ifChain(node): void;
  forLoop(node): void;
  define(node): void;
  constant(node): void;
  hoisted(node): void;
  delegatedTag(node): void;
  documentType(node): void;
  comment(node): void;
  done(): Out;
}
```

`Out` is the host's output type — a string for the JSX hosts, Solid, Astro and Angular, and an array of `__mxOut +=` lines for the html target. Using `drive()` is not mandatory: `@mxlang/data` walks the IR directly, and throws on any kind its declarations make unreachable.

A host that cannot express a kind **throws**, naming the construct. There is no optional method and no default no-op, deliberately: an emitter that could silently skip a kind would compile a template and quietly drop part of it, which is exactly the failure the IR split was meant to make impossible.

## Where a host's own decisions live

No IR field is specific to one target. The host does shape *which* nodes appear — through its `HostDeclarations` answers it decides whether a tag is an element, a component or a delegated tag, may rename a modifier attribute or reorder attributes, and names a discovered tag's import binding — but a host-specific decision about how to *render* a construct travels in `DelegatedTag.data`, opaque to the core — which is how `<try>` becomes `<Loading>`/`<Errored>` on Solid, a `try`/`catch` on the html target, and an error boundary on React, from one IR kind and no special-casing in `packages/core`.

The two exceptions prove the rule: `For` carries a `key`, and a range source carries `step`. Both are structural facts any Marko-syntax host needs regardless of target, not a concession to one framework.

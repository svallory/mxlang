---
title: "ADR 155: the render model, output to a sink and `<return>` as the return value"
description: "Why a compiled html-family unit writes its output into a sink and returns its <return> value, instead of returning a string or a { value, output } pair."
---

# ADR 155: the render model

**Status:** accepted 2026-10-05 (decision 155 in the decisions log). **Scope:** the html family: the html target, and Astro's `.mx` leaf components and pages, which use its emitter. The data target has no output and is unchanged. The JSX hosts return elements and keep their own `/var` mechanism until the multi-host plan revisits it.

## Context

A compiled html unit returned its output as a string, or, when it declared `<return>`, the pair `{ value, output }`. The call site had to know which shape it would get, and it could only know for a callee the compiler could see: a discovered tag, or a default import of a `.mx` file. Every other route to a returning unit broke silently:

- a dynamic tag (`<${Counter}/>`) or a `.ts` barrel re-export concatenated the pair and rendered `[object Object]` (TODO `dynamic-tag-return-unit-object-object`);
- `/var` on a dynamic tag was dropped, so reading the binding threw at render time (TODO `dynamic-tag-var-silent-drop`).

The value was travelling inside the output. Marko never has this problem: a tag writes into a shared writer, and `<return>` travels separately as the tag's own return value. MX follows Marko's semantics (Marko 6.3.51 binds a dynamic tag's return value and renders a barrel-re-exported tag's body), so the question was how far to follow its model.

## Decision

A compiled unit has two entries:

1. `render(input, out)` writes its HTML to `out` and returns its `<return>` value (`undefined` without one).
2. The default export keeps its public signature, `(input) => string`: it creates an `out`, calls `render`, and returns the string. `render` is reachable from it as `Name.render`, and is also the named `render` export.

Between units the emitter always passes the caller's sink down, and `/var` is `render`'s return value, dynamic tags included. A callee that the compiler cannot see is dispatched at run time: **a callee with `.render` is a template, anything else is a function returning a string**. Nothing inspects what a callee returns.

`out` is `@mxlang/html/runtime`'s `Out`, which has two members, `write` and `toString`, so a streaming implementation can replace it later without touching emitted code. `<try>` renders its body into a buffered sub-sink (`createBufferedOut`) that is committed when the body finishes and dropped when it throws.

Rendered HTML is byte-identical for every template that does not throw inside a `<try>`: the oracles stay green and only emitted-code goldens change. A `<try>` body that throws after writing now drops the partial output, which is what Marko renders. Before this decision the target kept it.

## Alternatives considered

| Option | Why it was rejected |
|---|---|
| Keep returning a string, and put the value in a side slot (a module-level or context variable the callee sets and the caller reads) | Sound only while rendering is synchronous and strictly nested. Streaming, or any async boundary, interleaves callers and corrupts the slot. It also leaves the shape problem in place for every consumer that holds a callee. |
| One unified `{ value, output }` object from every unit | A façade over the same string building. Every caller and every host still has to unwrap the pair, the sink rewrite is only deferred, and a hand-written function tag returning a string still needs a shape check. |
| Brand the returning unit's result (or the unit), and unwrap branded pairs in the dynamic-render helpers | A patch for the two TODOs. It keeps the value inside the output, adds a runtime convention every consumer must know about, and does nothing for streaming. |
| The Marko model: output to a sink, `<return>` as the return value | **Chosen.** It is what the language already means. A tag's output and its value are different channels, so no consumer ever has to tell them apart. The sink is also the seam streaming needs. |

The operator chose the Marko model on long-term cost. The one-off cost of rewriting the emitted-code goldens did not decide it.

## Consequences

- Every compiled module imports the runtime (`createOut`) at run time. Before, a template with no interpolation compiled with an unused `escape` import that TypeScript elided, so it had no run-time dependency on `@mxlang/html`. A consumer always has the package installed, so this changes nothing in practice. Test fixtures that nest their own `package.json` now link it.
- Emitted code writes with `__mxOut.write(…)` instead of `__mxOut += …`. Tools that match the emitted text (Astro's page wrapper, its type surface, the html brand pass) anchor on the default export and the brand tail, which are unchanged apart from the `Name.render = …` line that Astro's page wrapper now carries along with its rename.
- A statically named tag that the compiler does not know is a template (a hand-written function, a barrel re-export, a `.mx` import without `<return>`) is called through `__mxRenderTag(out, Callee)(props)`. TypeScript sees `Callee` itself, so the props are checked exactly as before, generics included.
- `content` blocks, `<define>` calls and renderable attribute tags stay `(…params) => string`, which is what hand-written tags receive and call.
- Out of scope, and PR 2 of this decision: the Astro renderer's now-dead `{ value, output }` unwrap, and the Hono, Bun loader, `mx-tsc` and language-server consumers.

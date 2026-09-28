---
title: "Stateful tags"
description: "Why <let>, <effect>, and friends mean whatever the host says."
---

# Stateful tags

`<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client` blocks, `<id>`, and the `:=` assignment operator are **not** part of the portable structural core. They're framework territory: MX's core provides three hooks a host can use to give these tags real meaning, and each host's `Policy` decides what happens.

A template using `<let>` means something different depending on which host compiles it — the same way a piece of JSX means something different depending on which framework's compiler processes it. The structural tags in [Structural tags](/language/structural-tags/) are portable across hosts; stateful tags are not.

## The HTML host's policy

The HTML host has no reactive runtime — it compiles a template to a plain `(input) => string` function — so its default policy treats stateful tags as **inert**: they're accepted, produce no output, and are verified to behave exactly like Marko's own server render (which also strips these to nothing once its resume markers are removed).

| Tag | Default behavior |
|---|---|
| `<effect>`, `<lifecycle>`, `<script>`, `<id>`, `<log>`, `<debug>`, `client` blocks | Inert — accepted, no output |
| `<let>`, `<const>`, `:=` | Evaluated for their initial value only |
| `server` block | **Not** inert — this is the server render, so it runs like `static` and its bindings are readable in the template |
| `<await>` | Error — the host genuinely can't render a pending value to a string |
| `<try>` with `<@placeholder>` | Error — needs a second render pass the host doesn't have |
| `<try>` with only `<@catch>` | Lowers to an ordinary `try`/`catch` |
| `<return>` | Not an error — a tag is its own compiled module under the unit model, so its caller invokes it; the module's export becomes `{ value, output }` and the call site unwraps it. `/var` is supported in any scope. See [Returning a value](/custom-tags/templates/#returning-a-value) for the full grammar, `/var` scoping per host, and the JSX-hooks restriction. |

"Inert" is a shape, not a license to silently drop content: an inert tag's own attributes and body are validated against what Marko's own tag definition allows, and anything unexpected is a compile error naming the tag — not silently discarded.

### Opting into `strict`

Pass `{ strict: true }` to reject the same six constructs (`<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client` blocks, `<id>`) as compile errors instead of treating them as inert, for an author who wants "this template needs a reactive runtime" enforced at compile time rather than silently accepted and ignored.

The one check that applies regardless of `strict` is the `input`-shadowing guard: a `<let>` or `<const>` binding named `input` is always rejected, since it would silently break the template's own input parameter either way.

## How other hosts differ

A reactive host — Solid, Preact, React, Hono, Astro, or Angular — implements the same six constructs against its own framework's primitives instead of treating them as inert — `<let>` becomes real state, `<effect>` becomes a real side effect. Parity with Marko's server render doesn't apply here, because there is no server render to match: the host is tested against its own framework's behavior.

Mechanically, a host reaches this behavior through three hooks the core exposes: a handler for the stateful tag itself, a way to hoist a statement to the enclosing function's head, and a registry for rewriting identifier references (so, for example, a getter-based state primitive can emit `count()` everywhere `${count}` appears). See [Policy and hooks](/architecture/policy-and-hooks/) for how these fit together.

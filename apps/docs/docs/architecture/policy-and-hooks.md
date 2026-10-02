---
title: "Declarations and hooks"
description: "The HostDeclarations interface a host implements, and the three hooks for stateful tags."
---

# Declarations and hooks

A host supplies one `HostDeclarations` object to `@mxlang/core`. Every member answers a question the **resolver** asks while turning Marko's AST into IR — none of them emit anything. Emission is a separate interface, [`Emitter<Out>`](/architecture/core-and-hosts/), called later over the resolved IR.

| Member | What it decides |
| --- | --- |
| `tags` | Per-tag-name disposition: `inert` (accepted, produces no output, in a declared shape) or `error` (this target cannot express the tag). |
| `isElement(name, ctx)` | Whether an unbound lowercase tag name is a real HTML/SVG element. |
| `isComponent(name, ctx)` | Whether a tag name resolves to a component in this host. |
| `isDelegatedTag?(name, ctx)` | Whether this host handles the tag itself, rather than letting the core route it to a component or an element. |
| `resolveDelegatedTag?(name, node, ctx)` | Records what this host decided about a claimed tag, into the `DelegatedTag` node's `data` slot. |
| `rejectModifier?(attr, on)` | Rejects an attribute modifier (`class:active`) in this host's own words. |
| `resolveModifier?(attr, on)` | Accepts a modifier a host keeps as target syntax, returning the emitted name. |
| `rejectAttributeMethod?(…)` | Rejects an attribute method (`onClick() { … }`) in this host's own words. |
| `resolveAttributeMethod?(…)` | Accepts an attribute method a host can express, instead of rejecting it. |
| `rejectElementAttributeTags?(…)` | Rejects an attribute tag on a native element. |
| `rejectComponentTag?(…)` / `rejectUnknownTag?(…)` | This host's wording for an unresolvable tag. |
| `orderAttrs?(tagName, attrs)` | Reorders an element's attributes, for a target that must emit them in an order other than the author wrote them — this is what reproduces Marko hoisting `value` before `type` on an `<input>`. |
| `checkBinding?(target, what)` | Inspects a name a construct is about to bind at render scope — not called for tag params, which open their own nested scope. |
| `keepComments?` | Whether an HTML comment reaches the compiled output. |

`Policy` still exists as a name, but only as a compatibility alias of `HostDeclarations`.

Two patterns are worth noticing. The `reject*` hooks exist so a host phrases its own diagnostics: a Marko-parity target quotes Marko's own fix-it, which reads very differently from a generic "not supported here". And `isDelegatedTag`/`resolveDelegatedTag` replaced a single `emitSpecial` that decided by emitting and *then* returning true or false — declaring the claim up front is what lets the resolved `DelegatedTag` node carry the decision in its `data` slot, so the emitter never needs the original Marko node.

## The three stateful-tag hooks

MX itself defines no meaning for `<let>`, `<effect>`, `<lifecycle>`, `<script>`, or `:=` — those are framework territory, and each host that wants them gives them its own semantics through three capabilities the core provides.

**1. The tag handler — `isDelegatedTag` / `resolveDelegatedTag`.** Every tag the core has no lowering of its own for is offered to the host by name before the core decides whether it's a component or an element; `isDelegatedTag` returning true claims it. The tag then resolves to the `DelegatedTag` IR kind — attributes, children, attribute tags, params and `var` already resolved — and `resolveDelegatedTag` stores whatever the host decided in its `data` slot, for the host's emitter to read. A host implements a stateful tag like `<signal/count=1/>` here.

**2. Hoisting — `ctx.hoist(code)`.** Lifts a statement to the head of the enclosing function — the render function, or the nearest nested function a `<define>` opened. This is how a declaration written inside a conditional still resolves for code that runs after the conditional:

```html
<if=input.on>
  <signal/count=7/>
</if>
<p>${count}</p>
```

A host that implements `<signal>` with `ctx.hoist` would emit `const count = 7;` at the function head, above the `if` — so the reference in `<p>` after the branch still resolves, regardless of whether the branch ran.

**3. The binding registry — `ctx.bindings.register(name, rewrite)`.** Rewrites identifier *references* to a name the host owns. A host whose reactive state is a getter function — reading it means calling it — registers `count` with a rewrite of `ref => \`${ref}()\``, so `${count + 1}` in the template emits `count() + 1` instead of the raw identifier.

This only rewrites reference *positions*, never declarations: `obj.count` and an object literal's `count:` key are left untouched. Shadowing is respected — a parameter or local declaration of the same name inside an expression shadows the host's binding for that scope, so `xs.map(count => count)` is untouched while `xs.map(x => x + count)` is rewritten. The core does not go further than this; if a host's own construct needs more precise shadowing behavior than reference-position rewriting gives it, that is the host's responsibility to get right.

---
title: "Why MX has no resume"
description: "Marko's html output minus its runtime is already a precompiled template language — and that observation is where the html target comes from."
---

# Why MX has no resume

Marko's `html` output, with the runtime subtracted, is a precompiled template language with typed TypeScript expressions and a working language server. Marko's `dom` output, with hydration (resume) subtracted, is a client-only reactive template runtime. Neither observation needs new syntax, a new parser, or new tooling — both are things Marko's compiler already does, minus a part it also does.

## What "minus the runtime" means

Consider a template using only the structural core — `<if>`, `<for>`, `<const>`, `static`, `import`, attribute tags:

```html
export interface Input { user: { name: string }; items: Item[] }
import Button from "./button.mx"

<ul class="list">
  <for|it, i| of=input.items>
    <li class=(i % 2 ? "odd" : "even")>${it.name}</li>
  </for>
</ul>
<if=input.items.length === 0><p>Nothing</p></if>
<Button primary label="Go"/>
```

None of these constructs need a scheduler, signals, or a hydration handshake to mean something. Each one has exactly one meaning: run this, once, in order, and produce bytes. The natural compiled shape is exactly what you'd hand-write:

```typescript
import { escape as $e } from "escape";
import Button from "./button.mx";

export default function (input: Input): string {
  let out = '<ul class="list">';
  for (let i = 0; i < input.items.length; i++) {
    const it = input.items[i];
    out += `<li class="${$e(i % 2 ? "odd" : "even")}">${$e(it.name)}</li>`;
  }
  out += "</ul>";
  if (input.items.length === 0) out += "<p>Nothing</p>";
  out += Button({ primary: true, label: "Go" });
  return out;
}
```

That is a complete precompiled template language: typed `${}` expressions, real components resolved by import, a readable compiled artifact instead of opaque runtime calls, and — because the compiler already extracts a typed shadow program for Marko's own language server — completion and type errors inside expressions and attributes, and go-to-definition on components, for free. Pug, Jinja, Handlebars and EJS never had any of this, because none of them compile through a real TypeScript-aware pipeline.

The consequence for the author: `import tpl from "./email.mx"; res.send(tpl({ user }))` works unmodified in Express, Hono, Workers, an email pipeline, a static site generator, or a snapshot test. No render API, no stream plumbing, zero bundle cost beyond one small escape helper.

The reactive constructs — `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `<await>`, `:=` as a two-way binding — either render their initial value (where that has an unambiguous meaning, like `<let>`) or fail at compile time naming the construct, so the boundary between "this needs a runtime" and "this doesn't" is visible to the author rather than silently guessed at.

## This is the html target, not a proposal

Marko's own compiler exposes a `config.translator` seam: supply a `translate` visitor over Marko's node types plus a taglib, and the compiler drives the rest. A translator that implements only the string-emission rules above, and turns the reactive tags into compile errors, gets the expressions-only mode described above — without forking Marko's compiler at all. This is exactly what the html target is: a translator against the real Marko compiler, verified against Marko's own server render on real templates covering components, tag discovery, attribute tags, control flow, structured `class`/`style` values, spread, dynamic tags, and doctype documents. Every one of those templates produces byte-equivalent HTML through both the real Marko toolchain and this translator.

## The other half: reactive output without hydration

The mirror case is a client-only reactive runtime with hydration (resume) removed. A framework's `dom` output already turns `<let>` into a signal, `<const>` into a derived value, `<effect>` into an effect, and `<if>`/`<for>` into reactive branches; hydration is a separate, subtractable layer on top — marker comments in the server output, a scan-and-adopt step on the client, and serialized scope data connecting the two. Drop that layer and you get a template that mounts fresh into an empty element rather than adopting server-rendered DOM: a plain client-side render with no resume handshake.

The cost is real and specific: if the same markup is also rendered on the server, the client mount replaces the DOM instead of adopting it, causing a double render and a brief flash. That's an acceptable tradeoff for islands, widgets, admin panels, and browser extensions. It is not acceptable for a content page with above-the-fold interactivity. That boundary — whether you need adoption of server-rendered DOM — is what decides whether a template needs full hydration semantics or can live with a lighter reactive-only mode.

## Why MX draws this line at all

The reactive tags Marko removed from its own scriptlet-based past (see [Arbitrary code in templates](/design-notes/arbitrary-code-in-templates/)) exist because a modern compiler has to answer specific questions about every piece of code in a template: when does it re-run, what does it depend on, is it a side effect, does it belong to the server or the client, is its result serialized across a hydration boundary. A bare statement answers none of them. A named construct — `<let>` for state, `<const>` for a derived value, `<effect>` for a side effect with a lifecycle — answers all of them by construction.

MX inherits that discipline and pushes it one step further: it makes "no runtime" a legitimate, first-class target, not merely an implementation detail of how a template happens to compile. A host that has no reactive story at all — the html target, and the Astro host that renders exclusively at build time — can compile the exact same structural syntax and simply reject the reactive tags outright, because those tags were always host-defined semantics layered on top of a stable structural core, never assumed to be universal.

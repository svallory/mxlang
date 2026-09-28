---
title: "Define, const, static, import"
description: "Reusable fragments, non-reactive bindings, and module-level code."
---

# Define, const, static, import

These four constructs are part of the portable structural core — they work the same way on every host.

## `import`

Ordinary module imports, hoisted to the top of the compiled output:

```html
import { formatDate } from "./util.ts"

<p>Published ${formatDate(post.date)}</p>
```

A `.mx` file compiles to a template — a component, not a module exporting plain helpers like `formatDate` — so import shared helpers from a `.ts` module. Import a `.mx` file itself to call it as a tag, the way [`<define>`](#define) calls work.

## `static`

Code that runs once, at module load, rather than once per render:

```html
static
  const GREETING = "Welcome"

<h1>${GREETING}, ${user.name}</h1>
```

Use `static` for values or helpers that don't depend on the current render's input.

## `<const>`

A non-reactive local binding, computed fresh on each render:

```html
<const/total=items.reduce((sum, i) => sum + i.price, 0)/>

<p>Total: ${total}</p>
```

`<const>` never re-runs after its initial evaluation within a render — it isn't a signal, and it isn't watched for changes. Contrast this with `<let>`, which a reactive host can turn into real state; see [Stateful tags](/language/stateful-tags/).

## `<define>`

A named, reusable template fragment, callable like any other tag:

```html
<define/Badge|label, color|>
  <span style={background: color}>${label}</span>
</define>

<Badge label="New" color="green"/>
<Badge label="Sale" color="red"/>
```

`<define>` fragments take the same tag params and attribute tags as any other tag call.

## A name that shadows `input`

A `<const>` (or `<let>`) binding named `input` at the top level of a template is rejected: it would shadow the parameter every compiled render function already has. A *tag param* named `input` — `<for|input|>`, `<define/Row|input|>` — is fine, because it opens a genuinely nested scope. See [Errors](/language/errors/).

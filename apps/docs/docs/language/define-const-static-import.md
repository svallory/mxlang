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

A `.mx` file compiles to a template — a component, not a module exporting plain helpers like `formatDate` — so import shared helpers from a `.ts` module. Import a `.mx` file itself to call it as a tag, the way [`<define>`](#define-const-static-import-define) calls work.

## `static`

Code that runs once, at module load, rather than once per render:

```html
static
  const GREETING = "Welcome"

<h1>${GREETING}, ${user.name}</h1>
```

Use `static` for values or helpers that don't depend on the current render's input.

A block groups several statements. Its braces are not kept: what the block declares is declared at module level, so the template reads it.

```html
static {
  const GREETING = "Welcome"
  function shout(text) { return text.toUpperCase() }
}

<h1>${shout(GREETING)}</h1>
```

Only a block that is the whole `static` body unwraps, and only one level of it: a block nested inside stays a block, and its declarations stay inside it.

Because it runs once, before any render, `static` code (like `server`, `client` and `export` code) cannot name anything that exists only while the template renders: a tag variable (`<let>`, `<const>`, `<define>`), `input`, `$global` or `$signal`. It is a compile error, positioned at the name (`MX_RENDER_ONLY_IN_MODULE`):

```html
<const/rate=0.2/>
static const tax = rate * 100
```

> `rate` exists only while the template renders, so module level code (`static`, `server`, `client` and `export` statements), which runs once as the template loads, cannot reference it. Reference it in the template instead, passing it to module level functions as an argument.

Write `static function tax(rate) { return rate * 100 }` and call `${tax(rate)}` in the template. A function parameter that shadows the name is fine, and so is a tag param (`<for|item|>`), which module code cannot see.

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
<define/Badge|{ label, color }|>
  <span style={background: color}>${label}</span>
</define>

<Badge label="New" color="green"/>
<Badge label="Sale" color="red"/>
```

`<define>` fragments take the same tag params and attribute tags as any other tag call. A call with attributes passes one attribute object to the first parameter (decision 160), so destructure it as `|{ label, color }|`; a second parameter never receives an attribute.

## A name that shadows `input`

A `<const>` (or `<let>`) binding named `input` at the top level of a template is rejected: it would shadow the parameter every compiled render function already has. A *tag param* named `input` — `<for|input|>`, `<define/Row|input|>` — is fine, because it opens a genuinely nested scope. See [Errors](/language/errors/).

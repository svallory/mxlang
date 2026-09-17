---
title: "Template tags"
description: "Author L1 custom tags as ordinary MX templates under tags/."
---

# Template tags

An L1 custom tag is an ordinary `.mx` file in a discovered tag directory. `tags/icon.mx` defines `<icon>`; no sidecar or import is required.

A tag's template is a **compilation unit**. It compiles through the same per-file pipeline a page uses, into a module that exports the tag, and a caller emits an import plus a call. The template is never copied into the caller.

Every example below is copied from a passing core fixture or template test.

## Attributes are `input`

Read a call's attributes as `input.<name>`:

```marko
<div>${input.title}${input.count}</div>
```

The passing call-site case is:

```marko
<box title="hello" count=2/>
```

`input` is the tag module's own parameter, so an omitted attribute is `undefined` and ordinary fallbacks work:

```marko
<div>${input.size ?? 24}</div>
```

Because `input` is a real parameter rather than a name resolved at compile time, a template may read an attribute as many times as it likes, use `input` as a value, destructure it, or accept a spread at the call site. The caller's expression is evaluated once, at the call.

## Body content

Place the caller's body with a dynamic tag over `input.content`:

```marko
<section><${input.content}/></section>
```

For this call:

```marko
<box><em>body</em></box>
```

the `<em>` block renders inside the `<section>`. `content` is a closure built **at the call site**, so a body written inside a `<for>` captures that row rather than the last one. How often it renders is the tag's choice: never, if the template omits the placeholder; N times if the template writes it N times.

If a caller supplies body content and the template never reads `input.content`, MX warns that the body was dropped, naming the template. A tag that should refuse a body declares `parseOptions.openTagOnly` in a [sidecar](/custom-tags/sidecars/); a call passing one is then an error at the call site: ``​`<x>` does not accept content``.

## Attribute tags

Place `<@name>` content through `input.<name>`:

```marko
<ul><${input.item}/></ul>
```

Repeated attribute tags remain repeated and preserve their order:

```marko
<list><@item>one</@item><@item>two</@item></list>
```

An attribute tag the template never reads produces a warning naming it. `<@content>` is rejected, because it would collide with the body slot. Attribute-tag declarations and repeat/required checks belong in an optional [sidecar](/custom-tags/sidecars/).

## Params

Tag params remain scoped to the caller's body block:

```marko
<box|row|>${row}</box>
```

When the template places `<${input.content}/>`, that block still owns `row`; the tag's own module cannot see it.

## Typing

A template's `export interface Input` is the tag's **public type**. It reaches the call site through the injected import, so passing a wrong attribute type is a `tsc` error at the caller's own line and column:

```marko
export interface Input { name: string; size?: number }
```

Where a template reads `input.content`, the host augments its render signature so a caller passing a body typechecks; where it does not, `Input` is untouched.

## Module scope

A template's `import` and `static` statements stay in the tag's own module. They are the module system's, not the caller's, which means a `static` block runs **once per process**, at import time — not once per calling module.

```marko
import helper from "./helper.ts"
<div>${helper()}</div>
```

A tag file is a module, so it may export anything, and it may call other custom tags — including itself. A module importing itself is legal, so a self-recursive tag terminates on its own data rather than on a compiler limit.

## Hygiene

Hygiene is the module boundary. A template's declarations are private because they live in a different module: nothing it declares can reach the caller's scope, and a caller binding of the same spelling is unrelated. There is no renaming pass and no caller-side import merging.

The import MX injects for a discovered tag is generated (`$mx_Icon1`) and minted against the caller's own bindings, so it cannot collide with anything the author wrote. If the caller already imports the same file itself, that binding is reused and no second import appears.

On Solid the import lands one level out. A `.solid.mx` file is a TypeScript module containing MX regions, and a region is an *expression*, so it has no module scope to hold an import: MX writes the injected import into the surrounding TypeScript module instead — once per module per tag, reusing an import the module already wrote for the same file. Calling a discovered tag from a region needs nothing from the author either way. Writing an `import` or `static` yourself *inside* a region remains an error, because there the surrounding module is where it belongs.

## What a template cannot do

A template can arrange markup and use MX's structural language, but it cannot examine compile-time AST shapes, compute a new IR structure in TypeScript, or refuse a call with a custom diagnostic. Add an [L2 sidecar](/custom-tags/sidecars/) for those jobs.

## Errors to recognize

- **Reserved `content`.** A call cannot pass an attribute named `content`; that name is the body slot.
- **`<@content>`.** Reserved for the same reason.
- **Content on an `openTagOnly` tag.** The tag declared that it takes no body.

A diagnostic inside a template points at the template file and its real line, because that file is itself being compiled. Errors in call attributes stay on the calling file.

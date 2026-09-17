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

## Returning a value

A template can hand a value back to its caller with `<return>`, and the caller binds it with `/var`:

```marko
export interface Input { start: number }
<span class="count">${input.start}</span>
<return value=input.start + 1/>
```

```marko
<counter/next start=41/>
<p>${next}</p>
```

The binding's type is the `<return>` expression's inferred type — `next` is a `number` above — so reading it the wrong way is a `tsc` error at the caller's own line.

`<return>` is **value only**: MX has no `valueChange` and no two-way channel.

### The grammar

A template may declare **at most one** `<return>`, and it must sit at the **top level** of the template. It cannot be nested inside a native tag, an `<if>`/`<else>`, a `<for>`, an attribute tag or a `<define>` — a returning tag returns unconditionally, which is what makes its signature one shape rather than "a value on some paths".

`<return>` takes a required `value=` and nothing else: no arguments, no params, no body, no spread, no `/var` of its own, and no other attribute. Each violation is a positioned compile error.

A `<return>` in a page is legal and means the same thing — a page is a module that returns a value nobody reads yet.

### Rules for `/var`

- **The tag must declare `<return>`.** `/var` on a tag whose template returns nothing is an error, rather than a binding that silently reads `undefined`.
- **The binding is scoped to the block the call is in**, like any `let`. Reading it from outside that block is an error rather than a binding hoisted somewhere the reader cannot see.
- **The call has to come first.** Reading a `/var` earlier in the same block than the call that binds it is an error, not a run-time crash.

### Where `/var` can be written, per host

On **html** and **Astro `.mx`** components, a `/var` works anywhere a call does — including inside `<if>` and `<for>`, where the binding lands in that block and the call runs per iteration.

On the **JSX hosts** (Preact, React, Hono) and **Solid**, a `/var` must be at the **top level of the template**. Those targets lower `<if>` and `<for>` to expressions — a ternary, a `.map` callback, a `<For>` render prop — and an expression has no statement position to hold the binding. Writing one there is a positioned compile error rather than a silent miscompile:

```
`/var` on `<counter>` inside `<for>`/`<if>` is not supported on Preact yet;
bind it at the top level of the template
```

Calling the tag *without* `/var` works everywhere; only the binding is restricted. Lifting the restriction is planned for MX 2.

`/var` is not supported in a `.amx` (AstroMX) file at all — an Astro template has no statement position of its own. Calling a returning tag from `.amx` works, and renders its output.

### A returning unit on a JSX host cannot use hooks

On the JSX hosts, a returning unit is **invoked as a plain function** rather than mounted as a component — that is what lets it hand a value back, since a JSX element is only a description of a call the runtime makes later.

The cost is that it has no component identity: Preact's and React's hook dispatchers bind to the *calling* component's hook list, so a `useState` inside a returning unit would silently become a hook of the caller. Importing a hook into a unit that declares `<return>` is therefore a compile error. Drop the `<return>`, or move the hook to the caller.

Solid is unaffected — its callback prop keeps the unit a real component.

### On Solid, the value is one-shot

Every host delivers the value the same way to an author, but Solid's mechanism differs: a Solid component's return value is its view, so the value comes back on a generated callback prop the tag calls during setup, and the caller reads an ordinary `let`.

That binding is **not reactive**. It holds the value from the single call that produced it and does not update afterwards, which matches `/var`'s meaning on every other host. If you want a value that tracks, return an accessor and call it:

```marko
<return value=() => count()/>
```

## Module scope

A template's `import` and `static` statements stay in the tag's own module. They are the module system's, not the caller's, which means a `static` block runs **once per process**, at import time — not once per calling module.

```marko
import helper from "./helper.ts"
<div>${helper()}</div>
```

A tag file is a module, so it may export anything, and it may call other custom tags — including itself. A compiled tag's default export is a **named** declaration (`icon.mx` exports `Icon`, `table-of.mx` exports `TableOf`), so a tag calling its own name resolves to that declaration in its own module scope: recursion needs no import, and terminates on the tag's own data rather than on a compiler limit.

```mx
<!-- tags/tree.mx -->
<li>
  ${input.node.label}
  <if=input.node.kids>
    <ul><for|kid| of=input.node.kids><tree node=kid/></for></ul>
  </if>
</li>
```

The name is derived from the filename, not written by the author, and is re-minted if it would collide with something the file already binds.

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
- **`<x>` does not return a value.** A `/var` on a tag whose template declares no `<return>`.
- **A `/var` read out of scope**, or read before the call that binds it.
- **`/var` inside `<for>`/`<if>` on a JSX host or Solid**, where those constructs are expressions with no statement position; bind it at the top level.
- **A hook in a returning unit** on a JSX host, where the unit is called as a plain function.
- **`<return>` must be at the top level**, and there may be only one per template.

A diagnostic inside a template points at the template file and its real line, because that file is itself being compiled. Errors in call attributes stay on the calling file.

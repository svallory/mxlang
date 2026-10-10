---
title: "Errors"
description: "The compile-time errors you're likely to see and why they exist."
---

# Errors

MX prefers a compile error over silently dropping or misinterpreting a construct. This page catalogs the errors you're most likely to run into and why each one exists.

## A stateful tag under `strict`

If the project (or a `<let>`/`<effect>`/etc. author) opted into the `strict` policy, using `<let>`, `<effect>`, `<lifecycle>`, `<script>`, a `client` block, or `<id>` on a host with no reactive target is a compile error naming the construct. The `input`-shadowing check below is not one of these six — it applies regardless of `strict`. See [Stateful tags](/language/stateful-tags/).

## `<await>` on the html target

The html target compiles to a plain `(input) => string` function with no notion of a pending value, so `<await>` is always an error there — this isn't a `strict`-only restriction, since there's no way to render a promise to a string synchronously.

## `<try>` with `<@placeholder>` on the html target

A `<try>` with only `<@catch>` compiles to an ordinary `try`/`catch`. Adding `<@placeholder>` needs a second render pass (show a placeholder, then swap in the real content once it resolves) that the html target's single-pass string output can't do.

## A binding named `input`

```html
<const/input=42/>
```

is rejected — it would shadow the parameter every compiled template function already has (`function (input) { ... }`), silently making the real input unreachable. This applies to `<let>`/`<const>` at the top level of a template.

A **tag param** named `input` is fine:

```html
<for|input| of=items>
  <p>${input.name}</p>
</for>
```

because a tag param opens a genuinely nested scope, the same way an ordinary JavaScript function parameter can legally shadow an outer variable.

## An attribute tag colliding with a prop

```html
<Card children="x">
  <@children>y</@children>
</Card>
```

is rejected: `<@children>` would silently overwrite the `children` prop (or an explicit attribute of the same name), and MX treats that as an error rather than "last writer wins." See [Attribute tags and tag params](/language/attribute-tags-and-params/) for the full table.

## Attribute-tag errors

These are the diagnostics introduced by the `AttrTag` contract. Names such as
`head`, `row`, and `Card` are substituted from the source; the wording shown is
the compiler's wording, not a summary.

### Declaration and call shape

| Message | Cause |
| --- | --- |
| `` `<@head>` may appear at most once (`head` is declared `AttrTag`, not `AttrTag[]`) `` | A singular property occurs more than once on a possible path. |
| `` `<@head>` may not appear inside `<for>` (`head` is declared `AttrTag`, not `AttrTag[]`) `` | A loop could produce more than one value for a singular property. |
| `` missing required attribute tag `<@head>` `` | `head: AttrTag` has no occurrence. |
| `` `<@head>` is required but not provided on every `<if>` path `` | A required singular is missing from at least one mutually exclusive branch, including the implicit empty branch when there is no final `<else>`. |
| `` `<Card>` declares no attribute tag `row` `` | A closed exported `Input` has no `row` property. |
| `` `row` is declared as a plain prop; declare it `AttrTag` to pass it as `<@row>` `` | `Input.row` exists but is not an `AttrTag`. |
| `` `<@row>` declares params in `<Card>`; add `|…|` `` | The config has a `params` tuple but the occurrence omits tag params. |
| `` `<@row>` declares no params in `<Card>`; remove `|…|` `` | The occurrence has tag params but the config does not. |
| `` `content` is reserved on an attribute tag; it names the body `` | Authored `content=` would collide with the compiler-created body property. |
| `Cannot have attribute tags and body content under a control flow tag.` | The same `<if>` or `<for>` body contains both named blocks and ordinary content. |
| `` `<@name>` is renderable in `<Owner>`; it can't take attributes `` | An `as: "renderable"` occurrence authors attributes. |
| `` `<@name>` is renderable in `<Owner>`; it can't take attributes or nested attribute tags `` | An `as: "renderable"` occurrence contains nested tags. |

### Reading and rendering the value

| Message | Cause |
| --- | --- |
| `` `input.head` is a data attribute tag; render its body with `<${input.head.content}/>` `` | A data object was used as a dynamic renderable. |
| `` `input.row.content` is a parameterized attribute tag; pass its arguments with `<${input.row.content(/* arguments */)}/>` `` | Parameterized data content was rendered without a call. |
| `` `input.row` is a parameterized attribute tag; pass its arguments with `<${input.row(/* arguments */)}/>` `` | A parameterized renderable was rendered without a call. |
| `MX: this value is a data attribute tag ({ ...attrs, content }); render its body with <${x.content}/>` | A data object reaches a dynamic renderer at runtime when its declaration was unavailable statically. |

### Reading the callee's `Input`

| Message | Cause |
| --- | --- |
| `declare this attribute tag's config literally` | The config needs type evaluation (for example a conditional, mapped, intersection, or non-literal `as`) instead of syntax MX can follow. It appears after the callee/property location prefix. |
| `attribute tag params must be a tuple type` | `params` is an open array such as `string[]`, not a tuple. |
| `renderable attribute tags can't take attributes; declare as: "data"` | One declaration combines `as: "renderable"` with `attrs`. |
| `` can't read `<Card>`'s Input (FILE:LINE:COLUMN): MESSAGE `` | The imported callee's `Input` cannot be parsed. |
| `` can't read `<Card>`'s declaration of `head` (FILE:LINE); MESSAGE `` | The used attribute-tag declaration is syntactically present but invalid. |

An unresolved import is a warning because the call can still use the syntactic
fallback: `` couldn't read `<Card>`'s Input (`@app/Card` not resolvable);
attribute-tag shape inferred from this call ``. Supply the tool's synchronous
`resolveImport` hook for aliases.

### Astro and Angular projection limits

The projection hosts reject shapes they cannot carry instead of dropping data.

| Message | Cause |
| --- | --- |
| `` array attribute tag `<@item>` isn't supported by @mxlang/host-astro: a slot is keyed by name `` | An Astro repeat, array declaration, or loop needs several values under one slot name. |
| `` attributes on `<@header>` aren't supported by @mxlang/host-astro: a slot carries markup, not data `` | An Astro slot has no attribute-data channel. |
| `` params on `<@header>` aren't supported by @mxlang/host-astro: a slot carries rendered markup, not a function `` | An Astro slot cannot call back into projected markup. |
| `` nested attribute tags inside `<@header>` aren't supported by @mxlang/host-astro: a slot is keyed by one name and has no nested data shape `` | An Astro slot cannot carry nested properties. |
| ``<@header/> has no body; @mxlang/host-astro projects attribute-tag bodies by name`` | An Astro slot has nothing to project. |
| `` array attribute tag `<@item>` isn't supported by @mxlang/host-angular: a projection is keyed by name `` | An Angular repeat, array declaration, or loop needs several values under one projection selector. |
| `` attributes on `<@header>` aren't supported by @mxlang/host-angular: a projection carries nodes, not data `` | Angular projection has no attribute-data channel. |
| `` params on `<@header>` aren't supported by @mxlang/host-angular: content projection cannot pass values back into projected nodes `` | `<ng-content>` cannot call back into projected nodes. |
| `` nested attribute tags inside `<@header>` aren't supported by @mxlang/host-angular: a projection has no nested data shape `` | Angular projection cannot carry nested properties. |
| ``<@header/> has no body; @mxlang/host-angular projects attribute-tag bodies by name`` | An Angular projection has nothing to place. |

Angular additionally reports
`` @mxlang/host-angular can't read projected content `header` as a value; render it
with <${input.header.content}/> `` for conditions, property reads, and
pass-throughs. Calling projected content with arguments reports
`` `input.header(…)` passes arguments to content, which Angular's content
projection cannot express: `<ng-content>` places the caller's nodes and cannot
pass them values. Declare the block as a `<define>` and pass it as an input the
component renders with `ngTemplateOutlet`. ``

The complete value shapes and legal render idioms are in the
[AttrTag guide](/language/attr-tag/).

## Atom errors

`:name` in an expression position is an [atom](/language/atoms/). Most atom
errors are the contract checks (a name that is not allowed, an atom where a
string was declared) and the operations an atom refuses; each is positioned at
the atom. The wording below is the compiler's.

### A name a contract does not allow

With `mode: { type: "atom", values: ["strict", "loose"] }`, a name outside the
set is an error on the atom, listing the candidates and adding a did-you-mean
when one is clearly nearest:

| Message | Cause |
| --- | --- |
| `` `<box>`: attribute `mode`: `:strct` is not one of :strict, :loose; did you mean `:strict`? `` | a name outside `values`, near one of them |
| `` `<box>`: attribute `mode`: `:zzzzzz` is not one of :strict, :loose `` | a name outside `values`, near none of them |
| `` `<box>`: attribute `slug`: `:ab-c` does not match the pattern /^[a-z]+$/ `` | a name that fails `pattern` (checked with or without `values`; with both, a name must pass both) |
| `` `<policy>`: attribute `load`: `:titel` is not a declared relationship or computed here (one of :author, :title); did you mean `:title`? `` | an atom where the contract says `ref`, and no declaration of that kind covers the name. A union ref names every kind it accepts; the list holds the visible names the attribute accepts (sorted, ten, then `+N more`, or `none declared`) |

Every atom of a list is checked at its own position, so
`mode=[:strict, :lose]` points at `:lose`, not at the attribute. Without a
contract an atom is never an error: it is only its name.

### An atom where a string is declared, and the other way round

The distinction is checked both ways, at the value (an attribute-tag attribute
at any depth is prefixed `` `<box>`: `<@row>`: ``):

| Message | Cause |
| --- | --- |
| `` attribute `label` must be string, got atom `` | `label` is declared `string` and written `label=:title` |
| `` attribute `kind` must be atom, got string `` | `kind` is declared `atom` and written `kind="title"`; in a list, the string item itself is the position. Against `values` the message ends with ``(one of :a, :b)``; against `ref` with the declared names and the fix: ``(one of :id, :title); write it as `:title` `` |

**The name sugar is the exception** (decision 156 addendum 6): `name` set by the
sugar satisfies a `string` or `enum` contract as its string and an `atom`
contract as the atom, so `<field :email/>` is fine either way. An explicit
`x=:a` against `string` stays an error, and `name="title"` against an
atom-typed `name` stays an error.

### Operations an atom refuses

An atom is a name, not a value to work on. Member access (`:a.length`, `:a[0]`),
a call (`:a(1)`), a unary operator (`-:a`, `!:a`, `typeof :a`), spreading
(`f(...:a)`, `[...:a]`, `<div ...:a/>`) and a non-computed object key
(`{:a: 1}`) are all errors at the atom:

```text
<div x=:a.length/>
1:7 `:a` is an atom (decision 156), a name and not a value to operate on: member access is not allowed on it; write `"a"` for a string you mean to operate on
```

```text
<div x={:a: 1}/>
1:8 `:a` cannot be an object key: an atom is a value (decision 156); write `a:` for the key, or `[:a]` to compute it from the atom
```

Where a binding, an assignment target or a shorthand property must stand
(`:a = 1`, `(:a) => 1`, `{:a}`), the parse error names the atom instead:

```text
<div x=(:a) => 1/>
1:8 `:a` is an atom (decision 156): a value, not a binding, an assignment target or a shorthand property
```

### `::name` is reserved

```text
<div x=::a/>
1:7 `::a` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:a` for an atom
```

`::` is one token, so it is reported the same way in a tag or attribute name and
in a shorthand's static text (`<b::a/>`, `<b ::a/>`, `<b.c::a/>`), positioned at
the `::`. It is never reported inside a `${}` of a tag name or shorthand, which
is an expression: `<${"a::b"}/>` is legal.

### The `:` TypeScript owns

Four spellings where TypeScript's `:` and an atom's `:` collide are known limits
(see [Atoms](/language/atoms/#atoms-known-limits-a-typescript-owns)), each with a
hint that names the ambiguity and the fix:

```text
hint: `a<b> :c` reads `a<b>` as type arguments (TypeScript's reading), so `:c` is not an atom there; this spelling is ambiguous (ADR 156, known limits)
```

```text
hint: `:z` was read as an atom (decision 156), so the ternary has no `:`; if TypeScript owns that `:` (type arguments before it, ADR 156 known limits), write `: z` with a space
```

## `class:foo` and `style:foo`

```html
<div class:active=isActive></div>
```

isn't MX-specific syntax to avoid — it isn't Marko syntax at all. Marko's own parser rejects it before any host ever sees the template, with a fix-it suggesting the object form instead:

```html
<div class={active: isActive}></div>
```

There's no MX behavior to document here because no `.mx` file using the colon-modifier form compiles in the first place.

## An ambiguous `>` in an attribute value

A `>` preceded by whitespace ends the tag, so a comparison written bare in an attribute value splits the tag in a way you did not intend:

```html
<if=count > 9><p>double digits</p></if>
```

fails with *Ambiguous ">" in attribute*. Wrap the expression in parentheses:

```html
<if=(count > 9)><p>double digits</p></if>
```

The same applies to any attribute value, not only `<if>`. `<`, and a `>` with no space before it, are unambiguous and need no parentheses.

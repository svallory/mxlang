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
| `` array attribute tag `<@item>` isn't supported by @mxlang/astro: a slot is keyed by name `` | An Astro repeat, array declaration, or loop needs several values under one slot name. |
| `` attributes on `<@header>` aren't supported by @mxlang/astro: a slot carries markup, not data `` | An Astro slot has no attribute-data channel. |
| `` params on `<@header>` aren't supported by @mxlang/astro: a slot carries rendered markup, not a function `` | An Astro slot cannot call back into projected markup. |
| `` nested attribute tags inside `<@header>` aren't supported by @mxlang/astro: a slot is keyed by one name and has no nested data shape `` | An Astro slot cannot carry nested properties. |
| ``<@header/> has no body; @mxlang/astro projects attribute-tag bodies by name`` | An Astro slot has nothing to project. |
| `` array attribute tag `<@item>` isn't supported by @mxlang/angular: a projection is keyed by name `` | An Angular repeat, array declaration, or loop needs several values under one projection selector. |
| `` attributes on `<@header>` aren't supported by @mxlang/angular: a projection carries nodes, not data `` | Angular projection has no attribute-data channel. |
| `` params on `<@header>` aren't supported by @mxlang/angular: content projection cannot pass values back into projected nodes `` | `<ng-content>` cannot call back into projected nodes. |
| `` nested attribute tags inside `<@header>` aren't supported by @mxlang/angular: a projection has no nested data shape `` | Angular projection cannot carry nested properties. |
| ``<@header/> has no body; @mxlang/angular projects attribute-tag bodies by name`` | An Angular projection has nothing to place. |

Angular additionally reports
`` @mxlang/angular can't read projected content `header` as a value; render it
with <${input.header.content}/> `` for conditions, property reads, and
pass-throughs. Calling projected content with arguments reports
`` `input.header(…)` passes arguments to content, which Angular's content
projection cannot express: `<ng-content>` places the caller's nodes and cannot
pass them values. Declare the block as a `<define>` and pass it as an input the
component renders with `ngTemplateOutlet`. ``

The complete value shapes and legal render idioms are in the
[AttrTag guide](/language/attr-tag/).

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

---
title: "Errors"
description: "The compile-time errors you're likely to see and why they exist."
---

# Errors

MX prefers a compile error over silently dropping or misinterpreting a construct. This page catalogs the errors you're most likely to run into and why each one exists.

## A stateful tag under `strict`

If the project (or a `<let>`/`<effect>`/etc. author) opted into the `strict` policy, using `<let>`, `<effect>`, `<lifecycle>`, `<script>`, a `client` block, or `<id>` on a host with no reactive target is a compile error naming the construct. See [Stateful tags](/language/stateful-tags/).

## `<await>` on the HTML host

The HTML host compiles to a plain `(input) => string` function with no notion of a pending value, so `<await>` is always an error there — this isn't a `strict`-only restriction, since there's no way to render a promise to a string synchronously.

## `<try>` with `<@placeholder>` on the HTML host

A `<try>` with only `<@catch>` compiles to an ordinary `try`/`catch`. Adding `<@placeholder>` needs a second render pass (show a placeholder, then swap in the real content once it resolves) that the HTML host's single-pass string output can't do.

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

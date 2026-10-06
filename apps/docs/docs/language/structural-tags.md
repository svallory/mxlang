---
title: "Structural tags"
description: "The if/else and for forms that work identically on every host."
---

# Structural tags

MX's structural core is a small set of tags that render exactly the way Marko renders them, on every host. A host may forbid one of these tags outright, but it may never change what one means.

`<try>` is implemented as a [core-owned custom tag](/custom-tags/sidecars/#sidecars-request-a-host-primitive): the core validates one portable call shape, then requests the active host's `try` primitive. Projects cannot shadow its name.

## `<if>` / `<else if>` / `<else>`

```html
<if=user.loggedIn>
  <p>Welcome back, ${user.name}.</p>
</if>
<else if=user.isGuest>
  <p>Browsing as a guest.</p>
</else>
<else>
  <p>Please sign in.</p>
</else>
```

The html target lowers this to a plain JS `if`/`else if`/`else` chain around the corresponding output. Solid lowers the same tag to Solid's `<Show>` for two or fewer conditioned branches, or `<Switch>`/`<Match>` for three or more, matching what a hand-written Solid component would use for a branch.

## `<for>`

`<for>` covers four distinct iteration shapes, chosen by which attribute you write.

### `of=` — iterate a list

```html
<for|item, i| of=items>
  <li>${i}: ${item.name}</li>
</for>
```

Add `by=` to key each row for reconciliation:

```html
<for|item| of=items by="id">
  <li>${item.name}</li>
</for>
```

On the html target this is a plain `for`/`.map` loop. On Solid, `of=` lowers to Solid's `<For each={...} keyed={...}>`, and `by="id"` becomes the `keyed` key function.

`by=` is evaluated once, outside the loop body, so the loop param is not in scope there. Key with a property-name string (`by="id"`) or a function (`by=(item) => item.id`); `by=item.id` is a compile error pointing at `item`, as in Marko.

### `in=` — iterate an object's entries

```html
<for|key, value| in=config>
  <dt>${key}</dt><dd>${value}</dd>
</for>
```

Lowers over `Object.entries(...)`.

### `from=` / `to=` / `until=` / `step=` — iterate a numeric range

```html
<for|i| from=0 to=9>
  <span>${i}</span>
</for>
```

`to=` is inclusive, `until=` is exclusive; add `step=` for a stride other than 1. On Solid this lowers to Solid's `<Repeat>` rather than `<For>`, since there is no list to key against — only a count. When `from`/`to`/`step` are all literals the row count is folded at compile time; when any is dynamic, the count is computed at render time and clamped to zero rather than ever producing an infinite range (a `step=0` you write directly is a parse error; a `step` that evaluates to `0` at runtime clamps to zero rows).

## What's next

Tag params and attribute tags apply to `<for>`'s own `|item, i|` binding too — see [Attribute tags and tag params](/language/attribute-tags-and-params/).

To define project-specific tags that expand before a host sees them, continue with [Custom tags](/custom-tags/).

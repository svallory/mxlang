---
title: "Hono: what MX compiles to"
description: "Each MX construct and the hono/jsx TSX it becomes; event names, keys, class values and error boundaries on the Hono host."
---

# Hono: what MX compiles to

`hono/jsx` has no control-flow components, so every structural tag becomes a plain JSX expression: what you would have written by hand.

| Written | Emitted |
|---|---|
| `text`, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML={{ __html: expr }}` |
| `class="a"`, `.a` | `class="a"` |
| `class={ a: cond }`, `class=[…]` | `class={mxClass({ a: cond })}` |
| `<label for=…>` | `for={…}`, unchanged |
| `style={ color: c }` | `style={{ color: c }}` |
| `onClick() { … }` | `onClick={() => { … }}` |
| `<if>` / `<else if>` / `<else>` | a conditional expression, `null` for a missing else |
| `<for\|x\| of=xs>` | `[...xs].map((x) => …)` with a `key` |
| `<for\|v, k\| in=obj>` | an `Object.entries` map, keyed by the property name |
| `<for\|i\| from=a to=b>` | a generated range map |
| `<Comp x=1>children</Comp>` | the component called with `x` and `children` |
| `<@name>` | the prop `name`; repeated tags become an array |
| `<@name\|p\|>` | the prop `name` as a function of `p` |
| `<define/Row\|p\|>` | a local function, called as `Row(p)` |
| `<try>` | `ErrorBoundary` and `Suspense`, both from `hono/jsx` |

## Element or component?

MX follows Marko's rule, not JSX's capital letter: a tag is a component when a binding in scope or a [discovered custom tag](/custom-tags/discovery/) has that name, whatever its case. A `tags/badge.mx` makes `<badge/>` a component call. The other side of the rule: an import named like an element (`import { label } from "./i18n"`) turns `<label>` into a call of it. Rename the import.

## Keys

Every `<for>` row carries a `key`: `by="id"` keys by a field of the row, `by=fn` by a function of it, and with no `by` the key is the row itself. A server render does not need them; they matter when the same component runs under `hono/jsx/dom` in the browser, where a list of objects or a list with duplicates needs a `by`.

## Events

For components that run in the browser with `hono/jsx/dom`. MX reads the DOM event name (the text after `on`, lowercased) and emits `on` plus that name capitalized: `onClick=f` is `onClick={f}`, and `onDblClick=f` and `on-dblclick=f` are both `onDblclick={f}`, which Hono binds to `dblclick`.

- **Spell the DOM name.** `onDoubleClick` is not a DOM event, so MX warns and emits it as written. Write `onDblClick`.
- **`onChange` fires on every keystroke.** Hono binds it to the `input` event, as React does. Use `onInput` to say so plainly.
- **Custom DOM events** (`on-my-event=f`) are a compile error on React, Preact and Hono alike. Use a `ref` callback that calls `addEventListener`.
- **On a component**, `onSelect=pick` is an ordinary prop.

The shared rules are in [Attributes](/language/attributes/#attributes-event-attributes).

## `<try>`: error and loading states

```mx
<try>
  <Profile id=userId/>
  <@placeholder><p>Loading…</p></@placeholder>
  <@catch|err|><p.error>${err.message}</p></@catch>
</try>
```

Hono has both pieces, so MX wraps nothing: `<@catch>` becomes `hono/jsx`'s `ErrorBoundary` with `fallbackRender`, and `<@placeholder>` becomes its `Suspense`. With both present, the placeholder sits inside the boundary. `ErrorBoundary` resolves asynchronously once a child throws, so `await` the render (`await App(props).toString()`) when a tree can throw.

## Attribute tags on your own components

Export an `Input` type from the component and mark the markup props with `AttrTag` from `@mxlang/hono`. A renderable is a Hono `Child`; with `params` it is a function returning one; `AttrTag[]` is a real array. With no declaration, MX infers the shape from the call. See [AttrTag](/language/attr-tag/).

## How this is checked

`bun run oracle:hono` renders the shared fixture set through `hono/jsx` and compares it with Marko's own output on every CI run. `examples/hono-app` serves a live Hono server, and its tests assert the response carries no `<script>`.

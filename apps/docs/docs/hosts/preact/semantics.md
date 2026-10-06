---
title: "Preact: what MX compiles to"
description: "Each MX construct and the Preact TSX it becomes; event names, keys, class values and error boundaries on the Preact host."
---

# Preact: what MX compiles to

Preact has no control-flow components, so every structural tag becomes a plain JSX expression: what you would have written by hand.

| Written | Emitted |
|---|---|
| `text`, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML={{ __html: expr }}` |
| `class="a"`, `.a` | `class="a"` |
| `class={ a: cond }`, `class=[…]` | `class={mxClass({ a: cond })}` |
| `style={ color: c }` | `style={{ color: c }}` |
| `onClick() { … }` | `onClick={() => { … }}` |
| `...rest` | `{...rest}` |
| `<if>` / `<else if>` / `<else>` | a conditional expression, `null` for a missing else |
| `<for\|x\| of=xs>` | `[...xs].map((x) => …)` with a `key` |
| `<for\|v, k\| in=obj>` | an `Object.entries` map, keyed by the property name |
| `<for\|i\| from=a to=b>` | a generated range map |
| `<Comp x=1>children</Comp>` | the component called with `x` and `children` |
| `<@name>` | the prop `name`; repeated tags become an array |
| `<@name\|p\|>` | the prop `name` as a function of `p` |
| `<define/Row\|p\|>` | a local function, called as `Row(p)` |
| `<${expr}>` | a dynamic tag: a component or an element name chosen at run time |
| `<try>` | `MxErrorBoundary`, with `MxPlaceholder` for `<@placeholder>` |

## Element or component?

MX follows Marko's rule, not JSX's capital letter: a tag is a component when a binding in scope or a [discovered custom tag](/custom-tags/discovery/) has that name, whatever its case. A `tags/badge.mx` makes `<badge/>` a component call. The other side of the rule: an import named like an element (`import { label } from "./i18n"`) turns `<label>` into a call of it. Rename the import.

## Keys

Every `<for>` row carries a `key`.

- `by="id"` keys by a field of the row. Use it for objects.
- `by=fn` keys by a function of the row and its index.
- With no `by`, the key is the row itself: the item for `of`, the property name for `in`, the number for a range.

The default is right for unique strings and numbers. It is wrong for a list with duplicates (Preact may reuse the wrong node) and for objects (a rebuilt array remounts every row). Give those a `by`.

## Events

`onClick=fn` and `onClick() { … }` bind a handler on an element. MX reads the DOM event name (the text after `on`, lowercased) and emits `on` plus that name capitalized: `onClick=f` is `onClick={f}`, and `onDblClick=f` and `on-dblclick=f` are both `onDblclick={f}`, which Preact binds to `dblclick`.

- **Spell the DOM name.** `onDoubleClick` is not a DOM event (`doubleclick`), so MX warns and emits `onDoubleclick`, which binds nothing useful. Write `onDblClick`.
- **Custom DOM events** (`on-my-event=f`) are a compile error on React, Preact and Hono alike, so one source never works on one and fails on another. Use a `ref` callback that calls `addEventListener`.
- **On a component**, `onSelect=pick` is an ordinary prop.
- `on:click` is not MX syntax; the error names `onClick`.

The handler receives the DOM event. The shared rules are in [Attributes](/language/attributes/#attributes-event-attributes).

## `<try>`: error and loading states

```mx
<try>
  <Profile id=userId/>
  <@placeholder><p>Loading…</p></@placeholder>
  <@catch|err|><p.error>${err.message}</p></@catch>
</try>
```

Preact has no error boundary component, so the host ships one: `<@catch>` becomes `MxErrorBoundary`, a class component using `componentDidCatch`, and `<@placeholder>` becomes `MxPlaceholder`, which is `preact/compat`'s `Suspense`. Both come from `@mxlang/preact/runtime` and are imported only when used. With both present, the placeholder sits inside the boundary, so a render error reaches the catch.

## What is an error

Anything Preact cannot express fails the build with the construct and its line; nothing degrades silently.

- Marko's stateful tags, each naming the hook: `<let>` (`useState`), `<effect>` (`useEffect`), `<id>` (`useId`), `<lifecycle>`, `<script>`, and `:=`.
- `<await>`, a `client` block, and `<!doctype html>` (it belongs to the HTML page that mounts the app).
- A raw `$!{…}` with siblings: the prop replaces the whole subtree, so it must be the only child.
- A dynamic `style` that is not an object literal (`style=s`). A static string is fine.

## Children and `content`

MX calls a component with `children`, the JSX way, so hand-written Preact components work unchanged. A whole-file `.mx` component that reads Marko's `input.content` receives the same value.

## Attribute tags on your own components

Export an `Input` type from the component and mark the markup props with `AttrTag` from `@mxlang/preact`. A renderable is `ComponentChildren`; with `params` it is a function returning one; `AttrTag[]` is a real array. With no declaration, MX infers the shape from the call. [AttrTag](/language/attr-tag/) has a hand-written Preact component and a worked example.

## How this is checked

`bun run oracle:preact` renders the shared fixture set with `preact-render-to-string` and compares it with Marko's own output on every CI run. `examples/preact-app` is driven in a real browser.

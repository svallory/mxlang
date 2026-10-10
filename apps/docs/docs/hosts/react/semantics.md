---
title: "React: what MX compiles to"
description: "Each MX construct and the React TSX it becomes; event names, keys, class values and error boundaries on the React host."
---

# React: what MX compiles to

React has no control-flow components, so every structural tag becomes a plain JSX expression: what you would have written by hand.

| Written | Emitted |
|---|---|
| `text`, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML={{ __html: expr }}` |
| `class="a"`, `.a` | `className="a"` |
| `class={ a: cond }`, `class=[…]` | `className={mxClass({ a: cond })}` |
| `<label for=…>` | `htmlFor={…}` |
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
| `<try>` | `MxErrorBoundary`, with `MxPlaceholder` for `<@placeholder>` |

## Element or component?

MX follows Marko's rule, not JSX's capital letter: a tag is a component when a binding in scope or a [discovered custom tag](/custom-tags/discovery/) has that name, whatever its case. A `tags/badge.mx` makes `<badge/>` a component call. The other side of the rule: an import named like an element (`import { label } from "./i18n"`) turns `<label>` into a call of it. Rename the import.

## Keys

Every `<for>` row carries a `key`.

- `by="id"` keys by a field of the row. Use it for objects.
- `by=fn` keys by a function of the row and its index.
- With no `by`, the key is the row itself: the item for `of`, the property name for `in`, the number for a range.

The default is right for unique strings and numbers. It is wrong for a list with duplicates (React warns and may reuse the wrong node) and for objects (a rebuilt array remounts every row). Give those a `by`.

## Events

`onClick=fn` and `onClick() { … }` bind a handler on an element. MX reads the DOM event name (the text after `on`, lowercased) and emits the prop `@types/react` declares for it, each of which react-dom binds:

| Written | Emitted |
|---|---|
| `onClick=f` | `onClick={f}` |
| `onKeydown=f`, `onKeyDown=f` | `onKeyDown={f}` |
| `onDblClick=f`, `on-dblclick=f` | `onDoubleClick={f}` |
| `onDoubleClick=f` | `onDoubleClick={f}` (MX also warns: `doubleclick` is not a DOM event) |
| `onFocusIn=f` | `onFocus={f}` |

- **Only names React declares.** A DOM event `@types/react` has no handler prop for is a compile error, even where react-dom binds it (`on-fullscreenchange`), and so is any other unlisted name (`on-search`, `on-gesturestart`).
- **Custom DOM events** (`on-my-event=f`) are a compile error on React, Preact and Hono alike. Use a `ref` callback that calls `addEventListener`.
- **On a component**, `onSelect=pick` is an ordinary prop.
- `on:click` is not MX syntax; the error names `onClick`.

The handler receives React's synthetic event. `onChange` on a text field fires per keystroke, as in any React app. The shared rules are in [Attributes](/language/attributes/#attributes-event-attributes).

## `<try>`: error and loading states

```mx
<try>
  <Profile id=userId/>
  <@placeholder><p>Loading…</p></@placeholder>
  <@catch|err|><p.error>${err.message}</p></@catch>
</try>
```

`<@catch>` becomes `MxErrorBoundary`, a React class component using `componentDidCatch`; `<@placeholder>` becomes React's `Suspense`. Both come from `@mxlang/host-react/runtime` and are imported only when used. With both present, the placeholder sits inside the boundary, so a render error reaches the catch.

The body is handed to the boundary as a function, so a throw written directly in the `<try>` body is caught with the real error, on the server too, and none of the partial body is rendered. React's server renderer runs no error boundaries, so a descendant component's throw during a server render goes to the nearest `Suspense`: the boundary wraps its body in one whose fallback is `<@catch>`. The client then renders the real catch. Three differences from Marko follow, all React-only:

- With both `<@catch>` and `<@placeholder>`, a descendant's server-side throw renders `<@placeholder>` in the server HTML, and `<@catch>` after the client renders.
- With `<@catch>` and no `<@placeholder>`, a body that suspends (`lazy()`, `use(promise)`) shows `<@catch>` while it is pending. Add a `<@placeholder>` for the loading state.
- A descendant's server-side throw gives `<@catch|e|>` a stand-in `Error`; the client render passes the real one.

A suspension (`use(promise)`, a thrown promise) written in the body is not an error: it reaches the nearest `Suspense`, not `<@catch>`. Hooks written inline in a `<try>` body run in the boundary's body component, so if such a body throws midway on a re-render, `<@catch|e|>` receives React's hook-count error ("Rendered fewer hooks than expected"), not your error; keep hooks in top-level `<const>` tags.

## Children and `content`

MX calls a component with `children`, the JSX way, so hand-written React components work unchanged. A whole-file `.mx` component that reads Marko's `input.content` receives the same value.

## Attribute tags on your own components

Export an `Input` type from the component and mark the markup props with `AttrTag` from `@mxlang/host-react`. A renderable is a `ReactNode`; with `params` it is a function returning one; `AttrTag[]` is a real array. With no declaration, MX infers the shape from the call, which is how `<Suspense><@fallback>…</@fallback></Suspense>` works on a library component. See [AttrTag](/language/attr-tag/).

## How this is checked

`bun run oracle:react` renders the shared fixture set with `react-dom/server` and compares it with Marko's own output on every CI run. `examples/react-app` and `examples/react-region-app` are driven in a real browser.

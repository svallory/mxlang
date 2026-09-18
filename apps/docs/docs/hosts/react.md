---
title: "React host"
description: "Compile .mx templates to native React component modules on the shared JSX emitter."
---

# React host

`@mxlang/react` compiles a `.mx` or `.marko` template to a React component
module. Structural MX becomes ordinary React TSX: `<if>` becomes a ternary,
`<for>` becomes `.map()` with a `key`, component children are JSX children,
and attribute tags become props.

## Setup

```jsonc
{
  "dependencies": {
    "@mxlang/react": "*",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "mx": { "host": "react" }
}
```

```ts
import react from "@vitejs/plugin-react";
import mx from "@mxlang/vite-plugin";

export default defineConfig({ plugins: [mx(), react()] });
```

The same host policy drives Vite, editor diagnostics, and `mx-tsc`. See
`examples/react-app` for the complete app.

## React-specific output

The host emits `/** @jsxImportSource react */`, maps `class` to `className` and
HTML `for` to `htmlFor`, keeps style objects, and uses
`dangerouslySetInnerHTML={{ __html: value }}` for a sole raw placeholder.
Structured class objects and arrays go through `mxClass` so they remain Marko
class semantics instead of rendering as `[object Object]`.

React and Preact share one structural emitter. `@mxlang/react` depends on
`@mxlang/preact` and supplies a React target object containing only the names
that differ. Its runtime is native React—not a Preact compatibility layer.

## Events

An element's `on<Name>=fn` (`onClick`, `onKeyDown`) or `on-<exact>=fn`
(`on-my-event`) is an event handler. MX derives the **DOM event name** —
everything after `on` lowercased, or the exact text after `on-` — and that
name is the *input*; React's prop spelling is a **lookup** in React's own
event registration table, vendored into this target (`buildReactEventPropNames`
in `packages/hosts/react/src/target.ts`, from react-dom's
`simpleEventPluginEvents`). There is no rule an author can derive in reverse:
React's names are camelCase data that react-dom lowercases for the DOM, so
`keydown` → `onKeyDown`, `mousedown` → `onMouseDown`, `timeupdate` →
`onTimeUpdate`, `dblclick` → `onDoubleClick`, `focusin` → `onFocus`,
`focusout` → `onBlur`. `onClick=f` → `onClick={f}`; `onDblClick=f` and
`on-dblclick=f` both → `onDoubleClick={f}`. A drift test compares the
vendored list against the installed react-dom on every run.

- **No aliases.** `onDoubleClick` lowercases to `doubleclick`, which is not
  a DOM event and which React would silently drop: the compiler warns at the
  attribute and emits `onDoubleclick={f}` exactly as written.
- **Custom DOM events** (`on-my-event=f`) are a compile error naming the
  portable route: a `ref` callback calling
  `addEventListener("my-event", fn)`. The error is uniform across Preact,
  React and hono, so the same MX source never binds on one and dies on
  another.
- **Static strings** (`onClick="alert(1)"`) are an ordinary attribute and
  pass through verbatim; MX does not invent a policy against inline handler
  strings — it only stops creating one from a function.
- **`on:` / `oncapture:`** are rejected with a fix-it naming `on-<exact>`:
  `on:click=fn` → `onClick=fn` (or `on-click=fn` for a custom name).
- On a **component**, an `on*` attribute is an ordinary prop (`<Row
  onSelect=pick/>` passes the callback), never an event.

The handler receives React's synthetic event wrapping the DOM event, as React
always delivers. React's `onChange`-binds-`input` behavior on text fields is
React's own — see the `onChange` gotcha in
[Attributes](/language/attributes).

## Hooks and boundaries

```marko
import { useState } from "react";

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>
<button onClick() { setCount(count + 1); }>${count}</button>
```

`<const>` is emitted in the component body, where hooks belong. `static` is
module scope and must not call hooks. Marko's stateful tags are errors naming
React equivalents (`useState`, `useEffect`, `useId`).

`<try>` lowers to `MxErrorBoundary`, a native React class component using
`componentDidCatch`; `<@placeholder>` uses React's `Suspense`. Both live in
`@mxlang/react/runtime`, alongside `mxClass`, and are imported only when used.
With both present the placeholder nests inside the boundary, so a render error
reaches the catch:

```html
<try>
  <p>${input.body()}</p>
  <@placeholder><p>loading</p></@placeholder>
  <@catch|err|><p>${err.message}</p></@catch>
</try>
```

```tsx
<MxErrorBoundary fallback={(err) => <p>{err.message}</p>}>
  <MxPlaceholder fallback={<p>loading</p>}>
    <p>{input.body()}</p>
  </MxPlaceholder>
</MxErrorBoundary>
```

## What each construct lowers to

Every structural kind becomes a plain JSX expression — React has no
control-flow components, so there is nothing else for them to become.

| Written | Emitted |
|---|---|
| `text`, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML` |
| `class="a"` | `className="a"` |
| `class={a: cond}` | `className={mxClass({a: cond})}` |
| `<label for=…>` | `htmlFor={…}` |
| `style={color: c}` | `style={{color: c}}` |
| `onClick() { … }` | `onClick={() => { … }}` |
| `<if>` / `<else-if>` / `<else>` | a conditional expression, `null` for a missing else |
| `<for|x| of=xs>` | `{[...xs].map((x) => …)}` with a `key` |
| `<for|v, k| in=obj>` | `Object.entries` map, keyed by the property name |
| `<for|i| from=a to=b>` | a generated range map |
| `<Comp x=1/>` | `<Comp x={1}/>` |
| `<Comp>children</Comp>` | children passed the JSX way |
| `<Comp\|item\|>` | a render-prop callback |
| `<@name>` | the prop `name`; repeated tags become an array |
| `<const/x=expr/>` | a `const` in the component body |
| `<define/Row\|p\|>` | a nested function component |
| `<try>` | `MxErrorBoundary` / `MxPlaceholder` |

Element-versus-component follows **Marko's** rule, not JSX's: a tag resolves
to a component when a binding or taglib entry says so, whatever its case. A
`tags/`-discovered `<badge/>` is a component call, not a literal `<badge>`
element.

## Every `<for>` row carries a `key`

React re-creates rows without one. `by="id"` names a field of the row, `by=fn`
is a function of it, and with no `by=` the key is the row's own identity — the
item for `of`, the property name for `in`, the loop value for a range.

That default is right for unique primitives and stable ranges. Two cases need
an explicit `by=`, neither detectable at compile time:

- **Duplicates.** `["a", "b", "a"]` keys two rows `"a"`; React warns and may
  reconcile wrongly. Key by position: `by=(tag, index) => index`.
- **Objects.** Identity changes whenever the array is rebuilt, remounting every
  row. Key by a stable field: `by="id"`.

## Verification

`bun run oracle:react` renders the 43 stock fixtures with
`react-dom/server`'s `renderToStaticMarkup`: **30 pass, 13 reasoned skips, 0
bugs**. `examples/react-app` adds the browser proof: Chromium clicks a live
counter and observes a render error caught by `<try>`.

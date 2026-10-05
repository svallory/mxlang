---
title: "React host"
description: "A React component with MX in place of JSX: the .mx file compiles to an ordinary React function component module."
---

# React host

A React component with MX in place of JSX. The file below is an ordinary React function component: props, `useState` and the rest of the hooks, the `react` runtime, `@vitejs/plugin-react` and every React tool stay exactly as React provides them. The only thing MX replaces is the JSX. Because the template is the whole file, there is no function wrapper to write: the compiler emits the default-exported function component, your `export interface Input` becomes its props type, and hooks go in `<const>` tags, which lower to statements in the component body.

```tsx title="Greeter.tsx"
import { useState } from "react";

export interface Input {
  label: string;
  names: { id: number; text: string }[];
}

export default function Greeter({ label, names }: Input) {
  const [count, setCount] = useState(0);
  return (
    <section>
      <h1>{label}</h1>
      <button onClick={() => setCount(count + 1)}>clicked {count}</button>
      {count > 2 && <p>That is plenty.</p>}
      <ul>
        {names.map((name) => (
          <li key={name.id}>{name.text}</li>
        ))}
      </ul>
    </section>
  );
}
```

```mx title="Greeter.mx"
import { useState } from "react";

export interface Input {
  label: string;
  names: { id: number; text: string }[];
}

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>

<section>
  <h1>${input.label}</h1>
  <button onClick() { setCount(count + 1); }>clicked ${count}</button>
  <if=(count > 2)><p>That is plenty.</p></if>
  <ul>
    <for|name| of=input.names by="id"><li>${name.text}</li></for>
  </ul>
</section>
```

`@mxlang/react` compiles a `.mx` or `.marko` template to a React component
module. Structural MX becomes ordinary React TSX: `<if>` becomes a ternary,
`<for>` becomes `.map()` with a `key`, component children are JSX children,
and attribute tags become props.

## Selecting the host

`mx.host: "react"` selects `react-jsx`; `mx.target: "react-jsx"` alone selects
React behaviour too. These are `package.json` keys, separate from TypeScript's
`compilerOptions.jsx`. If both MX keys are given, the target must belong to
React; disagreement is a positioned `target-host-mismatch` error (decisions
129/132; [spec §13.5](/specification/#135-host-and-target-selection)).

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
`@mxlang/preact` and supplies a React dialect object containing only the names
that differ. Its runtime is native React—not a Preact compatibility layer.

Attribute-tag contracts import `AttrTag` from `@mxlang/react`. A renderable is
a `ReactNode`; data is `{ ...attrs, ...nestedTags, content?: ReactNode }`.
Params turn either renderable position into a function returning `ReactNode`,
and repeated tags are real arrays. See [AttrTag](/language/attr-tag/) for the
shared cardinality, fallback, nesting, and TSX-consumer rules.

## Events

An element's `on<Name>=fn` (`onClick`, `onKeyDown`) or `on-<exact>=fn`
(`on-my-event`) is an event handler. MX derives the **DOM event name** —
everything after `on` lowercased, or the exact text after `on-` — and that
name is the *input*; React's prop spelling is a **lookup** in React's own
event registration table, vendored into this target (`buildReactEventPropNames`
in `packages/hosts/react/src/dialect.ts`, from react-dom's
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

```mx
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

## Region files (`.react.mx`)

A `.react.mx` file is a TSX module with MX regions in it, the way `.solid.mx` is for [Solid](/hosts/solid/). The component is still a React function: props, `useState` and every other hook, imports and your own TypeScript stay as you wrote them. MX markup goes where JSX would, and each region compiles to a JSX expression in the same position.

```mx title="Page.react.mx"
import { useState } from "react";

export default function Page() {
  const [label] = useState("from-state");
  return (
    <ul>
      <define/Row|n: number|><li>${label} ${n}</li></define>
      <Row(1)/>
      <Row(2)/>
    </ul>
  );
}
```

This is the fixture `packages/hosts/react/src/fixtures/region/define-reads-state`. It renders `<ul><li>from-state 1</li><li>from-state 2</li></ul>`.

**Behaviour change.** A `*.react.mx` file is no longer a whole-file `.mx`. It is a region file: the Bun loaders decline it, and the Vite plugin, the language server, the TypeScript plugin and `mx-tsc` route it as a region file. Whole-file templates keep the plain `.mx` extension, and their output is unchanged.

- **One root element per region.** A region is one MX element. A TSX fragment `<>…</>` is not a region: each child element of it becomes its own region, as in `.solid.mx`. Markup that belongs together (`<if>`/`<else>` siblings, a `<define>` and its callers) goes inside one element.
- **What may appear inside.** The markup the React host lowers in a whole-file `.mx`: native elements, components, `<if>`/`<else-if>`/`<else>`, `<for>`, attribute tags, dynamic tags, `<define>` and a `/var` tag variable. A region renders what the same markup renders in a whole-file `.mx`.
- **Hooks stay in the component.** `<let>`, `<effect>`, `<id>` and `<lifecycle>` are errors that name only the hook to call in the surrounding component. Each message begins with the Marko meaning: "`<let>` is Marko reactive state; use React's `useState` in the surrounding component", and likewise `<effect>` with `useEffect`, `<id>` with `useId`, and `<lifecycle>` with `useEffect`/`useLayoutEffect`. `<const>` cannot declare a binding either: "`<const>` cannot declare a binding inside a `.react.mx` expression; declare it in the surrounding component".
- **Module-level MX is refused.** `import`, `static`, `export`, `Input` and `<return>` handed to a region fail with "module-level MX statements cannot appear inside a `.react.mx` expression; write them in the surrounding TypeScript module", positioned at the statement. Ordinary TypeScript imports and exports around the region are yours to write.
- **`<define>` and `/var` placement.** A `<define>` and a `/var` met directly in the region's markup are lifted into one arrow function that wraps the region (`<>{(() => { const Row = …; return <>…</>; })()}</>`), so they see the component's hooks and props. Every call site is a plain call, `{Row(1)}`, never `<Row/>`, so a define has no component identity of its own and does not remount. Inside `<for>`, `<if>`, an attribute-tag body or another `<define>` body, they are errors: "`<define>` inside `<for>`, `<if>`, an attribute-tag body or a `<define>` body cannot be lifted out of it in a `.react.mx` region without changing its scope; declare it directly in the region's markup, outside those bodies" (and the matching `/var` text, "is not supported in a `.react.mx` region").
- **Duplicate declarations.** One region is one arrow, so two `<define>`s of a name, two `/var`s of a name, or a `<define>` and a `/var` of the same name (in either order, including a name inside a destructured `/var`) fail with Marko's text, `Duplicate declaration "Row"`, positioned at the second name. The same name in two different regions of one file is fine.
- **Hoisted imports.** A region is an expression and has no module scope, so what it needs at module level is placed in the surrounding module for you: the runtime imports (`@mxlang/react/runtime`), the import of a discovered `tags/*.mx` tag, and the attribute, `<textarea>` and dynamic-tag helpers. Each lands once per module. See [Custom tag templates](/custom-tags/templates/).

Type errors inside a region are reported at the authored position by the TypeScript plugin and `mx-tsc`. The language server does not run TypeScript, so it reports only the MX errors above.

## What each construct lowers to

Every structural kind becomes a plain JSX expression — React has no
control-flow components, so there is nothing else for them to become.

| Written | Emitted |
|---|---|
| `text`, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML` |
| `class="a"` | `className="a"` |
| `class={a: cond}` | `className={__mxClass({a: cond})}` |
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

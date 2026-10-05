---
title: "Hono host"
description: "A Hono JSX component with MX in place of JSX: the .mx file compiles to an ordinary hono/jsx function component module."
---

# Hono host

A Hono JSX component with MX in place of JSX. The file below is an ordinary `hono/jsx` function component: it returns Hono JSX, takes props, and is rendered by Hono's own runtime in your routes. MX replaces only the JSX. Because the template is the whole file, there is no function wrapper to write: the compiler emits the default-exported function component and your `export interface Input` becomes its props type. Hono renders on the server, so the example has no event handler.

```tsx title="Greeter.tsx"
export interface Input {
  label: string;
  names: { id: number; text: string }[];
}

export default function Greeter({ label, names }: Input) {
  return (
    <section>
      <h1>{label}</h1>
      {names.length > 2 && <p>That is plenty.</p>}
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
export interface Input {
  label: string;
  names: { id: number; text: string }[];
}

<section>
  <h1>${input.label}</h1>
  <if=(input.names.length > 2)><p>That is plenty.</p></if>
  <ul>
    <for|name| of=input.names by="id"><li>${name.text}</li></for>
  </ul>
</section>
```

`@mxlang/hono` compiles a `.mx` or `.marko` template to a Hono JSX component
module. Structural MX becomes ordinary `hono/jsx` TSX: `<if>` becomes a
ternary, `<for>` becomes `.map()` with a `key`, component children are JSX
children, and attribute tags become props.

## Selecting the host

`mx.host: "hono"` selects `hono-jsx`; `mx.target: "hono-jsx"` alone selects
Hono behaviour too. If both keys are given, the target must belong to Hono;
disagreement is a positioned `target-host-mismatch` error (decisions 129/132;
[spec §13.5](/specification/#135-host-and-target-selection)).

## Setup

```jsonc
{
  "dependencies": {
    "@mxlang/hono": "*",
    "hono": "4.6.20"
  },
  "mx": { "host": "hono" }
}
```

For a plain Bun server with no bundler, preload the Bun loader:

```toml
# bunfig.toml
preload = ["@mxlang/hono/bun"]
```

```ts
import { Hono } from "hono";
import App from "./App.mx";

const app = new Hono();
app.get("/", async (c) => c.html(await App({}).toString()));
```

The same host policy drives Vite, editor diagnostics, and `mx-tsc`. See
`examples/hono-app` for the complete app.

## Hono-specific output

The host emits `/** @jsxImportSource hono/jsx */` and keeps `class`/`for`
native — Hono, like Preact, accepts them directly with no renaming. It uses
`dangerouslySetInnerHTML={{ __html: value }}` for a sole raw placeholder.
Structured class objects and arrays go through `mxClass` so they remain Marko
class semantics instead of rendering as `[object Object]`.

Hono shares the same structural emitter as Preact and React. `@mxlang/hono`
depends on `@mxlang/preact` and supplies a Hono dialect object containing only
the names that differ. Unlike Preact and React, it ships **no hand-rolled
error boundary or suspense component** — Hono's `hono/jsx` provides
`ErrorBoundary` and `Suspense` natively, so this host's runtime supplies only
`mxClass`.

Attribute-tag contracts import `AttrTag` from `@mxlang/hono`. A renderable is
a Hono `Child`; data is `{ ...attrs, ...nestedTags, content?: Child }`. Params
turn either renderable position into a function returning `Child`, and repeats
are real arrays. See [AttrTag](/language/attr-tag/) for the shared contract and
the decision-108 fallback used by untyped library components.

## Events

An element's `on<Name>=fn` (`onClick`, `onDblClick`) or `on-<exact>=fn`
(`on-my-event`) is an event handler. MX derives the **DOM event name** —
everything after `on` lowercased, or the exact text after `on-` — and this
host emits a JSX prop recomposed from it: `on` plus the capitalized DOM
name. `onClick=f` → `onClick={f}`; `onDblClick=f` and `on-dblclick=f` both
→ `onDblclick={f}` (hono lowercases the prop name at bind time, so it binds `dblclick`).

- **No aliases.** `onDoubleClick` lowercases to `doubleclick`, which is not
  a DOM event: the compiler warns at the attribute and emits
  `onDoubleclick={f}` exactly as written.
- **Custom DOM events** (`on-my-event=f`) are a compile error naming the
  portable route: a `ref` callback calling
  `addEventListener("my-event", fn)`. The error is uniform across Preact,
  React and hono, so the same MX source never binds on one and dies on
  another.
- **`onChange` binds the `input` event**, for React compatibility — on every
  keystroke, not on commit the way `change` fires elsewhere. If you need one
  behaviour, say so: `onInput` for per-keystroke, or handle `change`'s
  timing in the handler. This is hono's runtime semantics, documented not
  shimmed; see the gotcha in [Attributes](/language/attributes).
- **Static strings** (`onClick="alert(1)"`) are an ordinary attribute and
  pass through verbatim; MX does not invent a policy against inline handler
  strings — it only stops creating one from a function.
- **`on:` / `oncapture:`** are rejected with a fix-it naming `on-<exact>`:
  `on:click=fn` → `onClick=fn` (or `on-click=fn` for a custom name).
- On a **component**, an `on*` attribute is an ordinary prop (`<Row
  onSelect=pick/>` passes the callback), never an event.

## Hooks and boundaries

```mx
import { useState } from "hono/jsx";

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>
<button onClick() { setCount(count + 1); }>${count}</button>
```

`<const>` is emitted in the component body, where hooks belong. `static` is
module scope and must not call hooks. Marko's stateful tags are errors naming
Hono equivalents (`useState`, `useEffect`, `useId`).

`<try>` lowers to `hono/jsx`'s own `ErrorBoundary`, imported directly —
its fallback prop is `fallbackRender`, a function of the error, unlike
Preact's/React's `fallback` (which also accepts a bare node); `<@placeholder>`
uses `hono/jsx`'s own `Suspense`. Neither is wrapped by this package. With
both present the placeholder nests inside the boundary, so a render error
reaches the catch:

```html
<try>
  <p>${input.body()}</p>
  <@placeholder><p>loading</p></@placeholder>
  <@catch|err|><p>${err.message}</p></@catch>
</try>
```

```tsx
<ErrorBoundary fallbackRender={(err) => <p>{err.message}</p>}>
  <Suspense fallback={<p>loading</p>}>
    <p>{input.body()}</p>
  </Suspense>
</ErrorBoundary>
```

## Region files (`.hono.mx`)

A `.hono.mx` file is a TSX module with MX regions in it, the way `.solid.mx` is for [Solid](/hosts/solid/). The component is still a Hono function: props, `useState` and every other hook, imports and your own TypeScript stay as you wrote them. MX markup goes where JSX would, and each region compiles to a JSX expression in the same position.

```mx title="Page.hono.mx"
import { useState } from "hono/jsx";

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

This is the fixture `packages/hosts/hono/src/fixtures/region/define-reads-state`. It renders `<ul><li>from-state 1</li><li>from-state 2</li></ul>`.

**Behaviour change.** A `*.hono.mx` file is no longer a whole-file `.mx`. It is a region file: the Bun loaders decline it, and the Vite plugin, the language server, the TypeScript plugin and `mx-tsc` route it as a region file. Whole-file templates keep the plain `.mx` extension, and their output is unchanged.

- **One root element per region.** A region is one MX element. A TSX fragment `<>…</>` is not a region: each child element of it becomes its own region, as in `.solid.mx`. Markup that belongs together (`<if>`/`<else>` siblings, a `<define>` and its callers) goes inside one element.
- **What may appear inside.** The markup the Hono host lowers in a whole-file `.mx`: native elements, components, `<if>`/`<else-if>`/`<else>`, `<for>`, attribute tags, dynamic tags, `<define>` and a `/var` tag variable. A region renders what the same markup renders in a whole-file `.mx`.
- **Hooks stay in the component.** `<let>`, `<effect>`, `<id>` and `<lifecycle>` are errors that name only the hook to call in the surrounding component. Each message begins with the Marko meaning: "`<let>` is Marko reactive state; use Hono's `useState` in the surrounding component", and likewise `<effect>` with `useEffect`, `<id>` with `useId`, and `<lifecycle>` with `useEffect`/`useLayoutEffect`. `<const>` cannot declare a binding either: "`<const>` cannot declare a binding inside a `.hono.mx` expression; declare it in the surrounding component".
- **Module-level MX is refused.** `import`, `static`, `export`, `Input` and `<return>` handed to a region fail with "module-level MX statements cannot appear inside a `.hono.mx` expression; write them in the surrounding TypeScript module", positioned at the statement. Ordinary TypeScript imports and exports around the region are yours to write.
- **`<define>` and `/var` placement.** A `<define>` and a `/var` met directly in the region's markup are lifted into one arrow function that wraps the region (`<>{(() => { const Row = …; return <>…</>; })()}</>`), so they see the component's hooks and props. Every call site is a plain call, `{Row(1)}`, never `<Row/>`, so a define has no component identity of its own and does not remount. Inside `<for>`, `<if>`, an attribute-tag body or another `<define>` body, they are errors: "`<define>` inside `<for>`, `<if>`, an attribute-tag body or a `<define>` body cannot be lifted out of it in a `.hono.mx` region without changing its scope; declare it directly in the region's markup, outside those bodies" (and the matching `/var` text, "is not supported in a `.hono.mx` region").
- **Duplicate declarations.** One region is one arrow, so two `<define>`s of a name, two `/var`s of a name, or a `<define>` and a `/var` of the same name (in either order, including a name inside a destructured `/var`) fail with Marko's text, `Duplicate declaration "Row"`, positioned at the second name. The same name in two different regions of one file is fine.
- **Hoisted imports.** A region is an expression and has no module scope, so what it needs at module level is placed in the surrounding module for you: the runtime imports (`@mxlang/hono/runtime`), the import of a discovered `tags/*.mx` tag, and the attribute, `<textarea>` and dynamic-tag helpers. Each lands once per module. See [Custom tag templates](/custom-tags/templates/).

Type errors inside a region are reported at the authored position by the TypeScript plugin and `mx-tsc`. The language server does not run TypeScript, so it reports only the MX errors above.

## What each construct lowers to

Every structural kind becomes a plain JSX expression — Hono's JSX has no
control-flow components, so there is nothing else for them to become.

| Written | Emitted |
|---|---|
| `text`, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML` |
| `class="a"` | `class="a"` (Hono takes `class` directly) |
| `class={a: cond}` | `class={__mxClass({a: cond})}` |
| `<label for=…>` | `for={…}` (native, unchanged) |
| `style={color: c}` | `style={{color: c}}` |
| `onClick() { … }` | `onClick={() => { … }}` |
| `<if>` / `<else-if>` / `<else>` | a conditional expression, `null` for a missing else |
| `<for\|x\| of=xs>` | `{[...xs].map((x) => …)}` with a `key` |
| `<for\|v, k\| in=obj>` | `Object.entries` map, keyed by the property name |
| `<for\|i\| from=a to=b>` | a generated range map |
| `<Comp x=1/>` | `<Comp x={1}/>` |
| `<Comp>children</Comp>` | children passed the JSX way |
| `<Comp\|item\|>` | a render-prop callback |
| `<@name>` | the prop `name`; repeated tags become an array |
| `<const/x=expr/>` | a `const` in the component body |
| `<define/Row\|p\|>` | a nested function component |
| `<try>` | `ErrorBoundary` / `Suspense`, both from `hono/jsx` |

Element-versus-component follows **Marko's** rule, not JSX's: a tag resolves
to a component when a binding or taglib entry says so, whatever its case. A
`tags/`-discovered `<badge/>` is a component call, not a literal `<badge>`
element.

## Every `<for>` row carries a `key`

Hono re-creates rows without one, the same as Preact/React. `by="id"` names a
field of the row, `by=fn` is a function of it, and with no `by=` the key is
the row's own identity — the item for `of`, the property name for `in`, the
loop value for a range.

That default is right for unique primitives and stable ranges. Two cases need
an explicit `by=`, neither detectable at compile time:

- **Duplicates.** `["a", "b", "a"]` keys two rows `"a"`; the renderer may
  reconcile wrongly. Key by position: `by=(tag, index) => index`.
- **Objects.** Identity changes whenever the array is rebuilt, remounting
  every row. Key by a stable field: `by="id"`.

## No client hydration by default

`hono/jsx`'s server render (`String(jsx(Component, input))`, or Hono's own
`c.html(...)`) produces plain HTML with no resume markers, island wrappers, or
hydration bootstrap script. `examples/hono-app`'s e2e suite asserts the
response contains no `<script>` tag at all.

## Bun loader

`@mxlang/hono/bun` registers a Bun plugin loading `.mx`/`.marko` files as
`loader: "tsx"` — the same shape as `@mxlang/html/bun`'s Bun loader, but
`"tsx"` instead of `"ts"` since this host's compiled output contains JSX. Bun
honors the emitted `/** @jsxImportSource hono/jsx */` pragma per file, so no
bundler is required for a plain Bun server. The loader declines region files (`.react.mx`, `.preact.mx`, `.hono.mx`): they are TypeScript modules with MX regions, not whole-file templates. A hand-written `.tsx` sibling
without its own pragma still needs the running script's *own* project
`tsconfig.json` to set `jsxImportSource: "hono/jsx"` — running it under a
different project's tsconfig (or an override pointing elsewhere) makes Bun's
JSX transform silently pick the wrong runtime for that one file. See
`examples/hono-app`.

## Verification

`bun run oracle:hono` renders the 43 stock fixtures through `hono/jsx`
(`String(jsx(Component, input))`, awaited when the tree contains a caught
error — `ErrorBoundary` resolves asynchronously once its child throws): **30
pass, 13 reasoned skips, 0 bugs** — identical to `oracle:preact` and
`oracle:react`, since all three targets share the emitter and the skip list.
`examples/hono-app` adds the server proof: Playwright fetches a live Hono
server rendering a `<for>` list and two `<try>` blocks, one of which the
built-in `ErrorBoundary` catches.

# `@mxlang/preact`

MX's Preact host: a `.mx` template compiles to a **Preact
component module** — JSX text carrying its own `@jsxImportSource` pragma, with
the author's imports and `static` blocks at module scope and their
`export interface Input` as the component's props type.

The fourth emitter on `@mxlang/core`'s IR (decisions 71, 79, 81, 82), and the
first whose target has no control-flow components at all. Where
`@mxlang/solid` has `<Show>`/`<For>` and `@mxlang/astro` has its own template
syntax, Preact has plain JSX plus JavaScript — so every structural kind lowers
to an *expression*, exactly as a Preact author would write it by hand.

Project [custom tags](../../../apps/docs/docs/custom-tags/index.md) expand to
that same ordinary IR before this emitter runs; a tag definition never needs
Preact-specific code.

## Install

```jsonc
// package.json
{
  "dependencies": {
    "@mxlang/preact": "workspace:*",
    "preact": "10.29.8"
  },
  "mx": { "host": "preact" }
}
```

The `mx.host` field is what routes `.mx` files here. It is read by
`@mxlang/core`'s `resolveTargetPolicy`, which the Vite plugin, the language
server and `mx-tsc` all share — so an editor, a `tsc` run and a build cannot
disagree about what a `.mx` file is. A project depending on exactly one
`@mxlang/*` host package gets that host without the field.

```ts
// vite.config.ts — mx() first: both plugins are `enforce: "pre"`, so their
// relative order is their order in this array.
import mx from "@mxlang/vite-plugin";
import preact from "@preact/preset-vite";

export default defineConfig({ plugins: [mx(), preact()] });
```

See `examples/preact-app` for a complete app.

## The emitted module

```tsx
/** @jsxImportSource preact */
import { Fragment } from "preact";

import Counter from "./Counter.mx";   // the author's own imports
const GREETING = "hi";                // the author's `static` blocks

export interface Input { title: string }

export default function (props: Input) {
  const input: Input & { content?: unknown } = {
    ...props,
    content:
      (props as { content?: unknown }).content ??
      (props as { children?: unknown }).children,
  };
  // <const> and <define> bindings, in source order
  return (<><h1>{input.title}</h1></>);
}
```

The template's own expressions read `input`, because that is the name MX
templates already use (`${input.title}`). The JSX parameter is `props`, and
the first line bridges the two: **Marko spells a component's ordinary children
`content` while JSX spells the same slot `children`**, and this host emits
calls the JSX way so a hand-written Preact component can be called from MX.
Without the bridge, `<Card><p/></Card>` compiles cleanly and renders an empty
card.

An import is emitted only when the template's output actually references it,
so a template using no `<try>` and no structured `class` imports nothing.

## Lowering table

| MX | Preact |
| --- | --- |
| text, `${expr}` | text, `{expr}`. `{`/`}` in literal text become entities, which JSX would otherwise read as an expression |
| `$!{expr}` (sole child) | `dangerouslySetInnerHTML={{ __html: expr }}` |
| `<div>`, `<input>` | the same JSX element; void elements self-close |
| `class="a"` | `class="a"` — Preact's native prop, not `className` |
| `class={a: cond}`, `class=["x", {…}]` | `class={mxClass(…)}`, joined by the shipped helper: Preact's `class` takes a string, and passing the object through renders `[object Object]` |
| `style={color: c}` | `style={{ color: c }}` |
| `onClick() { … }` | `onClick={() => …}` — an arrow, so `this` stays lexical |
| `...rest` | `{...rest}` |
| `<if=c>`/`<else-if=c>`/`<else>` | one ternary chain, ending in `null` when there is no `<else>` |
| `<for|x| of=xs>` | `[...xs].map((x) => <Fragment key={…}>…</Fragment>)` |
| `<for|k, v| in=obj>` | `Object.entries(obj).map(([k, v]) => …)` |
| `<for|i| from=a to=b step=s>` | `Array.from({length: …}, (_, i) => …).map(…)` |
| `<Comp x=1/>` | `<Comp x={1} />` |
| `<Comp>children</Comp>` | JSX children |
| `<Comp|item|>…</Comp>` | a render-prop child: `{(item) => …}` |
| `<@name>body</@name>` | the prop `name={body}`; with params, `name={(p) => body}`; **repeated, an array** |
| `<const/x=expr/>` (top level) | `const x = expr;` in the component body |
| `<define/R|p|>…</define>` (top level) | `const R = (p) => (<>…</>);` |
| `<try>` + `<@catch>`/`<@placeholder>` | `<MxErrorBoundary>` / `<MxPlaceholder>` (see below) |
| `import`, `static`, `export` | hoisted verbatim to module scope |
| `<${expr}>` (dynamic tag) | `mxDynamic(expr, props)` — JSX's tag position is static, so the target can't be written there directly |
| `<return>` + `/var` | `{ value, output }`; `/var` at the top level only; a unit importing a hook is rejected |

### The `key` rule

Every `<for>` row gets a `key`, because a Preact list without one re-creates
its rows on each render. MX's `by=` is that key when the author gives one:

- `by="id"` — a **string** names a field of the row: `key={item.id}`.
- `by=fn` — anything else is a **function of the row**: `key={(fn)(item, i)}`.

When `by=` is absent the key is the row's **own identity**, which is this
host's documented default rather than an implicit one:

| form | default key |
| --- | --- |
| `of=xs` | the item — `key={item}` |
| `in=obj` | the property name — `key={k}` |
| `from=/to=/until=` | the loop value — `key={i}` |

That default is correct for a list of **unique** primitives and for a stable
range. Two cases need `by=`, and neither is detectable at compile time:

- **Duplicates.** `["a", "b", "a"]` produces two rows keyed `"a"`. Preact
  warns about the duplicate and may reconcile those rows wrongly — the second
  `"a"` can take the first's DOM node and its state.
- **Objects.** The key is object identity, which changes whenever the array is
  rebuilt, so every row remounts on each render.

```marko
<!-- duplicates: key by position, since the value is not unique -->
<for|tag, index| of=input.tags by=(tag, index) => index>
  <li>${tag}</li>
</for>

<!-- objects: key by a stable field -->
<for|todo| of=input.todos by="id">
  <li>${todo.text}</li>
</for>
```

Keying by index is the right answer only when the list is append-only or never
reordered; for a list that is sorted or filtered, key by a stable field of the
row instead.

### The `<try>` helper

Preact has no built-in error boundary component. It has the *hook* —
`componentDidCatch` on a class component — but no component wrapping it, and
`preact/compat`'s `Suspense` catches thrown *promises* rather than errors. So
this package ships both, in `@mxlang/preact/runtime`:

- **`MxErrorBoundary`** — a class component using `componentDidCatch` and
  `getDerivedStateFromError`, for `<@catch>`. Its `fallback` takes either a
  node or a function of the error, which is what lets `<@catch|error|>` name
  it. A class because that is the only form Preact gives the hook; there is no
  hook-based equivalent in Preact 10.
- **`MxPlaceholder`** — `preact/compat`'s `Suspense` under one name, for
  `<@placeholder>`. Aliased rather than re-implemented, so a body that
  suspends behaves exactly as Preact documents.

Both are ordinary Preact components with no MX-specific protocol: use them
directly, or replace them with your own. `mxClass` lives beside them.

When a `<try>` has both, the placeholder nests **inside** the boundary, so a
render error in the body reaches the catch rather than the suspense wrapper.

## Hooks

A hook call belongs in the **component body**, and `<const>` is what lowers
there:

```marko
import { useState } from "preact/hooks";

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>

<button onClick() { setCount(count + 1); }>${count}</button>
```

A `static` block hoists to **module scope** and runs once per module, so a
hook there is a rules-of-hooks violation. That is a property of the target,
and this host does not try to detect it — the same reason `@mxlang/html` does
not detect a template that renders `[object Object]`.

## Errors

Every construct this target cannot express is a compile error naming the
construct and where its equivalent lives — decision 65's rule, "this target
cannot", never "not implemented".

| construct | message names |
| --- | --- |
| `<let>` | Preact's `useState` |
| `<effect>` | `useEffect` |
| `<lifecycle>` | `useEffect`/`useLayoutEffect` |
| `<script>` | writing client code in an imported module |
| `<id>` | `useId` |
| `client` block | a Preact component already being client code |
| `<await>` | `<try>` with a `<@placeholder>` |
| `:=` | passing the value plus an explicit `onInput` handler |
| `class:active` | Preact's own spelling, `class={{ active: cond }}` |
| `style=` non-object | the object-literal form |
| `$!{…}` with siblings | the raw-HTML prop replacing the whole subtree |
| `<!doctype html>` | the HTML shell that mounts the app |
| `<const>`/`<define>` nested in markup | the top level of the template |

Two things are left to **Marko's own parser** rather than re-checked here,
both verified: `#id` beside an explicit `id=` ("Cannot have shorthand id and
id attribute"), and a bare `<${expr}/>` — which with no attributes and no body
is Marko's *placeholder* shape, not a dynamic tag, and lowers to an ordinary
interpolation.

## Component names and case

JSX decides element-vs-component by **case**: `<badge/>` is the DOM element
"badge" no matter what `badge` is bound to. Marko decides by **binding**, so a
`tags/`-discovered `badge.marko` is a component called `<badge/>`.

This host follows Marko's rule — the taglib lookup and the template's own
imports and `<define>`s, the same as `@mxlang/html` — and renames such a
component in the emitted JSX, binding `MxBadge` beside it. Emitted verbatim it
rendered a literal `<badge>` element with the props as attributes, which is a
silently wrong render rather than an error.

## Verification

```
bun run oracle:preact          # render parity against the html target
bunx vitest run --root ../../.. --project @mxlang/preact
```

`oracle:preact` compiles every fixture in the stock `.marko` set
(`packages/targets/html/fixtures-marko/`, the same 45 `oracle:marko` uses),
renders it with `preact-render-to-string`, and compares against the fixture's
own `expected.html` — which was generated from real Marko, so a pass means
this host agrees with Marko transitively. **32 pass, 13 skipped (each naming
the construct), 0 bugs.**

The comparison ignores attribute *order*, unlike `oracle:marko`'s: Preact owns
its serializer and emits props in its own order, so comparing positionally
would report a difference in Preact's output as a difference in MX's lowering.

## A React host

The lowering here is React's lowering. The two dialects differ in a handful of
*names* — the JSX import source, `class` versus `className`, which module the
error boundary comes from — and those live in `dialect.ts`'s `JsxDialect` object,
so a `@mxlang/react` package can pass its own and reuse this emitter rather
than fork it. A knob that would require an `if (dialect.kind === "react")` in
the emitter does not belong there: that would mean the dialects have genuinely
diverged, and the fork would be the honest answer.

---
title: "Preact host"
description: "The Preact host — a Preact component with MX in place of JSX: a .mx template compiles to an ordinary Preact component module, with every structural tag lowered to plain JSX."
---

# Preact host

A Preact component with MX in place of JSX. The file below is an ordinary Preact function component: props, the `preact/hooks` hooks, the `preact` runtime and `@preact/preset-vite` stay as Preact provides them, and MX replaces only the JSX. Because the template is the whole file, there is no function wrapper to write: the compiler emits the default-exported function component, your `export interface Input` becomes its props type, and hooks go in `<const>` tags, which lower to statements in the component body.

```tsx title="Greeter.tsx"
import { useState } from "preact/hooks";

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
import { useState } from "preact/hooks";

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

The Preact host compiles a `.mx` (or `.marko`) template to a **Preact component module**: JSX text carrying its own `@jsxImportSource` pragma, with the author's imports and `static` blocks at module scope and their `export interface Input` as the component's props type.

It ships as `@mxlang/preact` (`packages/hosts/preact`), the fourth emitter over `@mxlang/core`'s shared IR alongside the HTML, Astro and Solid hosts — and the first whose target has **no control-flow components at all**. Where Solid has `<Show>`/`<For>` and Astro has its own template syntax, Preact has plain JSX plus JavaScript, so every structural tag lowers to an *expression*: a ternary chain for `<if>`, a `.map` call for `<for>`, exactly what a Preact author would write by hand.

## Selecting the host

`mx.host: "preact"` selects the `preact-jsx` target. You can instead write
`mx.target: "preact-jsx"` alone; it selects Preact behaviour too. If both keys
are given, the target must belong to Preact, otherwise the tools report a
positioned `target-host-mismatch` error. See [spec §13.5](/specification/#135-host-and-target-selection)
(decisions 129/132).

```jsonc
// package.json
{
  "dependencies": { "@mxlang/preact": "*", "preact": "10.29.8" },
  "mx": { "host": "preact" }
}
```

`mx.host` is read by `@mxlang/core`'s `resolveTargetPolicy`, which the Vite plugin, the language server and `mx-tsc` all share — so an editor, a `tsc` run and a build cannot disagree about what a `.mx` file is. A project that depends on exactly one `@mxlang/*` host package gets that host without the field.

```ts
// vite.config.ts — mx() first: both plugins are `enforce: "pre"`.
export default defineConfig({ plugins: [mx(), preact()] });
```

## What it looks like

```mx
import { useState } from "preact/hooks";

export interface Input { label: string }

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>

<section>
  <h1>${input.label}</h1>
  <output>${count}</output>
  <button onClick() { setCount(count + 1); }>increment</button>
  <if=(count > 9)><p>double digits</p></if>
  <for|name| of=input.names by="id"><p>${name.text}</p></for>
</section>
```

Hooks go in `<const>`, which lowers to a statement in the **component body** where the rules of hooks hold. A `static` block hoists to module scope and runs once per module, so a hook there is a rules-of-hooks violation — a property of the target, which this host documents rather than detects.

## Two rules worth knowing

**Every `<for>` row gets a `key`.** A Preact list without one re-creates its rows on each render. `by="id"` names a field of the row; `by=fn` is a function of it; with no `by=` the key is the row's own identity — the item for `of`, the property name for `in`, the loop value for a range. That default is right for *unique* primitives and stable ranges. Two cases need `by=`, neither detectable at compile time: **duplicates** (`["a", "b", "a"]` keys two rows `"a"`, which Preact warns about and may reconcile wrongly — key by position with `by=(tag, index) => index`), and **objects** (identity changes whenever the array is rebuilt, remounting every row — key by a stable field with `by="id"`).

**Children cross the `content`/`children` gap.** Marko names a component's ordinary children `content`; JSX names the same slot `children`. The host emits calls the JSX way — so a hand-written Preact component can be called from MX — and the emitted component bridges the two names, so a template's own `${input.content}` still reads them.

**Attribute tags use Preact values.** Import `AttrTag` from
`@mxlang/preact`. A renderable tag is `ComponentChildren`; a data tag is
`{ ...attrs, ...nestedTags, content?: ComponentChildren }`. With params, the
renderable or `.content` becomes a function returning `ComponentChildren`.
Repeated tags are real arrays, including `[]`. The [AttrTag
guide](/language/attr-tag/) includes a hand-written TSX component and executed
Preact examples.

## Events

An element's `on<Name>=fn` (`onClick`, `onDblClick`) or `on-<exact>=fn`
(`on-my-event`) is an event handler. MX derives the **DOM event name** —
everything after `on` lowercased, or the exact text after `on-` — and this
host emits a JSX prop recomposed from it: `on` plus the capitalized DOM
name. `onClick=f` → `onClick={f}`; `onDblClick=f` and `on-dblclick=f` both
→ `onDblclick={f}` (Preact lowercases the prop name at bind time, so it binds `dblclick`).

- **No aliases.** `onDoubleClick` lowercases to `doubleclick`, which is not
  a DOM event: the compiler warns at the attribute and emits
  `onDoubleclick={f}` exactly as written — never silently `onDblclick`.
- **Custom DOM events** (`on-my-event=f`) are a compile error naming the
  portable route: a `ref` callback calling
  `addEventListener("my-event", fn)`. The error is uniform across Preact,
  React and hono, so the same MX source never binds on one and dies on
  another — even though Preact alone could carry the name.
- **Static strings** (`onClick="alert(1)"`) are an ordinary attribute and
  pass through verbatim; MX does not invent a policy against inline handler
  strings — it only stops creating one from a function.
- **`on:` / `oncapture:`** are rejected with a fix-it naming `on-<exact>`:
  `on:click=fn` → `onClick=fn` (or `on-click=fn` for a custom name).
- On a **component**, an `on*` attribute is an ordinary prop (`<Row
  onSelect=pick/>` passes the callback), never an event.

The handler receives the DOM event, as Preact always delivers it.

## `<try>`

Preact has no built-in error boundary component, so this host ships one. `@mxlang/preact/runtime` exports `MxErrorBoundary` (a class component using `componentDidCatch`, the only form Preact gives that hook) for `<@catch>`, and `MxPlaceholder` (`preact/compat`'s `Suspense` under one name) for `<@placeholder>`. Both are ordinary Preact components with no MX-specific protocol. When a `<try>` has both, the placeholder nests inside the boundary, so a render error reaches the catch.

## Region files (`.preact.mx`)

A `.preact.mx` file is a TSX module with MX regions in it, the way `.solid.mx` is for [Solid](/hosts/solid/). The component is still a Preact function: props, `useState` and every other hook, imports and your own TypeScript stay as you wrote them. MX markup goes where JSX would, and each region compiles to a JSX expression in the same position.

```mx title="Page.preact.mx"
import { useState } from "preact/hooks";

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

This is the fixture `packages/hosts/preact/src/fixtures/region/define-reads-state`. It renders `<ul><li>from-state 1</li><li>from-state 2</li></ul>`.

**Behaviour change.** A `*.preact.mx` file is no longer a whole-file `.mx`. It is a region file: the Bun loaders decline it, and the Vite plugin, the language server, the TypeScript plugin and `mx-tsc` route it as a region file. Whole-file templates keep the plain `.mx` extension, and their output is unchanged.

- **One root element per region.** A region is one MX element. A TSX fragment `<>…</>` is not a region: each child element of it becomes its own region, as in `.solid.mx`. Markup that belongs together (`<if>`/`<else>` siblings, a `<define>` and its callers) goes inside one element.
- **What may appear inside.** The markup the Preact host lowers in a whole-file `.mx`: native elements, components, `<if>`/`<else-if>`/`<else>`, `<for>`, attribute tags, dynamic tags, `<define>` and a `/var` tag variable. A region renders what the same markup renders in a whole-file `.mx`.
- **Hooks stay in the component.** `<let>`, `<effect>`, `<id>` and `<lifecycle>` are errors that name only the hook to call in the surrounding component. Each message begins with the Marko meaning: "`<let>` is Marko reactive state; use Preact's `useState` in the surrounding component", and likewise `<effect>` with `useEffect`, `<id>` with `useId`, and `<lifecycle>` with `useEffect`/`useLayoutEffect`. `<const>` cannot declare a binding either: "`<const>` cannot declare a binding inside a `.preact.mx` expression; declare it in the surrounding component".
- **Module-level MX is refused.** `import`, `static`, `export`, `Input` and `<return>` handed to a region fail with "module-level MX statements cannot appear inside a `.preact.mx` expression; write them in the surrounding TypeScript module", positioned at the statement. Ordinary TypeScript imports and exports around the region are yours to write.
- **`<define>` and `/var` placement.** A `<define>` and a `/var` met directly in the region's markup are lifted into one arrow function that wraps the region (`<>{(() => { const Row = …; return <>…</>; })()}</>`), so they see the component's hooks and props. Every call site is a plain call, `{Row(1)}`, never `<Row/>`, so a define has no component identity of its own and does not remount. Inside `<for>`, `<if>`, an attribute-tag body or another `<define>` body, they are errors: "`<define>` inside `<for>`, `<if>`, an attribute-tag body or a `<define>` body cannot be lifted out of it in a `.preact.mx` region without changing its scope; declare it directly in the region's markup, outside those bodies" (and the matching `/var` text, "is not supported in a `.preact.mx` region").
- **Duplicate declarations.** One region is one arrow, so two `<define>`s of a name, two `/var`s of a name, or a `<define>` and a `/var` of the same name (in either order, including a name inside a destructured `/var`) fail with Marko's text, `Duplicate declaration "Row"`, positioned at the second name. The same name in two different regions of one file is fine.
- **Hoisted imports.** A region is an expression and has no module scope, so what it needs at module level is placed in the surrounding module for you: the runtime imports (`@mxlang/preact/runtime`), the import of a discovered `tags/*.mx` tag, and the attribute, `<textarea>` and dynamic-tag helpers. Each lands once per module. See [Custom tag templates](/custom-tags/templates/).

Type errors inside a region are reported at the authored position by the TypeScript plugin and `mx-tsc`. The language server does not run TypeScript, so it reports only the MX errors above.

## What each construct lowers to

Every structural kind becomes a plain JSX expression — Preact has no
control-flow components, so there is nothing else for them to become.

| Written | Emitted |
|---|---|
| `text`, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML` |
| `class="a"` | `class="a"` (Preact takes `class` directly) |
| `class={a: cond}` | `class={__mxClass({a: cond})}` |
| `style={color: c}` | `style={{color: c}}` |
| `onClick() { … }` | `onClick={() => { … }}` |
| `...rest` | `{...rest}` |
| `<if>` / `<else-if>` / `<else>` | a conditional expression, `null` for a missing else |
| `<for\|x\| of=xs>` | `{[...xs].map((x) => …)}` with a `key` |
| `<for\|v, k\| in=obj>` | `Object.entries` map, keyed by the property name |
| `<for\|i\| from=a to=b>` | a generated range map |
| `<Comp x=1/>` | `<Comp x={1}/>` |
| `<Comp>children</Comp>` | children passed the JSX way |
| `<Comp\|item\|>` | a render-prop callback |
| `<@name>` | the prop `name`; repeated tags become an array |
| `<const/x=expr/>` | a `const` in the component body |
| `<define/R\|p\|>` | a nested function component |
| `<try>` | `__mxErrorBoundary` / `__mxPlaceholder` (the exported `MxErrorBoundary` / `MxPlaceholder`) |
| `import`, `static`, `export` | hoisted to module scope verbatim |
| `<${expr}>` (dynamic tag) | `__mxDynamic(expr, props)` — JSX's static tag position can't take the expression directly |
| `<return>` | `{ value, output }`; a unit importing a hook is rejected instead |

Element-versus-component follows **Marko's** rule, not JSX's: a tag resolves to
a component when a binding or taglib entry says so, whatever its case. A
`tags/`-discovered `<badge/>` is a component call, not a literal `<badge>`
element; the host binds it under a generated name in the emitted JSX.

## Errors

Marko's stateful tags are compile errors naming the Preact equivalent: `<let>` points at `useState`, `<effect>` at `useEffect`, `<lifecycle>` and `<script>` at the hooks that replace them, `<id>` at `useId`, `:=` at passing a value plus an explicit handler. A `client` block is an error too — this host's output *is* the client.

So is anything else this target cannot express — `<await>`, `<!doctype html>` (it belongs to the HTML shell that mounts the app), a raw `$!{…}` placeholder with siblings (the prop replaces the whole subtree), a non-object `style=`, and `class:active` (not Marko syntax — see [Errors](/language/errors/)). `<return>` and a dynamic tag with a body both compile — see the table above. Nothing else degrades silently.

## Verification

`bun run oracle:preact` compiles every fixture in the stock `.marko` set — the same 43 `oracle:marko` uses — renders it with `preact-render-to-string`, and compares against the fixture's own `expected.html`, which was generated from real Marko. **30 pass, 13 skipped (each naming the construct), 0 bugs.** `examples/preact-app` carries the end-to-end proof that the result is a *live* component: a real browser clicking a real button and seeing the count change.

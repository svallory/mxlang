# `@mxlang/hono`

MX's Hono host compiles a `.mx` template to a Hono JSX component
module: TSX with `/** @jsxImportSource hono/jsx */`, the author's imports and
`static` blocks at module scope, and `export interface Input` as the component
props type.

Project [custom tags](../../../apps/docs/docs/custom-tags/index.md) are
discovered and expanded before Hono emission, so they share one definition
with every other host.

## Why it shares the Preact emitter

Hono's JSX makes the same structural lowering choices as Preact and React:
`<if>` is a ternary, `<for>` is `.map()` with a `key`, ordinary children are
JSX children, and attribute tags are props. `@mxlang/hono` therefore depends on
`@mxlang/preact` and passes a Hono `Target` to its exported emitter instead of
forking it. The target owns only vocabulary: JSX import source, native `class`
(Hono, like Preact, accepts it directly — no `className`), the raw-HTML prop,
the Fragment module, and the error-boundary module. Structural changes remain
one implementation and one test surface.

Two knobs on the shared `Target` exist *because of* Hono, not Preact or React:
`errorBoundaryFallbackProp` (Hono's built-in `ErrorBoundary` takes
`fallbackRender`, not `fallback`) and `errorBoundaryFallbackAlwaysFunction`
(that prop has no non-function form, so a param-less `<@catch>` is still
wrapped in `() => …`). Both default to Preact's/React's existing `fallback`
behavior, so neither target had to change.

Unlike Preact and React, this host ships **no hand-rolled error boundary
class**: Hono's `hono/jsx` provides `ErrorBoundary` and `Suspense` natively, so
`<try><@catch>`/`<@placeholder>` import straight from `hono/jsx` itself.
`src/runtime.ts` supplies only `mxClass` — the one helper Hono has no
equivalent for.

## Install

```jsonc
{
  "dependencies": {
    "@mxlang/hono": "workspace:*",
    "hono": "4.6.20"
  },
  "mx": { "host": "hono" }
}
```

For a Bun server rendering `.mx` files directly (no bundler), preload the Bun
loader:

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

The host field is shared by Vite, the language server, and `mx-tsc`. A project
with exactly one `@mxlang/*` host dependency may omit it.

## Lowering

| MX | Hono |
| --- | --- |
| text, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML={{ __html: expr }}` |
| `class="a"` | `class="a"` (native, unchanged) |
| `class={a: cond}` | `class={mxClass({ a: cond })}` |
| `<label for="id">` | `<label for="id">` (native, unchanged) |
| `style={color: c}` | `style={{ color: c }}` |
| `onClick() { go(); }` | `onClick={() => { go(); }}` |
| `<if=c>` / `<else>` | a ternary chain |
| `<for\|x\| of=xs by="id">` | `[...xs].map(x => <Fragment key={x.id}>…</Fragment>)` |
| `<Comp>children</Comp>` | JSX children |
| `<Comp\|item\|>…</Comp>` | a render-prop child |
| `<@name>body</@name>` | a named prop; repeated tags become an array |
| `<const/x=expr/>` | `const x = expr` in the component body |
| `<define/Row\|p\|>` | a local arrow returning JSX |
| `<try>` | `hono/jsx`'s `ErrorBoundary` (`fallbackRender`) and, with `<@placeholder>`, its `Suspense` |

Every `<for>` row gets a `key`, the same rule as Preact/React (see
`@mxlang/preact`'s README for the full `by=` semantics and the duplicate/object
key pitfalls).

Marko calls ordinary component children `content`, while JSX calls them
`children`. Emitted calls use `children` so hand-written Hono components work;
the generated component bridges that value back to `input.content`.

## State and `<try>`

Hono's `hono/jsx` exposes hook-style state (`useState`, `useEffect`, etc.) the
same way Preact/React do; use it from a top-level `<const>`:

```marko
import { useState } from "hono/jsx";

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>
<button onClick() { setCount(count + 1); }>${count}</button>
```

Marko's own stateful tags are compile errors with Hono guidance: `<let>`
points to `useState`, `<effect>` to `useEffect`, and `<id>` to `useId`.

`<try><@catch|error|>…</@catch></try>` lowers to:

```tsx
<ErrorBoundary fallbackRender={(error) => …}>
  <Risky />
</ErrorBoundary>
```

imported straight from `hono/jsx` — no `@mxlang/hono/runtime` import needed for
this. `<@placeholder>` lowers to `hono/jsx`'s `Suspense` the same way. Both are
Hono's own components; this host adds no wrapper around them.

`@mxlang/hono/runtime` exports only `mxClass`, the structured-class string
joiner — Hono has no built-in for it. A template using no structured `class`
imports no helper.

## Bun loader

`@mxlang/hono/bun` registers a Bun plugin loading `.mx` files as
`loader: "tsx"` — the same shape as `@mxlang/html/bun`'s Bun loader, but
`"tsx"` instead of `"ts"` since this host's compiled output contains JSX. Bun
honors the emitted `/** @jsxImportSource hono/jsx */` pragma per file, so no
bundler is required for a plain Bun server. A hand-written `.tsx` sibling
without its own pragma still needs the project's `tsconfig.json` to set
`jsxImportSource: "hono/jsx"` — see `examples/hono-app`.

## Verification

```sh
bunx vitest run --root ../../.. --project @mxlang/hono
bun run oracle:hono
cd examples/hono-app && bun run e2e
```

The oracle compiles all 45 stock Marko fixtures, renders through `hono/jsx`
(`String(jsx(Component, input))`, awaited when the tree contains a caught
error — Hono's `ErrorBoundary` resolves asynchronously), and compares with the
HTML host using semantic HTML normalization: **32 pass, 13 reasoned skips, 0
bugs** — identical to `oracle:preact` and `oracle:react`, since all three
targets share the emitter and the skip list.

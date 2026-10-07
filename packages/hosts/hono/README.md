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
`@mxlang/preact` and passes a Hono `JsxDialect` to its exported emitter instead of
forking it. The dialect object owns only vocabulary: JSX import source, native `class`
(Hono, like Preact, accepts it directly — no `className`), the raw-HTML prop,
the Fragment module, and the error-boundary module. Structural changes remain
one implementation and one test surface.

`<try><@catch>` lowers to `MxErrorBoundary` from `@mxlang/hono/runtime`, which wraps
`hono/jsx`'s async `ErrorBoundary` around the body (passed as a function, so a throw
written directly in the body is caught too); `<@placeholder>` lowers to `hono/jsx`'s
`Suspense`, re-exported from the same module. `src/runtime.ts` also supplies `mxClass`,
the one helper Hono has no equivalent for.

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
| `<try>` | `MxErrorBoundary` (around `hono/jsx`'s `ErrorBoundary`) and, with `<@placeholder>`, `hono/jsx`'s `Suspense` |

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
<MxErrorBoundary fallback={(error) => …}>{() => (<><Risky /></>)}</MxErrorBoundary>
```

`MxErrorBoundary` and `Suspense` both import from `@mxlang/hono/runtime`:
`MxErrorBoundary` wraps `hono/jsx`'s `ErrorBoundary`, and `Suspense` is
`hono/jsx`'s own, re-exported. The runtime also exports `mxClass`, the
structured-class string joiner; a template using no structured `class` imports
no `mxClass`.

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

The oracle compiles all 60 stock Marko fixtures, renders through `hono/jsx`
(`jsx(Component, input)` rendered and resolved the way `c.html()` does, since
Hono's `ErrorBoundary` resolves asynchronously), and compares with the
html target using semantic HTML normalization: **45 pass, 15 reasoned skips, 0
bugs** — identical to `oracle:preact` and `oracle:react`, since all three
dialects share the emitter and the skip list.

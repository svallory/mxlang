# hono — agent instructions

## `@mxlang/hono`: the Hono dialect on the shared JSX emitter

`packages/hosts/hono` (`@mxlang/hono`) depends on `@mxlang/preact` and passes
`honoDialect` to its exported emitter, the same shared-implementation shape as
`@mxlang/react`: native `class`/`for` (Hono, like Preact, accepts them
directly), `dangerouslySetInnerHTML` for raw HTML, and `<try>` lowers straight
to `hono/jsx`'s own **built-in** `ErrorBoundary`/`Suspense` — no hand-rolled
boundary class needed, unlike Preact/React, since Hono ships one.

Two `JsxDialect` knobs on `@mxlang/preact`'s shared emitter exist because of this
host: `errorBoundaryFallbackProp` (Hono's `ErrorBoundary` takes
`fallbackRender`, not `fallback`) and `errorBoundaryFallbackAlwaysFunction`
(that prop has no non-function form, so a param-less `<@catch>` is wrapped in
`() => …`). Both default to Preact's/React's existing `fallback` behavior — a
third knob, `mxClassModule`, lets `mxClass` import from this package's own
`runtime.ts` (`hono/jsx` has no `mxClass` equivalent) while `ErrorBoundary`/
`Suspense` still import from `hono/jsx` itself. `src/runtime.ts` exports only
`mxClass`. Host selection is `"mx": { "host": "hono" }` or a lone
`@mxlang/hono` dependency, through the same resolver used by Vite, the
language server and the TypeScript plugin.

Attribute tags share Preact's v2 `attrTagProps` emission (decisions 106–108):
data values carry `{ ...attrs, ...nestedProps, content }`, renderable values
are passed bare, arrays are real arrays, and control flow stays expression
shaped. This package exports `AttrTag<C>` specialised to Hono's `Child`, and
an ambient `AttrTag` reference in `.mx` emits a type-only import from
`@mxlang/hono`.
Untyped body-only props use decision 108's bare renderable fallback; one
attributed or nested occurrence makes the whole fallback property data.

`@mxlang/hono/bun` registers a Bun plugin loading `.mx` as
`loader: "tsx"` — the same shape as `@mxlang/html/bun`'s plugin, `"tsx"`
instead of `"ts"` since this host's compiled output contains JSX. Bun honors
the emitted `/** @jsxImportSource hono/jsx */` pragma per compiled file; a
hand-written `.tsx` sibling with no pragma of its own still needs the running
script's *own* project `tsconfig.json` (not a `--tsconfig-override` pointing
elsewhere) to set `jsxImportSource: "hono/jsx"`, or Bun's JSX transform
silently falls back to a different runtime for that one file — measured: it
broke Hono's `ErrorBoundary` for a non-throwing child with an opaque
`str.search is not a function` error, only when a sibling `ErrorBoundary` with
a *throwing* child was also present in the tree. See `examples/hono-app`'s
`dev`/`e2e` scripts, which run under the example's own `tsconfig.json`.

`bun run oracle:hono` renders the stock 45 fixtures through `hono/jsx`
(`String(jsx(Component, input))`, awaited when the tree contains a caught
error — `ErrorBoundary` resolves asynchronously once its child throws): **32
pass, 13 skipped(reason), 0 bugs**, identical to `oracle:preact`/
`oracle:react` since all three share the emitter and skip list. The live
`<try>`/`<for>` behavior is covered by `examples/hono-app`'s Playwright e2e
against a real Hono-on-Bun server.

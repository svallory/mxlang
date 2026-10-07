# hono — agent instructions

## `@mxlang/hono`: the Hono dialect on the shared JSX emitter

`packages/hosts/hono` (`@mxlang/hono`) depends on `@mxlang/preact` and passes
`honoDialect` to its exported emitter, the same shared-implementation shape as
`@mxlang/react`: native `class`/`for` (Hono, like Preact, accepts them
directly), `dangerouslySetInnerHTML` for raw HTML, and `<try>` lowers straight
to this package's `MxErrorBoundary` (`src/runtime.ts`), which wraps `hono/jsx`'s
built-in async `ErrorBoundary` around the body, and to `hono/jsx`'s `Suspense`
(re-exported from the same module, because the emitter imports both names from
`errorBoundaryModule`). The emitter hands the `<try>` body to the boundary as a thunk, so a throw
written directly in the body is evaluated as a child of `ErrorBoundary` and caught;
inline children would be evaluated by the parent before the boundary exists.
`src/runtime.ts` also exports `mxClass` (`hono/jsx` has none).
Host selection is `"mx": { "host": "hono" }` or a lone
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

`bun run oracle:hono` renders the stock 60 fixtures through `hono/jsx`, resolving
callbacks the way `c.html()` does (`resolveCallback` from `hono/utils/html`):
`ErrorBoundary` is async, so a nested boundary reaches its parent as a Promise and a
plain `toString` leaves streaming markers. The `try-*` fixtures run live. The live
`<try>`/`<for>` behavior is covered by `examples/hono-app`'s Playwright e2e
against a real Hono-on-Bun server.

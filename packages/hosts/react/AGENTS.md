# react — agent instructions

## `@mxlang/react`: the React dialect on the shared JSX emitter

`packages/hosts/react` (`@mxlang/react`, decision 81) depends on
`@mxlang/preact` and passes `reactDialect` to its exported emitter. This is a
deliberate shared implementation, not a compatibility layer: the structural
lowering is identical, while the dialect object changes the JSX import source,
`className`, `htmlFor`, Fragment module and runtime-helper module.

The runtime is native React. `src/runtime.ts` imports `Component` and
`Suspense` from `react`; `MxErrorBoundary` is a class using
`getDerivedStateFromError`/`componentDidCatch`, and `MxPlaceholder` wraps
React's own Suspense. Stateful Marko tags remain compile errors with React
hook guidance. Host selection is `"mx": { "host": "react" }` or a lone
`@mxlang/react` dependency, through the same resolver used by Vite, the
language server and the TypeScript plugin.

Attribute tags share Preact's v2 `attrTagProps` emission (decisions 106–108):
data values carry `{ ...attrs, ...nestedProps, content }`, renderable values
are passed bare, arrays are real arrays, and control flow stays expression
shaped. This package exports `AttrTag<C>` specialised to `ReactNode`, and an
ambient `AttrTag` reference in `.mx` emits a type-only import from
`@mxlang/react`.
Untyped body-only props use decision 108's bare renderable fallback; one
attributed or nested occurrence makes the whole fallback property data.

`bun run oracle:react` renders the stock 45 fixtures through
`react-dom/server`'s `renderToStaticMarkup`: **32 pass, 13 skipped(reason), 0
bugs**. React 19 automatically prepends image preload links during static
rendering; `react-render.ts` strips only those transport hints before the same
semantic HTML comparison. The live error-boundary and hook behavior is covered
by `examples/react-app`'s Chromium e2e.

**`.react.mx` region files (decision 154).** The descriptor's `react` file
kind (language id `reactmx`) routes each region to `compileReactRegion`, which
is `@mxlang/preact`'s `compileJsxRegion` with `reactDialect`,
`reactRegionDeclarations` and segment `react` (see `packages/hosts/preact/AGENTS.md`
for the engine). Region tests: `src/region.test.ts` (fixtures under
`src/fixtures/region/<name>/`: `input.react.mx`, `__golden__/output.txt`
regenerated with vitest `-u`, `expected.html`, optional `props.json` and sibling
`.mx` tags), `region-errors.test.ts`, `region-client.test.ts` (a live root;
it installs jsdom by hand after printing, because `@marko/compiler`'s module
resolution fails under a global `window`). `examples/react-region-app` is the
Vite + Playwright check.


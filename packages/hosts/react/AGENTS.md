# react — agent instructions

## `@mxlang/react`: the React target on the shared JSX emitter

`packages/hosts/react` (`@mxlang/react`, decision 81) depends on
`@mxlang/preact` and passes `reactTarget` to its exported emitter. This is a
deliberate shared implementation, not a compatibility layer: the structural
lowering is identical, while the target object changes the JSX import source,
`className`, `htmlFor`, Fragment module and runtime-helper module.

The runtime is native React. `src/runtime.ts` imports `Component` and
`Suspense` from `react`; `MxErrorBoundary` is a class using
`getDerivedStateFromError`/`componentDidCatch`, and `MxPlaceholder` wraps
React's own Suspense. Stateful Marko tags remain compile errors with React
hook guidance. Host selection is `"mx": { "host": "react" }` or a lone
`@mxlang/react` dependency, through the same resolver used by Vite, the
language server and the TypeScript plugin.

`bun run oracle:react` renders the stock 43 fixtures through
`react-dom/server`'s `renderToStaticMarkup`: **30 pass, 13 skipped(reason), 0
bugs**. React 19 automatically prepends image preload links during static
rendering; `react-render.ts` strips only those transport hints before the same
semantic HTML comparison. The live error-boundary and hook behavior is covered
by `examples/react-app`'s Chromium e2e.


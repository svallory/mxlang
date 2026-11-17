---
packages: [core, preact, html, solid, angular, astro]
kind: Changed
---
`key=` on a native element (`<div key=x/>`, also `key:=x` and `key(){}`) is now refused as stock Marko refuses it on html, Solid, Angular and Astro: `MX_INVALID_ATTRIBUTE`, `` `key` is not a valid attribute, did you mean `<for by>`? ``, at the attribute. On Preact, React and Hono it stays the JSX `key` prop, a recorded divergence (`divergences.md`). A host opts in through the new optional `HostDeclarations.acceptsReservedAttrNames` field, which the JSX hosts set to `["key"]`. Spread keys, a component's or dynamic tag's `key` input and other names (`key:x`, `Key`) are unaffected.

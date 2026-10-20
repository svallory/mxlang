---
packages: [typescript-plugin, preact, react, hono, html]
kind: Changed
---
The TypeScript plugin's mapping pass now looks tags up through the compile target's own translator instead of always html's: `createHtmlMappings` gained a public optional trailing `translator` parameter, `compileMxVirtual` passes the target descriptor's, and a target that defines none falls back to the default target's. The `preact-jsx`, `react-jsx` and `hono-jsx` target descriptors declare a lazy memoized `translator`; the registry's `defaultTag` scope and contract checks also resolve those targets' own translator now (equivalent tables, mappings unchanged for every existing target).

---
packages: [core, typescript-plugin, tsc, preact, react, hono, html]
kind: Fixed
---

Type-check projections check angle assertions (`<T>x`) as parenthesized `as`
assertions instead of erasing their containers or parsing them as JSX. Nested
assertions and binding defaults retain their authored diagnostic positions;
other TypeScript wrappers remain checked, including assertions on string
literals. Refusal checks inspect the value without removing checked assertions
or renderability guards from generated code. Wrapped string loop keys check
assertions without losing the row field's type. Repeated projected range-loop
expressions in the shared Preact emitter (also used by React and Hono),
including attribute-tag loops, retain their authored positions without duplicate
diagnostics. Module statements retain exact error positions, including html
server and client statements. Overlapping dialect rewrites safely erase angle
wrappers instead of leaving unparseable TSX. Preserved-type template lowering
recognizes functions and classes through checked TypeScript wrappers without
changing the public callable predicate or runtime module-binding routing.
An internal host compile mode confines these checks to projections; the IR
entry's `lowerSource({ stripTypes: false })` keeps its existing diagnostics,
IR and angle-container erasure rather than enabling projection behavior.
Default runtime compilation is unchanged, including wrapper-bearing JSX
regions, Solid units and regions, and Astro templates and frontmatter.

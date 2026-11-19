---
packages: [babel, tsx-bridge, solid, typescript-plugin]
kind: Added
---
A `<define>` in a `.solid.mx` region is mapped to its authored text: its params, the `/var`s in its body, every expression in its body and its `<return>` reach the source, so hover, go-to-definition and rename work inside the define and a TypeScript error in its body lands on the authored text. Its name maps for hover only; go-to-definition and rename from the name or from a call (`<Row/>`) reach no authored text. `HoistedDefine` (`@mxlang/babel`, `@mxlang/host-solid`) and `MxRegionHoistedDefine` (`@mxlang/tsx-bridge`) gain an optional `mappings` field, and `PrintResult` gains an optional `mappings` field: the hoisted defines' mappings rebased onto the printed module. The emitted region code and the printed module are unchanged.

---
packages: [preact, html]
kind: Fixed
---

A `.preact.mx`, `.react.mx` or `.hono.mx` region compile now returns the emitter's recorded `mappings` (`CompileJsxRegionResult.mappings`, generated offsets into `code`, source offsets file-absolute), so the parser bridge places a define's name, a direct call and a later read of a rewritten or repeated name without searching the emitted text; the emitted `code` is unchanged. On the JSX hosts a `$!{value}` sole child, a structured `class=[…]` beside a spread or passed to a called unit, a spread entry's attribute name, `<if>`/`<else-if>` conditions, `<for>` `of`/`in`/`from`/`to`/`step`, a function-form `by=` and attribute-tag `<if>`/`<for>` values are mapped to their authored text; on the html target `<if>`/`<else-if>` conditions and the `<for>` and attribute-tag loop sources are. In the type-check projection, a host-component call bound to an import with no attribute tags (`import { Card as C } from "./barrel"` then `<C title=1/>`) is written as the JSX element it renders, so a wrong prop is reported at the attribute as it is through a direct `.mx` import; build output is unchanged.

---
packages: [core, html, preact, solid, tsc, typescript-plugin]
kind: Fixed
---

A repeated attribute tag (a fold of several occurrences, or one under `<if>`/`<for>`) is now type-checked at each occurrence's own attributes when the callee declares the prop: `mx-tsc` and the TypeScript plugin report a wrong attribute, such as `<@item id="x"/>` where `id` is a number, at that attribute instead of at the tag name. Core adds a contextually typed builder, `__mxAttrTagsOf` (`ATTR_TAG_BUILD`), to `ATTR_TAG_RUNTIME`, and the html, Preact, React, Hono and Solid emitters build such a record with it; a fold no declared type reaches keeps `__mxAttrTags`. The runtime record is unchanged. Solid's generated loop names (`__mxRow0`, `__mxEntry1`, …) now come from a per-compile serial in the reserved `__mx` space instead of a scan of the authored names, so they no longer depend on what the template binds.

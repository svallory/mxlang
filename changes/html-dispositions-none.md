---
packages: [core, html, preact, react, hono, angular]
kind: Fixed
---
Under the `none` tag rules a host's refusal or inert row for a name that is not reserved no longer applies: such a name is an ordinary tag there, as the specification says. A `none`-dialect file's `<lifecycle>`, `<script>`, `<id>`, `<log>`, `<debug>` and `<await>` (and `<effect>`, `<let>`, `<client>` and `<server>` where a host has a row for them: html's strict policy, Preact, React, Hono and Angular) now compile as any ordinary tag does, instead of being dropped, refused for their attributes or body, or refused outright; on html `<script>` is an ordinary element. Rows for reserved names (`<else>`, `<try>`, `<define>`, …) still apply, and outside `none` nothing changes. Solid, Astro and the region entries (`.preact.mx`, `.react.mx`, `.ng.mx`) are unchanged.

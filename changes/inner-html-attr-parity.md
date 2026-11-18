---
packages: [core, html, preact, react, hono, solid, angular, astro]
kind: Changed
---
As in stock Marko, `dangerouslySetInnerHTML=` on a native element is now refused on Solid, Angular and `.astro.mx` templates: `MX_INVALID_ATTRIBUTE` at the attribute, `` `dangerouslySetInnerHTML` is not a valid attribute, did you mean `$!{html}`? ``. It is also refused on a dynamic tag whose name is a string literal with no placeholder (`<${"div"} dangerouslySetInnerHTML=x/>`) on every host. On html, Preact, React and Hono, which already refused it, the error now carries `MX_INVALID_ATTRIBUTE`. Spread keys and component inputs are unaffected.

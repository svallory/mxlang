---
packages: [core, solid, astro, preact, react, hono, angular]
kind: Fixed
---
A file routed to a dialect whose `tagRules` is `none`, compiled through Solid (`compileSolidMx`, `compileSolidUnit`), Astro (`lowerAstroMx`), a Preact, React or Hono region or an Angular `.ng.mx` region, now lowers with no native elements, as it does on `compileSource`: `<input><child/></input>` lowers there instead of being refused as `` The `<input>` tag cannot have content, so it does not support a body. `` (an Angular `.ng.mx` region still ends `<input>` at its open tag when the region is found, so there it remains an error), and `<${"div"}>` stays a dynamic tag instead of becoming a `<div>` element. Lowering adopts the preset's native elements along with its tag rules when the caller set none. MX's own files and files of a dialect stating another preset are unchanged.

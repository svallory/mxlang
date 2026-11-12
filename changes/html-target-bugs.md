---
packages: [html, preact, react, hono, solid, astro, angular]
kind: Fixed
---

The html target refuses `dangerouslySetInnerHTML` on a native element, as stock Marko and the other hosts do. `<html-style>` keeps its attributes and escapes its body for style context on the html target, and writes a real `<style>` on the Preact, React, Hono, Solid and Astro hosts instead of a literal `<html-style>` element. A `client` declaration no longer emits a `var` for a name the module already declares (`static function q(){}` beside `client export namespace q`, or two `client` statements naming one name). The region and unit entry points of the Preact, React, Hono, Solid, Astro and Angular hosts erase tag type arguments (`<p<string>>`) instead of refusing them.

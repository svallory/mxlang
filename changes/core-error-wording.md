---
packages: [core, target-registry, html, angular, astro, hono, preact, react, solid, tsc, language-server, typescript-plugin, vite-plugin]
kind: Changed
---

User-visible error texts no longer cite an internal decision number, and core's examples name no real dialect. Each keeps its code, severity and position; only the text changes.

| Where it surfaces | Old text | New text |
| --- | --- | --- |
| A scriptlet (`$ statement`) in a template, on every target | `` scriptlets (`$ statement`) are not supported in MX (decision 54) `` | `` scriptlets (`$ statement`) are not supported in MX `` |
| `mx.target: "data"` (`unknown-target`) | `"data" is reserved for the evaluated tree target (decision 187); a consumer that reads the tree calls lowerSource from @mxlang/core` | `"data" is reserved for a future evaluated target; a consumer that reads the tree calls lowerSource from @mxlang/core` |
| A descriptor with `builtOn: "data"` when `data` is not registered (`built-on-unknown`) | the same `(decision 187)` parenthetical after `"data" is reserved for the evaluated tree target` | the same sentence without it, now reading `reserved for a future evaluated target` |
| A third-party host's file kind whose segment is not the host's name (`target-invalid-descriptor`) | `` file kind segment "x" is not the host's name "h"; the segment before `.mx` is a host name (decision 136) `` | `` file kind segment "x" is not the host's name "h"; the segment before `.mx` is a host name, so set the segment to "h" `` |
| A scriptlet that declares nothing (`$ foo()`, an assignment, an import), on every target | `` scriptlets (`$ statement`) are not supported in MX `` | `` scriptlets (`$ statement`) are not supported in MX; a template holds values, not statements: write a value with `<const/x=…/>`, or move the statement out of the template `` |
| An `.astro.mx` file under the Astro pages directory (`@mxlang/host-astro`) | `` … under the pages directory (`.astro.mx` is for components and layouts, decision 134): `` | `` … under the pages directory (`.astro.mx` is for components and layouts, not pages): `` |
| A `<for>` range with a non-literal bound in an Angular template (`@mxlang/host-angular`) | `…and MX ships no runtime (decision 79). Compute the array…` | `…and MX ships no runtime. Compute the array…` |
| A bad dialect manifest (`mx.dialect` in a package's `package.json`) or `mx.extensions` entry | the example extension `` `.mesh.mx` ``, `` `.component.mesh.mx` ``, the example id `` `mesh` `` and `` { ".mesh.mx": "mesh" } `` | the same messages with `` `.mydsl.mx` ``, `` `.component.mydsl.mx` ``, `` `mydsl` `` and `` { ".mydsl.mx": "mydsl" } `` |

The scriptlet hint that follows the sentence for a `$ const`, `$ let` or `$ var` declaration (`; declare a value with `<let/x=…/>``, or a host's own replacement) is unchanged; where a host has no immutable replacement for a `let` or `var`, the sentence still ends there. A language packaged on core that passes `productName` still sees its own name where the text says MX.

For such a language, the messages that told the author to write `tags/<name>.mx` or to convert a `.marko` file to `.mx` now end `Import it explicitly.` / `Convert it to a file <name> compiles.`, because its tag-file extension is its own. MX's own wording is unchanged.

Consumers that match on the code (`unknown-target`, `built-on-unknown`, `target-invalid-descriptor`) or on the position are unaffected. A golden file or a test that pins one of the old texts needs to be regenerated.

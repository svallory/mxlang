# Angular oracle fixtures

Each `<name>/` holds one fixture kind — never more than one, and the runner
(`packages/oracle/src/report-angular.ts`) classifies a directory by which
file is present:

- **pass** — `input.mx` + `expected.html` (byte-compared to the emitted
  template), plus, for a fixture whose A1 row is a **W**arning,
  `expected.warnings.txt` (one warning per line, in emission order,
  byte-compared; a pass fixture with no such file asserts zero warnings).
  Every pass fixture is additionally checked against the real
  `@angular/compiler@22.1.7`: `parseTemplate(emitted, name).errors === null`
  and a span-stripped AST snapshot in `__golden__/<name>.ast.json`
  (regenerated with `--update`).
- **error** — `input.mx` + `expected.error.txt` (the exact `TranslateError`
  message A2 pins, with `compile()`'s absolute-path prefix stripped
  deterministically — see `stripPathPrefix` in the runner).
- **tag** — `input.mx` + `expected.ts` (task 1.7): the tag file compiles
  through `compileTagModule` and the emitted **component module** is
  byte-compared, then the `template:` string inside it is extracted and put
  through the same `parseTemplate` gate a pass fixture's template gets. A
  third kind rather than a variant of *pass*, because a `.mx` compiles to one
  of two very different artifacts on this host (A3's "two output kinds").
- **ngmx** — `input.ng.mx` + either `expected.ts` or `expected.error.txt`
  (phase 2): a whole TypeScript module whose `@Component` template is MX.
  The emitted module is byte-compared, its `template:` literal extracted and
  put through `parseTemplate`, and the module itself typechecked with the
  same real `tsc` pass a **tag** fixture gets. The `.ng.mx` extension is its
  own discriminator, so this kind needs no name-prefix convention (unlike
  **tag**'s `tag-`); the `ngmx-` names are for reading the table, not for
  routing.

  Its `template:` is a **backtick** literal, not a double-quoted string
  (decision 99, reversing A4 divergence 3), so `templateOf` carries two
  patterns and unescapes ``\` ``, `\${` and `\\` — the inverse of the
  host's own `escapeTemplateLiteral`. `ngmx-escapes` is the fixture that
  pins all three.

  An **ngmx error** fixture covers one rejected region position each
  (C3/A4 divergence 2): wrong property, one object too deep, a ternary, a
  non-`Component` decorator, a plain call with no decorator, and a region in
  the decorator's *second* argument — the last being the case only
  `argumentIndex` can distinguish.

Two staging details, both load-bearing rather than incidental:

- A **tag** fixture is compiled under its *own* basename, taken from the
  fixture directory with the `tag-` prefix dropped (`tag-named-slot/`
  compiles as `named-slot.mx`). A tag's selector and exported class are both
  derived from its filename, so compiling as `input.mx` would name every
  fixture's component `Input` — colliding with the `export interface Input`
  it also emits.
- A fixture with its own `tags/` directory is copied to a temp directory
  first, because tag discovery walks *upward* from the compiled file. The
  staged directory gets a `package.json` so the scan stops there, and the
  staged path is stripped back out of the warning text, which would otherwise
  carry this machine's temp directory into the golden.

## Rows intentionally absent here

None. The two A1 rows this file used to list as absent — a tag's own
`<content>` and a named slot in a tag file — now have fixtures
(`tag-content`, `tag-named-slot`), along with the rest of task 1.7's surface:
inputs (`tag-inputs`), the selector override (`tag-selector-override`),
module-level statements (`tag-static-import`), and a page calling a
discovered tag (`page-calls-discovered-tag`).

## `for-in` iteration order

`for-in/expected.html` asserts the emitted `| keyvalue: null` text, which is
what makes the order question moot rather than something this oracle checks
at runtime: `KeyValuePipe`'s sort is guarded by a truthiness check on its
`compareFn` argument, and `null` is falsy, so passing it skips the sort
entirely and the pipe returns pairs in the object's own insertion order — the
same order every other MX host's `<for in=>` produces. This was measured
against `@angular/common@22.1.7`'s installed source (both the type
declaration and the runtime differ implementation) in the design note's "`<for
in=>` iteration order: parity, measured" section, not re-derived here — a
fixture comparing an object literal's *emitted key order* would only restate
that JS object key order is stable, not that Angular's own pipe preserves it,
which is the actual claim being relied on.

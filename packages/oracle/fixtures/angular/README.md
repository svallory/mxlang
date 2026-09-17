# Angular oracle fixtures

Each `<name>/` holds one of two fixture kinds — never both, and the runner
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

## Rows intentionally absent here

Two A1 rows have no fixture in this directory, on purpose — both are **tag
file** (task 1.7) constructs, not page-template constructs, and this oracle
covers the page-template emitter (`emitTemplate`) only:

- **a tag's own `<content>`** (`${input.content()}` → `<ng-content></ng-content>`)
- **a named slot in a tag file** (`${input.header()}` → `<ng-content select="[header]"></ng-content>`)

Both require compiling a `tags/*.mx` file through the tag-unit path (design
note "Custom tags: a `.mx` tag file becomes an Angular component") rather
than a bare page template, which this fixture set has no harness for yet.
They belong with task 1.7's own fixtures when that emitter lands.

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

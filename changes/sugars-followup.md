---
packages: [core, parser]
kind: Fixed
---

Follow-ups to the atoms-and-sugars syntax module (PR 460) from Mesh's review
of it. `parseData`'s option shape is unchanged. Two additions are visible to
a syntax module such as Mesh's: `TriggerMethod.async` and the
`"async-method"` value of `TriggerContext.valueForm` (with the new exported
type `TriggerValueForm`).

- core, parser: `async` before a method-valued attribute trigger
  (`kind async :name(p) { b }`) reaches the hook as a method with
  `async: true` and `ctx.valueForm` `"async-method"`. The trigger's text and
  span are its own token, never `async`, and the method value's span starts at
  its `(` or `<`; before, the method's text included the trigger. A
  `ctx.fail` with no position points at the trigger. `async` with no method
  after it is still a plain boolean attribute.
- core: `@mxlang/core/syntax/atoms-sugars` and `@mxlang/core/syntax/mesh`
  refuse an async `:name` method at the `:name`, naming the form. Core's
  built-in sugar keeps alpha.14's behavior (`async` is an attribute).
- core: the two reference modules' messages no longer quote MX decision
  numbers. `syntax/member` refuses a value after an attribute member
  (`&dueOn=1`, `&dueOn(x) { … }`) as "`&dueOn` is a member reference and takes
  no value". That refusal is reported at the member, not at the value (it
  was at the value before: column 12 for `sort asc &a=1`, now column 9),
  because a hook gets no span for a method or argument value. Core's
  generic error for a trigger value the hook drops now reads "`<text>` takes no `=value` here: the `<id>` trigger does not place
  it", at the value, and no longer names `lowerTrigger`.
- data: `DataDiagnostic.file` is set only when the diagnostic is in another
  file than the one parsed, on the built-in and the module path alike. A
  warning in the parsed file (a duplicate attribute) no longer carries its
  own path.
- core: Mesh's entity files and docs blocks are checked in as a golden parse
  corpus (`src/fixtures/syntax/mesh-corpus/`, MIT, attributed) and parsed by
  `packages/targets/data/src/mesh-corpus.test.ts` through `syntax/mesh`.
- The lifetime of the two reference modules is documented: exported,
  `@unstable`, through the beta; Mesh vendors them at the alpha.15 pin.
- `bun run test:sugar-module` exits 2 with a "not built" message when a
  needed `dist` is missing, and writes its report under
  `node_modules/.cache/sugar-module/` instead of the system temp directory.

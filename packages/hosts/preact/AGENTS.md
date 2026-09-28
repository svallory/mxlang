# preact — agent instructions

## `@mxlang/preact`: the Preact host on `@mxlang/core`

`packages/hosts/preact` (`@mxlang/preact`, decisions 71, 79, 81, 82) is the
fourth emitter over the core IR, and the first whose target has **no
control-flow components at all**: every structural kind lowers to a plain JSX
*expression*. `packages/hosts/preact/README.md` carries the full lowering
table, the `key` rule, the error list and the `<try>` helper; this is the
package-map entry.

Selected by `package.json`'s `"mx": { "host": "preact" }` (or a lone
`@mxlang/preact` dependency) through `@mxlang/core`'s `resolveHostPolicy` —
the same resolver the Vite plugin, the language server and `mx-tsc` share, so
an editor, a `tsc` run and a build cannot disagree about a `.mx` file.

Six facts worth knowing before editing it:

- **Marko's `content` and JSX's `children` are the same slot under two
  names.** The emitter passes a component's ordinary children the JSX way (so
  a hand-written Preact component is callable from MX) and the emitted
  component bridges the names in its first line, so a template's own
  `${input.content}` still reads them. Without the bridge
  `<Card><p/></Card>` compiled cleanly and rendered an empty card — the S8
  silent-drop class, found by `oracle:preact` rather than by a unit test.
- **Element-vs-component follows Marko's rule, not JSX's.** JSX decides by
  case, so a `tags/`-discovered `<badge/>` emitted verbatim became a literal
  `<badge>` element with the props as attributes. The declarations use the
  taglib lookup and in-scope bindings (the same rule as `@mxlang/html`), and
  `componentAlias` renames such a component in the emitted JSX, binding
  `MxBadge` beside it.
- **Attribute tags emit from core's `attrTagProps` plan** (decisions 106–108),
  never by regrouping the flat occurrence list. `data` values are
  `{ ...attrs, ...nestedProps, content }`; `renderable` values are the body;
  repeated values are real arrays; conditionals are ternaries and loops use
  `.flatMap`. On Preact, `content` is `ComponentChildren` and is a render
  function when params are declared.
  Untyped body-only props therefore arrive bare under decision 108; one
  attributed or nested occurrence makes the whole fallback property data.
- **A declared attribute-tag value carries its type at the call site.** A
  singular value is emitted as `(value satisfies
  NonNullable<Parameters<typeof Callee>[0]["name"]>)`, as arrays already
  were, so `mx-tsc` and the tsserver plugin check a wrong or missing
  attribute against the callee's `AttrTag`. An undeclared property is emitted
  bare. The object's `{` is mapped to the tag name and each key and value to
  its authored span, which is what places those diagnostics.
- **`warnings` collects non-fatal diagnostics.** `compilePreactMx` (and the
  React and Hono wrappers over it) take an optional `warnings` array that
  core fills; tooling reports it, a build may ignore it.
- **Every `<for>` row carries a `key`**, defaulting to the row's own identity
  when `by=` is absent (the item for `of`, the property name for `in`, the
  loop value for a range). Documented as this host's rule rather than left
  implicit; for a list of objects an author wants `by="id"`.
- **`<try>` needs a shipped runtime**, because Preact has no built-in error
  boundary component — only the `componentDidCatch` hook, and
  `preact/compat`'s `Suspense` catches thrown *promises* rather than errors.
  `src/runtime.ts` exports `MxErrorBoundary` (a class, the only form Preact
  gives that hook), `MxPlaceholder` (`Suspense` under one name) and
  `mxClass`. This does not contradict decision 82: it is Preact code an author
  would otherwise write by hand, not an MX runtime, and a template that uses
  none of it imports none of it.
- **Preact-only vocabulary lives in `src/target.ts`.** The JSX import source,
  `class` versus `className`, the raw-HTML prop and the boundary module are a
  `Target` object so a React package can reuse this emitter. A knob that would
  need an `if (target.kind === "react")` in the emitter does not belong there.

`bun run oracle:preact` (`packages/oracle/src/report-preact.ts` +
`preact-render.ts`) compiles every fixture in the stock `.marko` set — the
same 45 `oracle:marko` uses — renders it with `preact-render-to-string`, and
compares against `expected.html`: **32 pass, 13 skipped(reason), 0 bugs**. It
passes `htmlEquals`'s new `attributeOrder: "ignore"` option, since Preact owns
its serializer and emits props in its own order; `oracle:marko` keeps the
strict default, where attribute order is real output. Like `oracle:marko` it
is a CI job rather than part of `verify` — one heavy process at a time.

**The virtual script kind is TSX for every host** (`mx-language.ts`), not just
this one: a Preact component's body is JSX, and parsed as plain TS its
`return (<>…)` is a syntax error that surfaced as the module appearing to have
no exports ("File '…/Counter.mx' is not a module"). TSX is a superset for the
other hosts' JSX-free output, whose one narrowing (`<T>x` as a type assertion)
none of them emits.

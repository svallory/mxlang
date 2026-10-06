# preact — agent instructions

## `@mxlang/preact`: the Preact host on `@mxlang/core`

`packages/hosts/preact` (`@mxlang/preact`, decisions 71, 79, 81, 82) is the
fourth emitter over the core IR, and the first whose target has **no
control-flow components at all**: every structural kind lowers to a plain JSX
*expression*. `packages/hosts/preact/README.md` carries the full lowering
table, the `key` rule, the error list and the `<try>` helper; this is the
package-map entry.

Selected by `package.json`'s `"mx": { "host": "preact" }` (or a lone
`@mxlang/preact` dependency) through `@mxlang/core`'s `resolveTargetPolicy` —
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
  **A capitalized tag resolves only when it genuinely resolves** (decision
  114 parity, `unresolved-tag-jsx-astro-angular`): `isComponent`
  (`emitter.ts`) used to fall back to a bare `isComponentName` (`/^[A-Z]/`)
  test whenever the taglib lookup found nothing, so `<TotallyUndefined/>` —
  no import, binding, or taglib entry — silently emitted a JSX reference to
  nothing (a runtime `ReferenceError`, not a compile error). The fallback is
  now `false`, and `rejectUnknownTag` reports Marko's own wording
  ("Unable to find entry point for custom tag `<Name>`.") through the same
  `lower.ts` hook `@mxlang/html`/`@mxlang/solid` already use. `@mxlang/react`
  and `@mxlang/hono` share this fix through `createJsxDeclarations`.
- **Attribute tags emit from core's `attrTagProps` plan** (decisions 106–108),
  never by regrouping the flat occurrence list. `data` values are
  `{ ...attrs, ...nestedProps, content }`; `renderable` values are the body;
  repeated values are real arrays; conditionals are ternaries and loops use
  `.flatMap`. On Preact, `content` is `ComponentChildren` and is a render
  function when params are declared.
  Untyped body-only props therefore arrive bare under decision 108; one
  attributed or nested occurrence makes the whole fallback property data.
- **A declared attribute-tag value carries its type at the call site.** Each
  concrete singular occurrence is emitted as `((value) satisfies
  NonNullable<Parameters<typeof Callee>[0]["name"]>)`, as arrays already
  were typed, so `mx-tsc` and the tsserver plugin check a wrong or missing
  attribute against the callee's `AttrTag`. An undeclared property is emitted
  bare. The object's `{` is mapped to the tag name and each key and value to
  its authored span, which is what places those diagnostics.
  The inner parentheses are load-bearing: `satisfies` binds tighter than an
  arrow function and a conditional, so `(p) => x satisfies T` checks `x` and
  `test ? a : undefined satisfies T` checks `undefined`. That is also why
  the check sits on each occurrence inside a conditional plan, never around
  the plan, and why a bodiless renderable (`undefined`) carries none. A
  wrong value is reported twice: once by `satisfies` at the attribute, once
  by the JSX prop at the tag name.
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
- **`typeCheck` is a tooling-only mode (decision 140).** `compilePreactMx`
  (and the react/hono entries) take `typeCheck: true` only from
  `@mxlang/typescript-plugin`'s virtual code. It wraps every native element's
  event handler as `on…={(fn) satisfies Handler<"tag", "event">}` (`emitter.ts`, the
  `event` case; custom elements, dynamic tags and components are not wrapped)
  and adds a *types-only* preamble (`index.ts`, `handlerTypePreamble`; `satisfies` and types are erased by `mx-tsc`'s emit, so no helper value may ever exist — it would throw at run time) that finds the
  host's own handler type by case-insensitive key lookup on
  `JSX.IntrinsicElements`, `any` on no hit. Its identifiers are allocated against the template source (`handlerTypeNames`) so a user binding can never collide. It also sets core's
  `stripTypes: false` so shorthand handlers keep their annotations. The
  wrapper exists to give TypeScript a contextual type and a *mapped* place to
  report on (the recomposed prop name is deliberately unmapped); never emit it
  for a build — `type-check.test.ts` asserts the unset output has no `__mx`.

- **Preact-only vocabulary lives in `src/dialect.ts`.** The JSX import source,
  `class` versus `className`, the raw-HTML prop and the boundary module are a
  `JsxDialect` object so a React package can reuse this emitter. A knob that would
  need an `if (dialect.kind === "react")` in the emitter does not belong there.

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

**The shared JSX region engine (`src/region.ts`, decision 154).**
`compileJsxRegion` compiles one region of a `.<segment>.mx` TSX module for a
dialect; `@mxlang/react` wraps it (`compileReactRegion`) and this package wraps
it for `.preact.mx` (`src/region-compile.ts`: `compilePreactRegion`, Preact's
dialect, `preactRegionDeclarations`, segment `preact`; the descriptor's `preact`
file kind, language id `preactmx`, requires it lazily). The Hono region kind is
meant to be the same thin wrapper. Region tests: `src/region*.test.ts` over
`src/fixtures/region/<name>/` (goldens regenerated with vitest `-u`; they render
through `preact-render-to-string`; `style` prints before `class` because
`preact/compat`, loaded by `src/runtime.ts`, re-inserts `class` after normalising
it, so a bare Preact render would print `class` first. The golden is correct). Facts before editing:

- The markup is the whole-file emitter's (`createRegionEmitter`, a
  `PreactEmitter` with a region sink); only the module assembly differs.
  Runtime imports, synthesized tag imports and `tags/*.marko` aliases go back
  as `hoistedImports`, the attribute helpers and `__mxDynamic` as fixed-binding
  `hoistedDefines` (the bridge declares identical ones once per module).
- A bridge-found region is **one root element** (a TSX `<>…</>` is not a
  region: each child element is its own region), so `<if>`/`<else>` siblings
  and a `<define>` with its callers sit inside one element. The region emitter
  therefore lifts a `<define>` met outside a callback (the component body's own
  JS scope) instead of refusing it, and the region code becomes
  `<>{(() => { <defines> <var statements> return (<>…</>); })()}</>` so they
  still close over the surrounding component's `useState` values. Always a
  fragment: a bare call or `{…}` in JSX-child position prints as text.
- `<const>` is refused in a region (a hook there could be conditional), and
  module-level MX (`import`/`static`/`export`/`Input`/`<return>`) is reachable
  only through a direct call of the hook; both are positioned at the statement.
- Region declarations come from `createJsxDeclarations(name, { region: true })`:
  reactive-tag errors name only the hook in the surrounding component.
- `src/callee-reader.ts` (`readJsxCalleeInput`) is the JSX hosts' one callee
  reader and this package's only `@mxlang/parser` import; keep it there.
  Core finds it through the compile's lookup (`readersFor` in
  `core/src/callee-input.ts`: registered readers, then the lookup's file
  kinds), so a direct region compile under the host's own lookup reads
  `.<segment>.mx` callees with nothing registered at import.
- Lifted `<define>`s share one arrow, so a repeated name is Marko's
  `Duplicate declaration "Row"` at the second name. Region-only refusals name
  the file kind; core's "not supported in …" texts use `Ctx.unsupportedIn`,
  which the engine sets (unset keeps "a standalone template").


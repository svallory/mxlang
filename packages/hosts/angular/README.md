# @mxlang/angular

**Preview.** This host is not yet a complete "Angular host" by decision
70's own bar (a host is not done without its TypeScript plugin; that part
of step 2 is still open). Two file kinds compile today:

- **step 1** — an MX (`.mx`) page template compiles to a plain Angular
  template string, and `mx-angular build`/`watch`/`map` write it beside a
  hand-written `x.component.ts` whose `templateUrl` points at it.
- **step 2** — a `.ng.mx` file is an ordinary TypeScript module whose
  `@Component` template is MX; `compileNgMx` emits `<basename>.ts` beside
  it, and because this host owns that module it maintains the decorator's
  own `imports:` array rather than warning you to. See "`.ng.mx`" below.

See `notes/investigations/angular-host-design.md` for the full design.

MX (Markup eXtended) is a template language born from Marko: it takes
Marko's syntax and brings it to wherever JSX lives today, MX 1.0 being a
strict subset of Marko so every borrowed Marko tool keeps working. `.mx` is
MX's only extension.

`@mxlang/angular` compiles an MX (`.mx`) page template to a plain Angular
template string — no runtime and no `@angular/*` code in the compiled
output. `@angular/compiler` (`>=22.0.0 <23.0.0`) is an optional peer
dependency, resolved from your project and never bundled: the emitter reads
Angular's DOM schema from it to choose `[name]` or `[attr.name]` for a
dynamic attribute on a native element, and a template that needs it while it
is missing fails with a positioned error naming the package. The test suite
also asserts every golden against the real compiler's `parseTemplate`.

```ts
import { compile } from "@mxlang/angular";

const { code, warnings } = compile(source, "app.component.mx");
```

```marko
// app.component.mx
<div class={active: isOn}>
  <for|p| of=people by=(p => p.id)>${p.name}</for>
</div>
```

```html
<!-- emitted app.component.html -->
<div [ngClass]="{active: isOn}">
  @for (p of people; track p.id) { {{ p.name }} }
</div>
```

## Shipped in this package (tasks 1.1–1.3)

- The package skeleton and `HostDeclarations` (structural half).
- `Text`/`Interpolation`/`Element`/`Comment`/`DocumentType`/`IfChain`/`Const`.
- `For` (`of`/`in`/`range`), `Define` and its call, `Component` (all three
  `ComponentTarget` kinds), attribute-tag content projection.

Attribute tags use core's v2 plan. A singular `<@name>` emits
`ngProjectAs="[name]"`; mutually exclusive conditional occurrences emit under
Angular `@if`/`@else if`/`@else`. Arrays, attributes, params, and nested tags
are positioned errors because a projection is keyed by selector and carries
nodes only. `as: "data"` and `as: "renderable"` therefore project identically.
The exported `AttrTag<C>` is a compile-time marker (`never`): the generated
component gets `<ng-content>`, not an `@Input()` value, and projected
properties are omitted from the generated class. A callee renders projected
content with `${input.x()}`, `${input.x.content()}`,
`<${input.x.content}/>` or, for a renderable declaration, `<${input.x}/>`;
optional-chain forms work too. Any other read of `input.x` is a positioned
error with that render fix-it. A bodiless `<@name/>` is rejected because it
has no nodes to project.

## `mx-angular` (task 1.5a: `build`/`map`; task 1.5b: `watch`)

Reads `package.json#mx.angular` (`include`, `pageExtension`, `tagExtension`,
`tagSelectorPrefix`, `onError` — see the design note's A3 for defaults) and
compiles `include` ∪ the discovered tag index (a `.mx` under any `tags/`
directory, or a `package.json#mx.tags` entry — `@mxlang/core`'s own
discovery, not a naming convention). A page compiles to `pageExtension`
beside its source with a generated-header comment and a `.html.map`
sidecar; `mx-angular map <file.html:line:col>` reads that sidecar and prints
the `.mx` position, both 1-based (the sidecar's own coordinates are 0-based
and converted at the CLI boundary). Writes only when bytes differ, and
refuses to overwrite a `tagExtension` output that doesn't carry the
generated header. See
`apps/docs/docs/hosts/angular.md` for the full CLI reference.

`mx-angular watch` (`src/watch.ts`, `startWatch()`) runs the initial build,
then watches `include` ∪ every discovered `tags/` directory ∪
`package.json` with `fs.watch` (one non-recursive watcher per directory,
portable rather than relying on macOS/Windows-only recursive support),
debounced 50ms. A changed page recompiles only that page. A changed tag
recompiles its dependents, tracked per page from the tag names its own last
compile recorded in the IR (`usedTags`), plus — since a sidecar `transform`
may return IR directly as a macro with no `Component` node and therefore no
entry in `usedTags` — a text-scan fallback over every tag name discovered in
scope, so a macro-only dependency is still tracked (a deliberate
over-approximation: a spurious rebuild is harmless, a missed one silently
serves stale output). `package.json`, or a `.mx` file appearing/disappearing
outside the routed set, triggers a full rebuild, since either can change
routing. `onLine` reports one line per write/skip/error, in `build`'s own
`file:line:col message` shape. `startWatch()` returns a handle
(`{ close(), onIdle }`); `close()` stops every watcher, and `onIdle` (a
quiet-window poll, not a fixed sleep) resolves once the watcher has settled
after the caller's own last observed change — the shape the CLI's `Ctrl-C`
(`SIGINT`/`SIGTERM`, exit 0) and `--once` (initial build only, then exit —
CI and tests) both build on.

## `.ng.mx`

`compileNgMx(source, filename, options)` compiles a module whose
`@Component` template is an MX region:

```ts
@Component({
  selector: "app-x",
  template: <ul><for|p| of=people by=(p => p.id)><li>${p.name}</li></for></ul>,
})
export class XComponent { people = []; }
```

**Tooling limitation:** the Angular worker reads tags from disk: save the tag, then recheck the caller.

Five things are worth knowing before editing `src/ng-mx.ts`:

- **A region is legal in exactly one position** — the direct value of
  `template:` in `@Component({ … })`'s *first* argument, enforced through
  the parser's generic `mxRegionPositionCheck` (C3). All four
  `MxRegionContext` fields are checked and none implies another:
  `isDirectPropertyValue` carries no decorator-adjacency guarantee, and
  `argumentIndex` is the only one that tells `@Component({ template })`
  from `@Component(opts, { template })`.
- **`<>…</>` is a fragment region** (`mxRegionFragment: true` in the `parse`
  call; off by default in the parser, so `.solid.mx` keeps TSX `<>`). The
  parser hands `lowerRegion` the fragment's *children* with `fragment: true`;
  they are wrapped in `<f>…</f>` before `parseFragment` (Marko reads a leading
  word as a concise-mode tag, and the wrapper forces HTML mode) with the base
  offset and column moved back three so every position lands on the author's
  file, then lowered as siblings. The region's `start`/`end` widen to cover the
  `<>` and `</>`, or the overwrite would leave them in the module (the G9 leak).
  Two bare roots are the parser's `MultipleRoots` error, not a lowering.
- **The template is a backtick literal**, with `` ` ``, `${` and `\`
  escaped (decision 99, reversing the design note's A4 divergence 3). The
  reversal is a mapping decision, not a taste one: the spike measured that
  a double-quoted emit hands back Angular diagnostics in *escaped*
  coordinates, forcing an escape-aware inverse hop at every newline in
  every template, while a backtick emit is 1:1.
- **This host owns the surrounding module**, so it appends each used MX tag
  and each needed Angular directive to `imports:` *and* emits their
  `import` statements — the one AST edit no other host performs (A4
  divergence 5). The emitter's "add X to the component's imports" warnings
  are filtered out on this path, since repeating them would tell an author
  to redo an edit MX just made.
  A `standalone: false` component is the exception: Angular rejects
  `imports:` on it, so no `imports:` or `import` is written and a positioned
  warning names what the declaring NgModule must provide instead.
- **Authored `import`/`static`/`export` go in the module, not the region.**
  A region is TypeScript *expression* position, where those are statement
  syntax, so the vendored Babel rejects them before MX sees the file — a
  measured limit, pinned by three rejection tests, and the reason A4
  divergence 4 was amended. Only a *synthesized* discovered-tag import
  hoists, through `MxRegionCompileResult.hoistedImports`.

`.ng.mx` files are discovered project-wide (any `**/*.ng.mx` inside the
project boundary), not through `include` — the same treatment the tag index
gets, and for the same reason: the emitted module is what Angular compiles,
so a narrowed `include` must not be able to drop one without saying so.

`result.mappings` is identifier-level and empty today (the emitter builds
text with no `mapped(...)` call anywhere); task 2.2b fills it through
core's `Expr.span`, and a test asserts the empty array so that cannot
change silently.

## Stateful tags

Marko's stateful tags — `<let>`, `<effect>`, `<lifecycle>`, `<script>`,
`<log>`, `<debug>`, `client` and `server` blocks, `<id>`, and `<await>` —
are each a compile error naming the tag and the Angular equivalent to write
instead in the component class (`signal`/`WritableSignal`, `effect()`,
`ngOnInit`, `@defer`, etc; spec §11, §13.3). Left undeclared, each of these
names would fall through the emitter's bare-case test and render as a
literal lowercase element instead — the same silent-wrong-render bug this
error table closes.

## Event handlers and `@mxlang/angular/runtime`

A template that binds an element event calls two members on its component,
`__mxOn` and `__mxOnAt` (decision 117). `.ng.mx` and tag modules get them
written in. A page's own class either pastes the text the build prints, or
extends the zero-import runtime subpath, which carries the same members
(public, `@internal`):

```ts
import { MxHandlers, MxHandlersMixin } from "@mxlang/angular/runtime";

export class FormComponent extends MxHandlers {}
export class ListComponent extends MxHandlersMixin(PagedBase) {}
```

If application code imports `@mxlang/angular/runtime`, list `@mxlang/angular`
under `dependencies`, not `devDependencies`: `npm ci --omit=dev` would leave a
production build without it. Its own runtime dependencies (see `package.json`) are
installed too, not bundled. Extend `MxHandlers` / `MxHandlersMixin` directly:
`.ng.mx` injects the members into an indirect base, and TypeScript then reports
a conflict. Pasting the members needs no dependency.

## Not yet in this package

- The tooling integration for `.ng.mx` (typescript-plugin, language-server,
  vite-plugin) — attempting to compile through those tools today reports
  the host as not wired in yet, rather than silently falling back to the
  vanilla html target.

## Warnings

Every diagnostic position `build` and `watch` print (their `file:line:column` prefixes, and the positions quoted inside messages) is 1-based, the basis `mx-tsc` prints (`file(line,column)`), so both surfaces point at the same character. `mx-angular map <file.html:line:col>` follows the same rule: it takes and prints 1-based columns (the sidecar's own coordinates are 0-based, converted at the CLI boundary), and rejects a `0` column rather than silently reinterpreting it. The structured `line`/`column` on `CompileResult.warnings`, `errors` and `TranslateError` are 0-based as well; only the printed diagnostic text is 1-based.

`compile()`'s `warnings` array collects positioned, non-fatal diagnostics —
a construct that compiles but diverges from an exact Angular equivalent, or
needs an import the watcher (not this package) cannot add for the caller.
One warning per file per category (not per occurrence): `[ngClass]`/
`[ngStyle]` usage, `<for in=>`'s `keyvalue` pipe, a trackless `<for>`, a
`$!{…}` raw interpolation, `[ngComponentOutlet]` usage, and the full list of
MX tags a template calls (with the exact `import`/`imports:` lines to add,
since step 1 cannot edit the caller's TypeScript file itself).

Literal Angular syntax in a template (`{{ x }}`, `@if (x) {`, `@for`, `@else`,
`@switch`, …) is plain text to Marko, so it renders literally. Each occurrence
gets a positioned warning at the `{{` or `@` with a one-line MX hint (`${x}`,
`<if=x>`, `<for|i| of=xs>`). Attribute values, `${…}` placeholders, comments,
`<script>`/`<style>`/`<html-script>`/`<html-style>` and prose (`user@host`, lone braces, `Ping me @if (now)
only`) don't warn: an `@` keyword warns only before real block syntax (`(…) {`,
a bare `{`, or `@let name = …;`). Each message names the literal escape
(`${"{{"}`, `${"@"}if`). Text in `<pre>`/`<code>`/`<textarea>` still warns,
because Angular interpolates there too. It covers `.mx` pages and tags the
Angular host compiles as well as `.ng.mx` regions. An mx-only lint (decision
126), unlike the per-category warnings above it fires once per occurrence.

The "binds an event handler" warning (the `__mxOn`/`__mxOnAt` invoker) is the
exception to "the build cannot see your class": `build`/`watch` read the page's
sibling `<name>.ts` and stay silent when each `@Component` class there extends
`MxHandlers`, extends `MxHandlersMixin(Base)`, or declares both members (a
same-file base counts). If one member is missing the warning names the class,
the file and the member. If the file is absent, unparsable, has no
`@Component` class, or the class extends a base imported from another module,
the warning stays unchanged (it only says "missing" when the whole `extends` chain was visible in the file; a mixin chain is followed through its first argument only, and a `declare class` base is unseen; a property with no initializer, a setter-only accessor, `declare`, `static` and `abstract` members do not count): `compile()` on its own always warns.

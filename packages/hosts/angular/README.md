# @mxlang/angular

**Preview.** This host is not yet a complete "Angular host" by decision
70's own bar (a host is not done without its TypeScript plugin — that is
step 2, `.ng.mx`, not built yet). What exists today is step 1: an MX
(`.mx`) page template compiles to a plain Angular template string, and
`mx-angular build`/`watch`/`map` write it beside a hand-written
`x.component.ts` whose `templateUrl` points at it. See
`notes/investigations/angular-host-design.md` for the full design.

MX (Markup eXtended) is a template language born from Marko: it takes
Marko's syntax and brings it to wherever JSX lives today, MX 1.0 being a
strict subset of Marko so every borrowed Marko tool keeps working. `.mx` is
MX's only extension.

`@mxlang/angular` compiles an MX (`.mx`) page template to a plain Angular
template string — no runtime, no `@angular/*` dependency in the compiled
output or in this package's own `dependencies` (`@angular/compiler` is a
devDependency of the test suite only, which asserts every golden against
the real compiler's `parseTemplate`).

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

## `mx-angular` (task 1.5a: `build`/`map`; task 1.5b: `watch`)

Reads `package.json#mx.angular` (`include`, `pageExtension`, `tagExtension`,
`tagSelectorPrefix`, `onError` — see the design note's A3 for defaults) and
compiles `include` ∪ the discovered tag index (a `.mx` under any `tags/`
directory, or a `package.json#mx.tags` entry — `@mxlang/core`'s own
discovery, not a naming convention). A page compiles to `pageExtension`
beside its source with a generated-header comment and a `.html.map`
sidecar; `mx-angular map <file.html:line:col>` reads that sidecar and prints
the `.mx` position. Writes only when bytes differ, and refuses to overwrite
a `tagExtension` output that doesn't carry the generated header. See
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

## Not yet in this package

- Tag-file compilation (a `.mx` in `tags/` becoming a real
  `@Component`-decorated `.ts` module — task 1.7). Until it lands, a
  discovered tag file reports a positioned error from `mx-angular build`/
  `watch` rather than emitting a plain template where a component belongs,
  and calling a discovered *template* tag from a page still hits the
  step-1 import problem (A3) on this host.
- The oracle fixture harness (task 1.4).
- `.ng.mx` / step 2 and its tooling integration (typescript-plugin,
  language-server, vite-plugin) — attempting to compile a `.mx` file
  through those tools today reports the host as not wired in yet, rather
  than silently falling back to the vanilla HTML host.

## Warnings

`compile()`'s `warnings` array collects positioned, non-fatal diagnostics —
a construct that compiles but diverges from an exact Angular equivalent, or
needs an import the watcher (not this package) cannot add for the caller.
One warning per file per category (not per occurrence): `[ngClass]`/
`[ngStyle]` usage, `<for in=>`'s `keyvalue` pipe, a trackless `<for>`, a
`$!{…}` raw interpolation, `[ngComponentOutlet]` usage, and the full list of
MX tags a template calls (with the exact `import`/`imports:` lines to add,
since step 1 cannot edit the caller's TypeScript file itself).

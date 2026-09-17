# @mxlang/angular

**Preview.** This host is not yet a complete "Angular host" by decision
70's own bar (a host is not done without its TypeScript plugin — that is
step 2, `.ng.mx`, not built yet). What exists today is step 1: an MX
(`.mx`) page template compiles to a plain Angular template string, for a
watcher (not yet built — task 1.5) to write beside a hand-written
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

## Not yet in this package

- Tag-file compilation (a `.mx` in `tags/` becoming a real
  `@Component`-decorated `.ts` module — task 1.7).
- The `mx-angular` watcher CLI (task 1.5) and the oracle fixture harness
  (task 1.4).
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

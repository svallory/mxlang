# Changelog

## Unreleased

- **Fix (audit-02-for-by-parity):** `<for by=x.id>` (any read of a loop param in `by=`) is now a positioned error, as in Marko 6.3.51, instead of passing silently (the bare `by=p.id` form already failed, at the loop; it now fails at the name). See `@mxlang/core`.

- **Unchanged (audit-01-prop-attr-parity):** `[prop]=`, `#ref`, `*ngIf` keep passing through; the host sets `acceptsForeignAttrNames` to opt out of core's new Marko attribute-name check. Pinned by `test/attr-name-passthrough.test.ts`.

### Fixed

- **A structural attribute after another attribute now fails with a message that names the cause** (`angular-ngif-attr-hint`): `<div class="a" *ngIf="x">` used to report `Invalid left-hand side in assignment expression.` at the value `"a"`. It now reports a positioned error at the `*` saying that after `class=…` Marko reads `*ngIf` as a multiplication, and naming the fixes: make it the first attribute, or use `<if=cond>…</if>` / `<for|item| of=items>…</for>`. Applies to `.mx` pages, tag modules and `.ng.mx` regions, for any `*name=` (not only `ng*`). The parse is unchanged (still Marko's), so `a=b *c`, `a=(b * c)` and a first-position `*ngIf` compile as before, and every other parse error keeps its message. Known gaps, which keep Marko's message: a word operator (`in`, `instanceof`, `typeof`) between the value and the directive, and a directive with no `=` (Marko's multiplication, which compiles).
- **Typecheck no longer needs a prebuilt `@mxlang/core` / `@mxlang/parser` dist** (`angular-dist-before-typecheck`): `tsconfig.json` maps the workspace deps to their src through `paths` (the parser to its hand-written `src/public.d.ts`, as vite-plugin does) with `rootDir: ../../..`, so `tsc --noEmit`, `moon run angular:typecheck` and the per-edit hook pass on a fresh worktree and see src-only export changes; before, a fresh worktree failed with a misleading TS2307 and a stale dist gave false results. `tsconfig.build.json` clears `paths`, and the `bun build` steps pass `--tsconfig-override tsconfig.build.json` (bun build honors `paths`, which would bundle `public.d.ts`). Published `types` still point at dist; exports unchanged. Bun 1.4.2 prints a harmless `Internal error: directory mismatch` line for `--tsconfig-override`.
- **The tarball no longer ships `.d.ts.map` files** (pkg-types-g10): `tsconfig.build.json` sets `declarationMap: false` (each map pointed at a `../src/*.ts` that is not published) and excludes `src/**/fixtures/**`. `scripts/pack-hygiene.test.ts` pins the tarball contents and the declared bare specifiers; `scripts/pack-probe.ts` typechecks the packed package with `skipLibCheck: false`.

### Added

- **Literal Angular syntax in a template warns** (audit item 7, decision 126): `{{ x }}`, `@if (x) {`, `@else`, `@for (…) {`, `@switch` and the other `@` block openers written as text in a `.mx` page, tag or `.ng.mx` region now give a positioned warning at the `{{`/`@` with a one-line hint to the MX form (`${x}`, `<if=x>`, `<for|i| of=xs>`). Marko treats them as plain text, so this is an mx-only lint beyond Marko (`divergences.md`). It stays silent in attribute values, `${…}` placeholders, comments, `<script>`/`<style>`/`<html-script>`/`<html-style>` bodies, lone braces and prose `@` (`user@host`, `Ping me @if (now) only`; an `@` keyword warns only before real block syntax), and each message names the literal escape (`${"{{"}`, `${"@"}if`). Angular host only; core is unchanged.

- **A page's invoker warning now reads the page's class** (`angular-invoker-warning-false-positive`): `build`/`watch` inspect the page's sibling `<name>.ts` (a light Babel parse, never a type-check) and drop the `binds an event handler` warning and the header's paste advice when every `@Component` class in it provides `__mxOn` and `__mxOnAt`: by `extends MxHandlers` (including an aliased or namespace import of `@mxlang/angular/runtime`), by `extends MxHandlersMixin(Base)`, by declaring both members, or by extending a same-file base that does (a mixin chain such as `Other(MxHandlersMixin(Base))` counts). `declare`, `static`, `abstract`, bodiless and `!`-only members, and `import type`, do not count. When a class has only one member, the advice shrinks to the missing one; the warning names the class, its file and what it lacks. No file, an unparsable file, no `@Component` class, or a base the file cannot show (imported, a `const B = class …`, a wrapper with no runtime inside) keeps the original warning text with no "missing" claim, unless the class declares both members itself. `templateUrl` is not matched: all `@Component` classes in the file are judged. `compile()` alone, with no file system, still warns.

- **`NgMxRegion.generatedStart` / `generatedEnd`** (optional tooling-facing fields): the `[start, end)` span of each region's template literal in the emitted module, `CompileNgMxResult.code`. Diagnostics tooling uses it to find the region an emitted-module offset falls in when no mapping covers that offset. Additive.

- **`mx.angular.diagnostics` config key** (`"idle"` | `"save"` | `"off"`, default `"idle"`), read by `readAngularConfig` and exported as the `AngularDiagnosticsMode` type. `"off"` disables Angular template diagnostics for `.ng.mx` everywhere (`mx-tsc` and editors); `"idle"` and `"save"` are editor scheduling modes (after 1 s idle / on save) that `mx-tsc` treats as on. Any other value throws a positioned error.

- **A mapping invariant test over every `.ng.mx` mapping** (`test/ng-mx-mapping-invariant.test.ts`): each mapping `compileNgMx` returns must slice the source to the text its generated run un-escapes to, or be a `derive`-tagged run the oracle's `isDerivedFrom` accepts. It runs over every oracle `.ng.mx` fixture and a set of attribute shapes.

- **Two aliases of one authored `.mx` tag import no longer leave an unused
  import in `.ng.mx`.** With `import Chip from "./tags/badge.mx"` and
  `import Pill from "./tags/badge.mx"` both used as tags, the class is listed
  once in `imports:` (`[Chip]`) and the second alias's import is dropped, since
  nothing references it (TS6133 under `noUnusedLocals`). An alias the author's
  own TypeScript still reads, or that another component in the file lists, is
  kept. The emitted module is checked with a real TypeScript program under
  `noUnusedLocals`, for the single- and two-alias cases.
- **`.ng.mx` fragment regions: `<>…</>` lowers to sibling nodes** (TODO
  `angular-ngmx-multi-root`, LiUNA gap G9, decision 120). A `@Component`
  template can now have several roots: `template: <><ng-content/><b>hi</b></>`
  emits `` `<ng-content></ng-content><b>hi</b>` `` with no wrapper element or
  comment node. `<></>` emits an empty template, `<>text</>` text. Before, a
  fragment was left in the emitted `.ts` as raw MX (invalid TypeScript, no
  diagnostic). Two bare roots stay an error, now one that names the rule and
  suggests `<>`. A fragment inside a fragment (also inside an element child) is
  a positioned error. A fragment anywhere but the `template:` root, such as
  `x = <></>` or `f(<>a</>)` in the class body, is now an error naming that rule
  instead of raw `<>` in the emitted `.ts`.
- **Round 2 of the authored `.mx` import in `.ng.mx`.** An aliased import now
  emits one import (`import { Badge as Chip } from "./tags/badge"`) and lists the
  author's local in `imports:` (`imports: [Chip]`), deduped against a discovered
  use of the same class. Errors, all positioned at the import: a mixed
  `import A, { b } from "./x.mx"` used as a tag (must be a sole default import),
  a `.marko` default import used as a tag, and an unresolvable path. A `.mx`
  default import never used as a tag is left byte-for-byte. A module-scope
  binding used as a tag (`const Local = 1; <Local/>`) now lowers to
  `ngComponentOutlet` (decision 116) instead of the unresolved-tag error.
- **An authored `.mx` default import now works as a tag in a `.ng.mx` region**
  (`import Badge from "./tags/badge.mx"` … `<Badge/>`), inside or outside
  `tags/`, aliased or not. It used to fail with Marko's "Unable to find entry
  point for custom tag" because `lowerRegion` never seeded the lowering context
  from the module's bindings. It now emits what the discovered spelling of the
  same callee emits: the callee's selector (its exported override, else
  `<prefix><kebab(basename)>`), one `imports:` entry even alongside `<badge/>`,
  and the authored `.mx` line rewritten to the generated module's named class
  import (`import { Badge as Chip } from "./tags/badge"` when aliased). An
  unresolvable path is a positioned error. A plain `.mx` page keeps its
  by-design authored-import error.
- **`readAngularConfig`, `AngularConfig` and `OnError` are exported from
  `@mxlang/angular`.** Tooling-facing API so editor tooling reads
  `package.json#mx.angular` exactly as the build does. It throws on an
  unknown key or a wrongly typed value rather than defaulting. Not reachable
  from `@mxlang/angular/runtime`.
- **`@mxlang/angular/runtime`: the event invoker as a base class and a mixin.**
  A zero-import, browser-safe subpath exporting `MxHandlers` (a base class) and
  `MxHandlersMixin(Base)` (for a component that already extends a class), both
  carrying the `__mxOn` / `__mxOnAt` members a generated template calls, with
  the same semantics as the injected ones. The members are public, marked
  `@internal`, so a mixin stays emittable under `declaration: true`. `.ng.mx`
  skips injecting them when the class extends either, through a named, aliased
  or namespace import or a base declared in the same file. The page header and
  the once-per-file warning now name both options (paste the members, or extend
  the runtime). App code importing the subpath needs `@mxlang/angular` in
  `dependencies`, not `devDependencies`; see the Angular host docs.
- **A `standalone: false` `.ng.mx` component no longer gets an injected
  `imports:`.** Angular rejects `imports` on a non-standalone component, so
  `compileNgMx` now leaves such a decorator alone (and skips the matching
  `@angular/common` / tag `import` statements) and instead emits a positioned
  warning naming each symbol, with its module, that the declaring NgModule
  must provide (`NgClass` from `@angular/common`, a called MX tag component
  from its emitted module). `standalone: true` or an absent flag behaves as
  before. The warning names the component class and literal selector; a
  quoted key and `as const` / `satisfies` / `!` around the literal are
  recognised, and any other non-literal `standalone` value keeps the
  standalone behaviour but warns (positioned) that it cannot be determined.

- **Event handlers type-check for any arity under `strictTemplates` and
  receive exactly Marko's `(event, element)`** (`angular-event-handler-arity`,
  decision 117): `onClick=cancel` with a 0-arg `cancel()` emitted
  `(click)="(cancel)($event)"`, which is TS2554, though Marko 6.3.51 accepts it.
  The template now calls a typed invoker on the component,
  `(click)="__mxOn(cancel, this, $event)"` (`svc.cancel` emits
  `__mxOnAt(svc, 'cancel', $event)`, evaluating the object once). Its return
  value reaches Angular, so `false` still calls `preventDefault()`; a handler for
  the wrong event type still fails; no `$any`. `.ng.mx` and tag modules write the
  invoker members into the class; a page's hand-written class gets a
  once-per-file warning with the text to paste. `.ng.mx` decides per class, from
  the AST, which members are missing (own or inherited from a base class visible
  in the file). A falsy handler (`cond && fn`, `null`, `undefined`, `false`) is a
  no-op, as in Marko's `handler?.(event, target)`. Divergences from Marko, in
  `divergences.md`: `this` is the component (Marko: the element), and the element
  is `$event.currentTarget` typed `EventTarget | null`.

- **A call site honors a tag's exported `selector`.** `tags/badge.mx` with
  `export const selector = "liuna-badge"` is now emitted as
  `<liuna-badge></liuna-badge>` where it is called (discovered tag or authored
  `.mx` import), instead of `<mx-badge>`; a tag without an override keeps
  `<prefix><kebab(basename)>`. The `tag-module-selector` mapping kind is now
  `resolved-selector` and carries the exact selector as `deriveContext`, so the
  oracle check is `generated === deriveContext` (no hyphen heuristic: a
  hyphenless `tagSelectorPrefix` or override is accepted, a wrong string is not).

- Attribute-tag IR v2 support for singular `ngProjectAs` projections,
  including mutually exclusive `<if>`/`<else if>`/`<else>` branches and the
  Angular `AttrTag<C>` projection marker with automatic type imports.

### Fixed

- **`.ng.mx` attribute-name mappings pointed into the wrong text.** A region padded its `Ctx` source differently from `parseFragment`'s contract (and from `.solid.mx`), so the source span of a first-line attribute name (`class`, `id`, `title`, ...) resolved to unrelated text earlier in the file (`class` mapped to the `from ` of the import line). `compileNgMx` now pads with the same formula as the Solid host (`positionRegionSource`). Expression mappings were never affected.

### Changed

- **An unresolved capitalized tag is a compile error, matching Marko
  6.3.51** (decision 114, extended to Angular): `<TotallyUndefined/>` — no
  import, `<define>`, local binding, or taglib entry — now fails with
  Marko's own "Unable to find entry point for custom tag
  `<TotallyUndefined>`.", routed through the same core `rejectUnknownTag`
  check every other Marko-parity host uses. Previously it emitted
  `<mx-totally-undefined>` plus the step-1 import warning, presenting a tag
  nothing resolves as one import away from working. `isComponent` now
  routes a capitalized tag only when a file-local binding or a non-element
  taglib entry resolves it; the step-1 used-tag import warning is unchanged
  for resolved tags. A capitalized tag bound to a value import that is not a
  `.mx` default import, or to a local whose value cannot be statically
  proven (a `<for>` tag param), lowers dynamically (decision 116) and emits
  `ngComponentOutlet`, the same lowering an authored `<${expr}/>` already
  had.
- Projected `AttrTag` properties are no longer emitted as `@Input()` class
  fields, even when unused: Angular supplies projected nodes through
  `<ng-content>`, not as values. Direct calls, `.content()` calls, dynamic
  `.content` tags, renderable dynamic tags, and their optional-chain forms
  lower to that projection; all other value reads are positioned errors.
  Arrays, attributes, params, nested tags, and bodiless tags remain positioned
  host errors.

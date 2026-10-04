# Changelog

- **Fix (marko-parity-trio, `:modifier`):** `<div :foo="y"/>` is accepted, as the attribute Marko renders literally. A **static** one is carried into the template verbatim (`value:foo="lit"`); a **dynamic** one emits `[attr.value:foo]`, not `[value:foo]`, because a colon-named property binding names a property no element has (NG8002) — the same rule a dynamic `data-*`/`aria-*` attribute already took. `class:`/`style:`/`attr:` are still rejected as not Marko syntax.

## Unreleased

- **Fix (angular-attr-interpolation-literal round 3, review L1):** the static `class`/`style` brace-binding check now matches the attribute name case-insensitively (HTML attribute names are case-insensitive): an authored `CLASS="{{ x }}"`/`STYLE=…` takes the `[attr.class]`/`[attr.style]` path too, emitted lowercase, instead of falling through to a static attribute Angular's styling pipeline drops.

- **Fix (angular-attr-interpolation-literal round 2, review F1–F3):** the static-value brace escaping no longer applies the text-only `@`-before-lowercase rule (`title="@handle"` and `mailto:me@example.com` rendered the literal text `&#64;…` — the entity was double-escaped by the HTML layer); `@` now passes through in attribute values, pinned by native Angular renders of `@` in `href`/`title`/a component input plus `&`, `"` and a literal `&#64;` round-tripping to Marko's raw value. A static `class`/`style` value holding braces is now a string-literal `[attr.class]`/`[attr.style]` binding instead of a mangled static attribute (Angular's class pipeline re-tokenizes `{{ '{' }}` literals to `x {{ }}`, and its style parser asserts on braces; a binding value parses as one expression with no interpolation splitting, so the raw braces render exactly — `'` and `\` are expression-escaped inside the literal).

- **Fix (angular-literal-hint-edge-cases round 2, review F4):** a `@let` value whose quotes are entity-encoded in the raw source span (`@let z = &#96;a;b&#96;;`) is no longer cut at the entity's own `;` — a quote-decoding entity is treated as the quote (same-entity pair skipped), and a lone entity-quote with no pair falls back to the `…` placeholder.

- **Fix (angular-attr-interpolation-literal):** a static attribute value holding `{{ … }}` (e.g. `title="{{ x }}"`) is no longer emitted verbatim into the Angular template, where Angular interpolated it. It now gets the same brace escaping as static text (`title="{{ '{' }}{{ '{' }} x {{ '}' }}{{ '}' }}"`), matching Marko's semantics — Marko 6.3.51 renders the literal text `{{ x }}` — proven by a native Angular TestBed render of the escaped attribute and text. The `{{ }}` literal-syntax warning on text is unchanged: it still tells an author who meant interpolation to write `${…}`.

- **Fix (angular-literal-hint-edge-cases):** the literal-syntax hint's string scanner no longer treats a backtick string as fully opaque — its `${…}` interpolations are code, so a pipe inside one now keeps the placeholder instead of inlining the piped expression (reachable through block conditions and `{{ }}` bodies; a literal `${…}` in text is a Marko placeholder before the hint ever runs). The `@let` value scan no longer ends at the first `;`: `;` or a quote inside a string value (`@let a = 'x;y' | f;`, `` @let z = `a;b`; ``) is skipped, so the value is inlined whole or replaced by `…` only when it truly holds a pipe.

- **Changed (`mx-angular map` 1-based input/output, ruling #227):** `mx-angular map <file.html:line:col>` now takes **and** prints 1-based line and column, the same basis `mx-tsc` prints (`file(line,column)`) and every editor uses, so both halves of the subcommand agree with every other position this tool prints. The sidecar's own coordinates stay 0-based and are converted at the CLI boundary; a `0` line or column is now rejected with `invalid position: line and column must be 1-based (at least 1)` and exit code 1 rather than being silently reinterpreted (a `0` used to mean "the first column", which is the 1st — one byte left of what an editor highlights). See `@mxlang/core`'s and the specification's §12 "One base for every printed position".

- **Fix (ng-mx-hoist-before-directive round 2):** detached headers after the directive prologue also stay before hoisted imports. A directive's trailing inline comment stays on its original statement, while the final attached declaration comment stays with its declaration. Template and later module positions remain mapped correctly.

- **Fix (ng-mx-hoist-before-directive):** without authored imports, `.ng.mx` hoisted imports now follow the leading directive prologue and detached header comments. Directives remain directives, attached declaration comments stay attached, and template/module diagnostic mappings retain their authored positions.

- **Fix (ng-ngfor-attr-column):** structural attribute mappings separate the `*` prefix from the directive name. NG8103 now points at `ngFor` (a25: line 5, column 22), and likewise at `ngIf`, without changing emitted template text or adjusting the printed column.

- **Fix (scriptlet-hint-let-var):** `$ let`/`$ var` no longer suggest an immutable `<const>` rewrite. Angular rejects `<let>`, so its host declaration omits keyword advice for mutable scriptlets; `$ const` advice is unchanged.

- **Fix (angular-build-unlocated-babel-suffix):** a tag file's parse error printed Babel's own 0-based `(L:C)` suffix (`Chip.mx error: …/Chip.mx: …/Chip.mx: Unexpected token (1:32)`) — the path twice, the column 0-based, and no usable position at all. The tag error path now goes through `positionOf` like the `.ng.mx` one: the position prints from `err.loc` as 1-based `file:line:column` (`Chip.mx:1:33`), Babel's path prefix and trailing 0-based suffix are stripped on every branch (located or not), so the README's "every printed position is 1-based" holds for these errors too. The log line and `errors[].message` are compact — `file:line:col error: reason` with the reason alone — while the on-page error template keeps the filename-bearing display message; `positionOf` is exported `@internal` for the position-hygiene regressions.

- **Fix (ng-mx-tags-call-ts991010 round 2):** virtual tag modules default to the same cached per-file custom-tag discovery as the build, preserving nested component imports. Readers reuse `scanCached` rather than walking the whole project on every compile/check. The reader API is marked tooling-only, unstable and `@internal`; the README now tells authors to save a changed tag and recheck its caller because Angular workers read disk.

- **Added (ng-mx-tags-call-ts991010):** `createVirtualTagModuleReader` presents discovered Angular tag templates as their existing `compileTagModule` output, at either the `.mx` source or generated `.ts` sibling path, without writing files. It respects the build's tag discovery, config and containment rules; handwritten TS siblings remain untouched. Build output is unchanged.

- **Fix (jsx-whitespace-body-parity, decision 141):** imported components and discovered `tags/*.mx` retain same-line whitespace-only bodies through core. The template emitter uses Angular's `&ngsp;` for a normalized lone-space text node so native whitespace removal cannot drop it. Newline indentation stays absent. Pinned by rendering generated components with Angular TestBed under its default whitespace policy.

- **Fix (angular-fix-hints round 3):** SVG `<switch>` control-flow cases are detected through structural IR wrappers (`<for>`, `<if>`, and nested element bodies), producing one MX error at the authored switch on both CLIs. Resolved components and genuine SVG graphics switches remain exempt. Parameter-mismatch advice now offers concrete code only for simple member chains, replacing just the leading parameter reference; complex bodies (including shorthand objects, nested arrows, and the reviewed `y?.y` shape) get a plain rename instruction instead of an unsafe AST rewrite. Applied member-chain fixes compile on both CLIs and preserve the emitted `track` expression.

- **Fix (angular-fix-hints, audit items 14/18):** `<switch=…>` now fails once at the authored tag name, before Angular sees its `<case>` children, with the shared unresolved-tag wording and the `<if=…>` / `<else if=…>` replacement. A real SVG `<switch>` remains valid. A `<for by=(y => …)>` whose arrow parameter differs from the row now names both parameters and points at the mismatched one; `by=identity` is offered for tracking the row itself. Every suggested replacement is compiled in regression tests; no generated output changes for valid templates.

- **Fix (angular-fix-hints round 2, review of audit items 14/18):** the `<switch>` control-flow rejection no longer depends on a default attribute: a `<switch>` outside `<svg>` (Angular's HTML template has no such element), or one with `<case>` children even inside `<svg>`, now fails once at the authored tag name on both `mx-tsc` and `mx-angular build`, before any descendants are traversed. A real `<svg><switch>` of graphics elements, a `tags/switch.mx` discovery and an imported `Switch` component are unchanged. The `by=` arrow-parameter hint now offers the faithful fix — rename the parameter, keeping the key expression (`by=(x => x.id)` for row `x`, with object keys, member properties and nested shadowing left alone) — and names `by=identity` only as a different strategy for rows without the field, or as the complete fix when the arrow tracks the parameter itself (`by=(y => y)`). Clean compilation of every applied fix is regression-tested, and the keyed fix's emitted `track` expression is asserted verbatim.

- **Changed (refactor/target-open-set, decision 137):** a dotted tag file name under `tags/` is excluded from the tag map with a positioned diagnostic. `discoverFiles` routes host-module pages by the lookup it is given, so `build`, `watch` and `discover` take an optional `targets` (default: this package's own descriptor). A caller that holds the built-in lookup (the oracle, a tool with the registry in hand) sees another host's file kind excluded with core's own host-module message, as before; with only this package's own descriptor, a foreign file kind is no longer recognised as a module file.
- **Changed (refactor/target-open-set, decisions 129 and 132):** `compile`, `compileNgMx` and `compileTagModule` accept `options.targets`, defaulting to this package's own descriptor (`angularOwnTargets`, now exported).

- **Fix (ng-mx-tag-import-in-decorator):** a hoisted tag import in a `.ng.mx` module was written inside the `@Component` decorator (`@Comp` / `import { UserCard } from "../tags/user-card";onent({`), giving `TS1206`/`TS2304` under `mx-tsc`. The cause was in `@mxlang/parser`, which spliced its synthesized imports into the AST with snippet-relative offsets that the host read as the last authored import; the parser now removes those locations (see `@mxlang/parser`). No host code change; output for existing files is unchanged.

- **Added (fix-hints-batch, audit item 14):** three hints from `@mxlang/core` reach `.ng.mx`, same message and position otherwise: a tag attribute with `=` and no value (`<div id= class="a">`) says to write `id="…"`/`id=expr` or drop the `=`; a syntax error in a `$` line says scriptlets are not supported and to declare a value with `<const/x=…/>` (compiles here); `<button (click)="go()">` outside the Angular syntax path says to write `onClick=go`. A lowercase tag never reaches the unresolved-tag path on this host, so the element did-you-mean does not apply.

- **Added, unstable (target-registry, decisions 129 and 132):** `./descriptor` subpath exports the `angular-template` target descriptor (host `angular`, `angularDeclarations`, file kind `ng` with language id `ngmx`, no `load`, `pending: "phase 2"`). Also built into `dist/descriptor.{js,d.ts}`. Nothing consumes it yet; see `@mxlang/target-registry`.

- **Fix (dup-attr-last-wins-core, decision 135):** a repeated attribute now emits only the last; `x`, `[x]`, `(x)` and `#x` stay distinct names. Before, both were emitted as authored. The earlier occurrence gets a positioned warning naming the surviving one. See `@mxlang/core`.

- **Fix (agent-output-positions, audit item 13):** `mx-angular build`/`watch` printed `file:line:column` with a 0-based column (`5:15`) where `mx-tsc` prints `(5,16)` for the same warning, so an agent landed one column left. Every printed diagnostic position (build, watch, CLI errors, and the two positions quoted in the slot/bare invoker-conflict message) now has a 1-based column. The structured `line`/`column` on `warnings`/`errors` and `TranslateError` are unchanged (0-based). One existing test pinned the old text (`watch.test.ts`, `x.solid.mx:1:0`) and was updated. `mx-angular map` takes and prints its own `file:line:col` unchanged. (Superseded for `mx-angular map` only, later in Unreleased: ruling #227 makes that subcommand 1-based in and out.)

- **Breaking (delegated-tag-rename, decision 132):** follows the `@mxlang/core` rename of `claimsTag`/`resolveHostTag`/`HostTag`/`ctx.build.hostTag` to `isDelegatedTag`/`resolveDelegatedTag`/`DelegatedTag`/`ctx.build.delegatedTag`; the host's `Emitter.hostTag` method is now `delegatedTag`. No output or diagnostic change.

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

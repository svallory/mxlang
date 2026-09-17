---
title: "Angular"
description: "The Angular host — a .mx page template compiles to a plain Angular template string, kept in sync by the mx-angular CLI."
---

# Angular

**Preview.** This host is not yet a complete "Angular host" by the same bar
every other host meets: its TypeScript plugin (step 2, `.ng.mx`) doesn't
exist yet, and until it does, a template's MX tag imports must be
hand-maintained in the caller's `.ts` file. What's here — page compilation,
the `mx-angular` CLI's `build`/`watch`/`map` — is real and tested, just not
the whole story.

`@mxlang/angular` compiles a `.mx` page template to a plain Angular template
string: no MX runtime, no Angular dependency in the compiled output. The
emitted string is exactly what a hand-written `x.component.ts` points its
`templateUrl` at — Angular itself never sees MX.

## Install

```bash
bun add -d @mxlang/angular
```

Configure the host and the `mx-angular` CLI in `package.json`:

```jsonc
{
  "mx": {
    "host": "angular",
    "angular": {
      "include": ["src/**/*.mx"],
      "pageExtension": ".html",      // default
      "tagExtension": ".ts",         // default
      "tagSelectorPrefix": "mx-",    // default
      "onError": "keep-last"         // default
    }
  }
}
```

Run `mx-angular build` before `ng serve`/`ng build` — Angular's own template
resolution needs the emitted `.html` file to already exist on disk, since
there is no in-memory hand-off between the two tools. For development, run
`mx-angular watch` alongside `ng serve`'s own watcher with `concurrently`
(a devDependency of your app, not of this host) — a plain `&` suffix
backgrounds the process but doesn't kill it when `ng serve` exits or is
`Ctrl-C`'d, orphaning it:

```jsonc
// package.json scripts
{
  "mx": "mx-angular watch",
  "start": "mx-angular build && concurrently -k -n mx,ng -c cyan,red \"mx-angular watch\" \"ng serve\"",
  "build": "mx-angular build && ng build"
}
```

The `mx-angular build &&` prefix guarantees the first pass has already run
before `ng serve` starts — Angular's own watcher, once started, does pick up
a template-only change and rebuild without touching the `.ts` file
(verified against a real `@angular/cli` app). `concurrently`'s `-k` kills
every process in the group when one exits, so `Ctrl-C` (or `ng serve`
crashing) stops `mx-angular watch` too, rather than leaving it running.

Emitted `.html` files (and, once tag files compile, emitted `.ts` component
modules) are **generated artifacts**: `.gitignore` them, and exclude the
`.mx` **sources** — never the emitted tag `.ts` modules — from
`tsconfig.json`'s `include`/`exclude` and from `angular.json`'s `assets`
array if the project copies `src/**` wholesale.

## The idea

A file on this host compiles to one of three outputs. The first two are
`.mx` files, told apart by **discovery, not naming convention** — the same
rule that decides whether a call resolves to a custom tag anywhere else in
MX; the third is its own extension:

| input | output | why |
|---|---|---|
| a page template — matched by `include`, not discovered as a tag | `x.component.html` | the body of a `templateUrl` a hand-written `x.component.ts` points at |
| a tag file — discovered under a `tags/` directory or `package.json#mx.tags` | an Angular component module | a component is a class plus a decorator; there is no template-only form |
| `x.component.ng.mx` | `x.component.ts` | one file holding both the class and its MX template — see [`.ng.mx`](#ngmx) |

`mx-angular` compiles `include` ∪ the discovered tag index, so a tag that
`include` doesn't match (the common case — a `tags/` directory usually sits
outside a narrowed `include`) is still emitted. A path both `include` and
the tag index claim is compiled once, as a tag, with a one-time warning.

## Lowering (summary)

The structural core lowers to Angular's block-syntax control flow (`@if`,
`@for`, `@let`), not the older `*ngIf`/`*ngFor` directives — see
`packages/hosts/angular/README.md` for the full table and a worked example.
A few of Angular's own idioms:

| Written | Lowers to |
|---|---|
| `${expr}` | `{{ expr }}` |
| `class={active: isOn}` | `[ngClass]="{active: isOn}"` |
| `<if>`/`<else if>`/`<else>` | `@if (...) { ... } @else if (...) { ... } @else { ... }` |
| `<for\|item\| of=items by=(item => item.id)>` | `@for (item of items; track item.id) { ... }` |
| `<for\|k, v\| in=obj>` | `@for (entry of (obj \| keyvalue: null); track entry.key) { @let k = entry.key; @let v = entry.value; ... }` |
| `<define>` | an `<ng-template>` with `let-` params |
| a component call | an Angular component element |
| a dynamic `data-*`/`aria-*` attribute | `[attr.data-x]`/`[attr.aria-x]` (no DOM property to bind) |
| every other dynamic attribute | `[x]` |

`<let>`, `<effect>`, `<lifecycle>`, `<script>`, `<log>`, `<debug>`, `<id>`,
`<await>`, `client`/`server` blocks and `:=` are compile errors — this host
has no reactive runtime of its own; that state belongs in the hand-written
component class.

`class:`/`style:`/`attr:` attribute modifiers are **not Marko syntax at all**
(decision 86) and are a compile error naming the replacement, the same as
every other MX host: write an object/array `class=`/`style=` value (already
lowers to `[ngClass]`/`[ngStyle]`), and write the attribute plainly
(`data-kind=x`, not `attr:data-kind=x`) — the emitter decides property vs.
attribute binding for you, per the row above.

## `mx-angular`

```
mx-angular build [--project <dir>] [--config <file>]           # one-shot; CI and prebuild
mx-angular watch [--project <dir>] [--config <file>] [--once]  # incremental
mx-angular map   <file.html:line:col>                           # emitted position -> .mx source file
```

**`build`** compiles every routed file. It writes an output only when its
compiled bytes differ from what's already on disk, and it refuses to
overwrite *any* output — page or tag — that doesn't carry the generated
header comment, so a hand-written file is never clobbered by a compile that
happens to share its output path. Every warning `compile()` produces (a
trackless `<for>`, `[ngClass]` usage, the step-1 "this template calls N MX
tag(s)..." note, and so on) prints to the terminal as `file:line:col
warning: ...`; a warning never fails the build.

**The header's second line** — `<!-- Add to x.component.ts: ... -->` — only
appears when the compiled template called at least one MX tag: it names the
`import`/`imports:` line to add for each one, since step 1 cannot edit the
caller's TypeScript for you.

**`watch`** runs the initial build, then recompiles incrementally on every
subsequent change. A changed page recompiles only that page; a changed tag
(a template `.mx` under `tags/`, or a sidecar `.tag.ts`) recompiles every
page that depends on it, tracked from each page's own last compile; a
`package.json` edit, or a new/deleted/moved `.mx` file, triggers a full
rebuild, since either can change routing itself. Changes are debounced 50ms
and coalesced, and a write happens only when the compiled bytes differ, so
an editor's own autosave doesn't retrigger Angular's watcher on a no-op
save. One line per write/skip/error prints to the terminal, in the same
`file:line:col message` shape as `build`. `Ctrl-C` exits `0`. `--once` runs
the initial build only and exits — for CI and tests, where an indefinitely
running watch process isn't wanted.

**`onError`** decides what a compile error does to a previous good output —
`keep-last` (default) leaves it in place and prints the error to the
terminal, except on a cold start (no previous output at all), where it
writes a visible error template so Angular reports the real problem instead
of "template not found." `error-template` always writes that error template,
even over a previous good output. `delete` removes the output entirely — the
right choice for CI, where a stale template silently shipping is worse than
a missing one.

**`map`** reads the sidecar written beside every emitted `.html` file and
prints the `.mx` source file it came from. `compile()`'s map has no real
per-position mappings yet (an acknowledged placeholder — this emitter builds
text directly rather than printing an AST), so `map` also prints a line
saying so rather than fabricating a line/column; once the emitter carries
real positions, this becomes a true line:col round trip. Angular itself
never reads the sidecar — it exists for `mx-angular map`, tooling, and any
future editor integration.

## Custom tags (preview)

A `.mx` file under a `tags/` directory, or a `package.json#mx.tags` entry,
is discovered the same way every MX host discovers one — including a
`mx.tags` entry's own `hosts` restriction: an entry declaring `"hosts":
["solid"]` is not claimed by `mx-angular` at all.

On this host a tag file compiles to a **standalone component module**
(`tags/badge.mx` → `tags/badge.ts`), not a template: an Angular
component is a class with a decorator, so there is no template-only form.

```marko
// tags/badge.mx
export interface Input { kind: "ok" | "warn" | "error"; label?: string }
<span class="badge" data-kind=input.kind>
  <if=input.label>${input.label}: </if>${input.content()}
</span>
```

```ts
// tags/badge.ts — generated
import { Component, Input as NgInput } from "@angular/core";

export interface Input { kind: "ok" | "warn" | "error"; label?: string }

@Component({
  selector: "mx-badge",
  standalone: true,
  imports: [],
  template: "<span class=\"badge\" [attr.data-kind]=\"kind\">@if (label) { {{ label }}:  }<ng-content></ng-content></span>",
})
export class Badge {
  @NgInput({ required: true }) kind!: "ok" | "warn" | "error";
  @NgInput() label?: string;
}
export default Badge;
```

The `@Input` decorator is imported under the alias `NgInput`: an
`export interface Input` — the tag-module contract's own name for the
props interface — would otherwise collide with `@angular/core`'s own
`Input` in the same module (`TS2440`).

What the emitted module does with each part:

- **Inputs** come from `export interface Input` — one `@Input()` per
  property, `required: true` when the property is not optional, and the
  TypeScript type copied verbatim. No `Input` interface means no inputs.
  A template reads an input by its **bare name** (`{{ kind }}`), because an
  Angular template resolves against the component instance.
- **No `@Output()` inference.** A function-typed property is a plain
  `@Input()`; a caller passes a callback as an ordinary dynamic attribute
  (`[onSelect]="handle"`), exactly as on every other MX host.
- **Content.** `${input.content()}` emits `<ng-content></ng-content>`;
  `${input.header()}` emits `<ng-content select="[header]"></ng-content>`.
  Reading the same attribute tag twice is an error — Angular matches each
  selector once, so the second projection would silently render empty.
- **Selector**: `mx-` plus the kebab-cased file basename
  (`tags/badge.mx` → `mx-badge`). The fixed prefix guarantees the hyphen
  Angular requires. Change it project-wide with
  `mx.angular.tagSelectorPrefix`, or per tag with
  `export const selector = "liuna-card";`, which wins over both.
- **`static` / `import`** stay in the tag's own module as ordinary
  module-level statements, and other `export`s pass through. An
  `import Child from "./child.mx"` is the exception: MX emits that import
  itself, pointing at the child's *generated* module, so the author's line
  is not passed through as well.

### What is an error

A template inside a tag component resolves against the component instance,
so MX rewrites `input.x` to the bare `x` — including `input?.x`,
`input["x"]` and `input.a.b`, and leaving alone any read where `input` is
shadowed (a `<for|input|>` param, a `<const/input=…>`, a function
parameter). Two cases have no correct rewrite and are reported rather than
rendered blank:

| Written | Why |
|---|---|
| `${input[k]}` | The property is not known until run time, so there is no class member to bind. |
| `${input.x}` where `x` is also `${input.x()}` | One read wants an `@Input()`, the other a projection; they cannot both hold. |
| `${input.header(1)}` | `<ng-content>` places nodes and cannot pass them values. |
| `<child header=input.header/>`, where `child` projects `header` | Angular cannot fill a projection from an attribute — nest a `<@header>` block instead. |

Passing an ordinary input through to a child (`<child label=input.label/>`)
is fine; only a name the child *projects* is refused.

### Calling a tag

A page that calls a discovered tag emits its element, and MX warns once per
file with the exact import and `imports:` entry the page's own TypeScript
needs — in step 1 MX does not edit that file:

```marko
<div><badge kind="ok">All systems nominal</badge></div>
```

```html
<div><mx-badge kind="ok">All systems nominal</mx-badge></div>
<!-- Add to x.component.ts: `import Badge from "./tags/badge";` and `imports: [Badge]` -->
```

Without that `imports:` entry Angular renders an unknown element as an inert
empty tag with no error, which is why the warning exists. **In step 2
(`.ng.mx`) this obligation disappears** — MX owns the module and injects
both lines itself.

Hand-written Angular components: use their selector as an element; PascalCase calls are for MX tag files. A `.mx` template can call a plain hand-written
component (`product-list.component.ts`, `selector: "app-product-list"`)
exactly as it would in a `.html` template — `<app-product-list/>` — with no
warning and no `imports:` obligation, because MX never touches that
component's module; the page's own `.ts` imports it directly, like any
other Angular component.

## `.ng.mx` {#ngmx}

A `.ng.mx` file is an ordinary TypeScript module whose `@Component`
template is written in MX. One file holds the class and its template, and
`mx-angular` emits `x.component.ts` beside it.

```ts title="src/app/product-list/product-list.component.ng.mx"
import { Component } from "@angular/core";

@Component({
  selector: "app-product-list",
  template: <ul>
    <for|p| of=products by=(p => p.id)>
      <li><if=p.featured>★ </if>${p.name}</li>
    </for>
  </ul>,
})
export class ProductList {
  protected products = [{ id: 1, name: "MX", featured: true }];
}
```

Everything outside the region is your own TypeScript, passed through
untouched. MX replaces the region with the Angular template it lowers to,
as a template literal.

**MX maintains `imports:` for you.** This is the difference from a page
template: an MX tag the template calls, and every Angular directive the
lowering needs (`NgClass`, `NgStyle`, `KeyValuePipe`, `NgComponentOutlet`,
`NgTemplateOutlet`), is added to the decorator's `imports:` array *and*
given its `import` statement. A symbol you already listed is left alone. On
a page template you do this by hand and MX warns; here the warning is gone
because the edit is made.

### Where a region may appear

Exactly one place: the **direct value of `template:`** in an
`@Component({ … })` decorator's first argument. Angular has nowhere else to
put a template, so every other position is an error naming the rule rather
than something MX tries to lower — a wrapping call, a ternary, an object one
level deeper, a non-`Component` decorator, no decorator at all, or a second
decorator argument.

A region is one expression, so it has exactly one root element — the same
rule a `.solid.mx` region follows. Wrap siblings in a container.

### Module-level tags stay in the module

`import`, `static` and `export interface Input` are **not** written inside a
region: it sits in TypeScript expression position, where those are statement
syntax and the parser rejects them before MX sees the file. Write them at
the top of the module, where they would go anyway. (An import MX mints for a
discovered tag is different — it never passes through expression position,
and MX places it for you.)

### Build

`.ng.mx` files are discovered **project-wide**, like the tag index and
unlike page templates — `include` does not have to match them. A component
module Angular compiles is not something a narrowed `include` should be
able to skip silently.

`mx-angular build` and `watch` route `.ng.mx` automatically; the emitted
`.ts` carries the generated header and a `.map` sidecar, and MX refuses to
overwrite a module it did not generate. Configure the output extension with
`mx.angular.ngExtension` (default `.ts`). **Gitignore the emitted `.ts`** —
it is a build artifact, like the `.html` a page template emits.

## Errors

Exit code `0` on a clean build, `1` on any error. Every message is
positioned: `file:line:col message`.

## Examples

- `examples/angular-app` — a stock Angular CLI 22 app (`@angular/build:application`,
  no custom builder), three components:
  - `app.component.mx` — the root shell: text and interpolation,
    `<if>`/`<else>`, `<for … by=>`, `<const>`, an event binding, and
    `[ngClass]` (with `NgClass` added to the component's own `imports`, per
    the warning above); calls the other two components below.
  - `product-list/product-list.component.mx` — a hand-written component
    (`selector: "app-product-list"`, called from `app.component.mx` as
    a plain element) whose template exercises `<for in=>` (Angular's
    `keyvalue` pipe), `<define>` + a call (`ngTemplateOutlet`), `[ngStyle]`
    from an object literal, the `attr.`/`class.`/`style.` binding
    modifiers, and an `<html-comment>`.
  - `tags/badge.mx` — a discovered custom tag, the same one this page's
    "Custom tags" section walks through above.

  Every component keeps `templateUrl` pointing at a gitignored,
  `mx-angular`-emitted `.html` (and `tags/badge.ts` is itself a gitignored,
  emitted component module). `bun run build` runs `mx-angular build` (via
  `prebuild`) then `ng build`; `bun run start` runs
  `bun run prebuild && concurrently -k -n mx,ng "mx-angular watch" "ng serve"`
  (one process, both `mx-angular watch` and `ng serve` running together) —
  `mx-angular watch` (in this repo: `bun ../../packages/hosts/angular/dist/bin.js watch`),
  since a fresh checkout has no `node_modules/.bin/mx-angular` symlink until
  root `bun run build` produces `dist/`.

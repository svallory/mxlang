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

A `.mx` file on this host compiles to one of two outputs, decided by
**discovery, not naming convention** — the same rule that decides whether a
call resolves to a custom tag anywhere else in MX:

| input | output | why |
|---|---|---|
| a page template — matched by `include`, not discovered as a tag | `x.component.html` | the body of a `templateUrl` a hand-written `x.component.ts` points at |
| a tag file — discovered under a `tags/` directory or `package.json#mx.tags` | an Angular component module | a component is a class plus a decorator; there is no template-only form |

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

`<let>`, `<effect>`, `<lifecycle>`, `<script>` and `:=` are compile errors —
this host has no reactive runtime of its own; that state belongs in the
hand-written component class.

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
["solid"]` is not claimed by `mx-angular` at all. **Emitting a discovered
tag as an Angular component module is not built yet** — an Angular
component needs a class and a decorator, which is a different compilation
route (`@mxlang/core`'s tag-unit compile) than the one this host uses for a
page template today. Until that lands, a discovered tag file reports a
positioned error rather than emitting a plain template where a component
belongs. A page *calling* a discovered tag with a sidecar (`.tag.ts`) still
compiles normally — only the tag's own emission is blocked, not a caller
that references it.

## Errors

Exit code `0` on a clean build, `1` on any error. Every message is
positioned: `file:line:col message`.

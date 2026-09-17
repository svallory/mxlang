# @mxlang/example-angular-app

A stock Angular CLI 22 app (`@angular/build:application`, no custom builder)
whose components keep `templateUrl` and write their templates in MX
(`.mx`), compiled by `mx-angular`. The emitted `.html`/`.html.map` and every
discovered tag's compiled `.ts` module are gitignored — `mx-angular` must
run before `ng build`/`ng serve`. Requires the repo's root `bun run build`
to have run first (`mx-angular` resolves to
`packages/hosts/angular/dist/bin.js`, same as every other example depending
on a built `@mxlang/*` package).

```
bun run build   # mx-angular build (prebuild), then ng build
bun run start   # mx-angular build, then `mx-angular watch` + `ng serve` together (concurrently)
```

## Components

- **`app.component.mx`** — the root shell: `<if>`/`<else>`, `<const>`,
  `<for of= by=>`, `[ngClass]` from a shorthand-`class` object, an
  `onClick=` handler, and calls both other components below.
- **`product-list/product-list.component.mx`** — a hand-written Angular
  component (`selector: "app-product-list"`) whose template is MX,
  exercising `<for in=>` (emitted with Angular's `keyvalue` pipe — add
  `KeyValuePipe` to the component's imports, per the compiler's own
  warning), `<define>` + a call (`ngTemplateOutlet`/`ngTemplateOutletContext`),
  `[ngStyle]` from an object literal, the `attr.`/`class.`/`style.` binding
  modifiers, and an `<html-comment>`. Called from `app.component.mx` as
  a plain element, `<app-product-list/>`.
- **`tags/badge.mx`** — a discovered custom tag (task 1.7): an `Input`
  interface with one required prop (`kind`) and one optional prop
  (`label`), reading its projected content with `${input.content()}`.
  Called from the page as `<badge kind="ok">…</badge>`.

Hand-written Angular components: use their selector as an element; PascalCase calls are for MX tag files.

## Custom tags: the step-1 obligation

`mx-angular build` cannot edit a caller's `.ts` file, so it prints the
import/`imports:` line to add by hand. For this app, that line (from
`app.component.html`'s generated header) is:

```
Add to app.component.ts: `import Badge from "./tags/badge";` and `imports: [Badge]`.
```

`app.component.ts` adds this itself; a real project does the same for every
MX tag file a page calls. `ProductList` is a hand-written component, not an
MX tag file, so it needs no such line — `app.component.ts` imports it
directly, the way any Angular component imports another.

`(click)="(toggleHighlight)($event)"` in the emitted template — the
parenthesized callee is the emitter's own deliberate form for an
`onClick=handler` binding, not a mistake to clean up.

See `apps/docs/docs/hosts/angular.md` for the full `mx-angular` CLI
reference, including its "Custom tags" section (copied byte-for-byte from
`tags/badge.mx`).

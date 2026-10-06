---
title: "Angular: .ng.mx in detail"
description: "Where the MX template goes in a .ng.mx file, fragments for several roots, how MX maintains imports, calling MX tags, and what the build writes."
---

# Angular: `.ng.mx` in detail

A `.ng.mx` file is a TypeScript module. One expression in it is MX: the value of `template:`. Everything else passes through untouched, and `mx-angular` writes the result as `x.component.ts` beside it.

## The template goes in one place

The MX region is the **direct value of `template:`** in the first argument of `@Component({ … })`. Any other position (a wrapping call, a ternary, a nested object, another decorator) is an error that names this rule.

Everything outside `template:` is ordinary TypeScript: imports and types go at the top of the module, not in the template.

## Several roots: a fragment

A region is one expression, so it has one root. An Angular template may have many; say so with `<>…</>`:

```ts "sortable-th.component.ng.mx"
@Component({
  selector: "[sortable-th]",
  template: <>
    <ng-content/>
    <app-sort-indicator direction=direction/>
  </>,
})
export class SortableTh {}
```

The children are emitted as siblings: no `<ng-container>` and no wrapper element, which matters for an attribute-selector component whose host element is not yours to wrap. A fragment is only valid as the root of the template, cannot nest, and `<></>` is an empty template. Two bare roots are an error that tells you to wrap them.

## MX maintains `imports:`

Every MX tag the template calls, and every Angular directive the compiled template needs (`NgClass`, `NgStyle`, `KeyValuePipe`, `NgComponentOutlet`, `NgTemplateOutlet`), is added to the decorator's `imports:` and given its `import` statement. A symbol you already listed is left alone. Hand-written components you call by selector are yours to import, as always.

**`standalone: false`.** Angular rejects `imports:` on such a component, so MX leaves the decorator alone and warns at the template with each symbol the declaring NgModule must provide.

## Calling an MX tag

```ts
import Card from "./tags/card.mx";
// …
template: <Card><@title>Team</@title></Card>,
```

`<Card>` emits the tag's selector (`<mx-card>`), one `imports:` entry, and the import rewritten to the generated class. A tag under a `tags/` directory can also be called by its discovered name, `<card>`, with no import. The import must be a sole default import: `import A, { b } from "./x.mx"` used as `<A/>` is an error. See [MX tags](/hosts/angular/pages-and-tags/#angular-page-templates-mx-tags-and-the-cli-mx-tags).

## Event handlers

`onClick=clear` compiles to `(click)="__mxOn(clear, this, $event)"`. The call goes through a small typed invoker so that a handler with no parameters, one, or Marko's `(event, element)` all type-check under `strictTemplates`. MX adds the two invoker members (`__mxOn`, `__mxOnAt`) to your class. To own them instead, extend the base class and MX adds nothing:

```ts
import { MxHandlers, MxHandlersMixin } from "@mxlang/angular/runtime";

export class FormComponent extends MxHandlers {}
export class ListComponent extends MxHandlersMixin(PagedBase) {}
```

Extend them directly. Through an alias or a base class in another file, MX cannot see the members, adds its own, and TypeScript reports the clash (TS2415). Importing the runtime makes `@mxlang/angular` a `dependencies` entry, not a dev one. Details are in [Events](/hosts/angular/lowering/#angular-what-mx-compiles-to-events).

## What the build writes

- `x.component.ng.mx` becomes `x.component.ts` (change the extension with `mx.angular.ngExtension`), with a generated header and a `.map` file beside it.
- MX refuses to overwrite a file that does not carry its header, so a hand-written module is never clobbered.
- `.ng.mx` files are discovered across the whole project; `mx.angular.include` does not apply to them.
- The emitted `.ts` is a build artifact: ignore it in git.

## Editors

VS Code and Zed register `.ng.mx`: the module highlights as TypeScript and the template as MX. See [VS Code](/editors/vscode/) and [Zed](/editors/zed/).

---
title: "Angular"
description: "MX in place of the template in an Angular component: <if> and <for> compile to @if and @for, attribute tags to content projection, and MX keeps the imports array for you."
---

# Angular

A `.ng.mx` file is an Angular component module with MX as the value of `template:`. The class, the decorator, inputs, signals and injection are the TypeScript you already write, and the Angular compiler builds the result. The template changes.

This is one component, as Angular and then as `.ng.mx`. `Card` is an MX tag with a `title` and a `footer` projection.

```ts "team.component.ts"
import { NgClass } from "@angular/common";
import { Component, Input } from "@angular/core";
import { Card } from "./tags/card";
import type { Member } from "./members";

@Component({
  selector: "app-team",
  imports: [Card, NgClass],
  template: `
    <mx-card>
      <ng-container ngProjectAs="[title]">
        Team <span class="count">{{ shown.length }}</span>
      </ng-container>
      <input name="q" class="search" type="search" [value]="query" (input)="search($event)" />
      @if (shown.length) {
        <ul class="members">
          @for (member of shown; track member.id) {
            <li [ngClass]="{ admin: member.admin }">
              {{ member.name }}
              @for (team of member.teams; track team) {
                <span class="tag">{{ team }}</span>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="empty">Nobody matches “{{ query }}”.</p>
      }
      <ng-container ngProjectAs="[footer]">
        <button class="button" (click)="clear()">Clear</button>
      </ng-container>
    </mx-card>
  `,
})
export class Team {
  @Input() members: Member[] = [];
  protected query = "";

  protected get shown() {
    return this.members.filter((member) => member.name.includes(this.query));
  }

  protected search(event: Event) {
    this.query = (event.target as HTMLInputElement).value;
  }

  protected clear() {
    this.query = "";
  }
}
```

```mx "team.component.ng.mx"
import { Component, Input } from "@angular/core";
import Card from "./tags/card.mx";
import type { Member } from "./members";

@Component({
  selector: "app-team",
  template: <Card>
    <@title>Team <span.count>${shown.length}</span></@title>
    <input:q.search type="search" value=query onInput=search/>
    <if=shown.length>
      <ul.members>
        <for|member| of=shown by=(member => member.id)>
          <li class={ admin: member.admin }>
            ${member.name}
            <for|team| of=member.teams by=(team => team)><span.tag>${team}</span></for>
          </li>
        </for>
      </ul>
    </if>
    <else>
      <p.empty>Nobody matches “${query}”.</p>
    </else>
    <@footer><button.button onClick=clear>Clear</button></@footer>
  </Card>,
})
export class Team {
  @Input() members: Member[] = [];
  protected query = "";

  protected get shown() {
    return this.members.filter((member) => member.name.includes(this.query));
  }

  protected search(event: Event) {
    this.query = (event.target as HTMLInputElement).value;
  }

  protected clear() {
    this.query = "";
  }
}
```

What changed:

- **No `imports:` array.** MX adds `Card` and `NgClass` to the decorator and writes their `import` lines, because it knows what the template uses.
- **`<@title>` and `<@footer>`** are [attribute tags](/language/attribute-tags-and-params/): content projected into `Card`'s named slots, without `ngProjectAs`.
- **`<if>` / `<else>` and `<for>`** compile to `@if`, `@else` and `@for … track`.
- **`<input:q.search>`, `<span.tag>`** are `name` and `class`. `class={ admin: member.admin }` is `[ngClass]`.
- **`value=query`, `onInput=search`** are plain attributes; MX picks `[value]` and `(input)`.
- **The template is not a string.** It is highlighted, formatted and checked like code.

## Setup

```bash
bun add -d @mxlang/host-angular
```

```jsonc
// package.json
{
  "mx": { "host": "angular" },
  "scripts": {
    "start": "mx-angular build && concurrently -k \"mx-angular watch\" \"ng serve\"",
    "build": "mx-angular build && ng build"
  }
}
```

`mx-angular` writes `team.component.ts` beside `team.component.ng.mx`, and Angular compiles that file like any other. Add the emitted files to `.gitignore`. `.ng.mx` files are found anywhere in the project, with no configuration.

For type errors in the editor, add `{ "name": "@mxlang/typescript-plugin" }` to `compilerOptions.plugins`; in CI, run `mx-tsc --noEmit`. Both also run Angular's own template checker on every `template:` and report at the line you wrote: see [Diagnostics](/hosts/angular/diagnostics/).

## What stays Angular, what MX adds

**Stays Angular:** the class, `@Component` and its other fields, inputs and outputs, signals, dependency injection, the router, `ng build` and `ng serve`. A hand-written component is called by its selector, as in any template: `<app-product-list/>`.

**MX adds:** the template syntax above, compiled to Angular's block syntax (`@if`, `@for`, `@let`), and the `imports:` bookkeeping. There is no MX runtime in the browser.

## Two rules to know first

- **Handlers are references or expression arrows.** Write `onClick=clear` or `onClick=(event => save(event))`. Angular templates have no statement bodies, so the method form `onClick() { … }` and a block-bodied arrow are compile errors here.
- **Do not import a name that is also an element.** `import { input } from "@angular/core"` makes `<input>` a call of that function; use `@Input()` or alias the import.

## Go deeper

- [`.ng.mx` in detail](/hosts/angular/ng-mx/): where the template goes, fragments for several roots, `imports:` rules, build output.
- [What MX compiles to](/hosts/angular/lowering/): the table, how an attribute becomes a property or attribute binding, events.
- [Diagnostics](/hosts/angular/diagnostics/): TypeScript and Angular template errors in `mx-tsc` and the editor.
- [Page templates, MX tags and the CLI](/hosts/angular/pages-and-tags/): a `.mx` beside a hand-written component, tags such as `Card`, and `mx-angular build`, `watch` and `map`.

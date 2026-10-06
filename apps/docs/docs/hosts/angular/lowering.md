---
title: "Angular: what MX compiles to"
description: "Each MX construct and the Angular template syntax it becomes: block control flow, property and attribute bindings, events, the name sugar, and the errors."
---

# Angular: what MX compiles to

MX compiles to Angular's block syntax (`@if`, `@for`, `@let`), never the older `*ngIf` and `*ngFor`.

| Written | Emitted |
|---|---|
| `${expr}` | `{{ expr }}` |
| `<if>` / `<else if>` / `<else>` | `@if (…) { … } @else if (…) { … } @else { … }` |
| `<for\|item\| of=items by=(item => item.id)>` | `@for (item of items; track item.id) { … }` |
| `<for\|k, v\| in=obj>` | `@for` over `obj \| keyvalue`, with `@let k` and `@let v` |
| `class={ active: isOn }`, `style={ … }` | `[ngClass]`, `[ngStyle]` |
| `<define/Row\|p\|>` and `<Row/>` | an `<ng-template>` with `let-` params, and `ngTemplateOutlet` |
| an MX tag call | the tag's component element |
| `<@name>` on an MX tag | `<ng-container ngProjectAs="[name]">` |
| `onClick=f` | `(click)="__mxOn(f, this, $event)"` |
| `attr=expr` on an element | `[attr]`, or `[attr.attr]`: see below |

Give `<for>` a `by`: Angular requires `track`, and MX warns on a loop without one.

## Attributes: property or attribute binding?

You write `title=text` or `disabled=busy`; MX chooses the binding from Angular's own DOM schema, the one behind error NG8002.

- **A property of that element** (`title`, `hidden`, `value` on an `<input>`, `disabled` on a `<button>`) binds the property: `[title]`.
- **`data-*`, `aria-*`, and names that are not a property there** (`disabled` on a `<div>`, `maxlength`, `colspan`) bind the attribute: `[attr.maxlength]`.
- **`class` and `style`** bind `[class]` and `[style]`.
- **A name the schema does not know, or any attribute of a component**, stays `[x]`: it may be a directive input, and without one Angular reports NG8002 as usual.

In each case Marko's value rules hold: `null`, `undefined` and `false` omit the attribute, `true` renders it bare, `0` and `""` are kept. One limit: a property cannot remove an attribute, so a string property given `null` renders `title=""`.

The expression is evaluated once, in an `@let` before the element. This step loads `@angular/compiler` (`>=22.0.0 <23.0.0`) from your project; if it is missing, the attribute is a compile error naming the package.

## Structural directives

`*ngIf="x"` and other `*` directives pass through only as the **first** attribute of a tag. Later in the tag, ` *name` parses as a multiplication and the error says so. Prefer `<if>` and `<for>`.

## Name sugar

`:name`, `#id` and `.class` work as on every host, with two Angular facts:

- **`<div #ref>` is still a template reference.** In attribute position `#x` is Angular's; next to the tag name, `<div#x>`, it is the `id` sugar.
- **`<svg:rect>` is the tag `svg` with `name="rect"`.** Wrap in `<svg>` and write `<rect>`.

## Events

`onClick=f`, `on-<exact-name>=f` and a lowercase `onclick=f` are event bindings. MX reads the DOM event name and emits `(name)`.

| Written | Emitted |
|---|---|
| `onClick=f` | `(click)="__mxOn(f, this, $event)"` |
| `onClick=svc.f` | `(click)="__mxOnAt(svc, 'f', $event)"`, so `this` is `svc` |
| `onClick=(e => handle(e))` | `(click)="__mxOn(e => handle(e), null, $event)"` |
| `on-my-event=f` | `(my-event)="__mxOn(f, this, $event)"` |

- **The handler is called with `(event, element)`**, as in Marko, and a handler that returns `false` prevents the default. A falsy handler (`onClick=(ready && save)`) does nothing.
- **`this` is the component** (or the object the method was read from), where Marko's is the element. `element` is `$event.currentTarget`.
- **Custom events work**: Angular's binding takes any event name, so `on-my-event` is first-class here.
- **Spell the DOM name.** `onDoubleClick` is not a DOM event; MX warns and emits `(doubleclick)` as written. Write `onDblClick`.
- **On a component**, `onSelect=pick` binds the input `[onSelect]`. MX does not infer an `@Output()`.
- **The method form `onClick() { … }` is not supported.** Angular templates have no function bodies; use a method reference or an arrow.

`__mxOn` and `__mxOnAt` are two members on the component class. A `.ng.mx` gets them [automatically](/hosts/angular/ng-mx/#angular-ngmx-in-detail-event-handlers); a [page template](/hosts/angular/pages-and-tags/) needs them on its hand-written class. Use `strictTemplates`: without it Angular checks only top-level bindings, and a missing member inside `@if` or `@for` fails at run time instead of at build.

## What is an error

- **State and effects**: `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `<id>`, `<await>`, `<log>`, `<debug>`, `client` and `server` blocks, and `:=`. State belongs in the component class.
- **`class:x`, `style:x`, `attr:x`**: not MX syntax. Write an object for `class` or `style`, and the attribute plainly (`data-kind=x`); MX picks the binding.
- **`on:click`**: the error names `onClick`.

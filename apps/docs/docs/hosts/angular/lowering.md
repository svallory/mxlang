---
title: "Angular: what MX compiles to"
description: "Each MX construct and the Angular template syntax it becomes: block control flow, property and attribute bindings, events, the shorthands, and the errors."
---

# Angular: what MX compiles to

MX compiles to Angular's block syntax (`@if`, `@for`, `@let`), never the older `*ngIf` and `*ngFor`.

| Written | Emitted |
|---|---|
| `${expr}` | `{{ expr }}` |
| `$!{expr}` | `<span [innerHTML]="expr">`, with a warning: Angular sanitizes the HTML, and the `<span>` is invalid where only certain children are allowed (`<tbody>`, `<select>`, `<ul>`) |
| `<if>` / `<else if>` / `<else>` | `@if (…) { … } @else if (…) { … } @else { … }` |
| `<for\|item\| of=items by=(item => item.id)>` | `@for (item of items; track item.id) { … }` |
| `<for\|k, v\| in=obj>` | `@for` over `obj \| keyvalue: null`, with `@let k` and `@let v`, plus a warning telling you to add `KeyValuePipe` to the component's imports |
| `class={ active: isOn }`, `style={ … }` | `[ngClass]`, `[ngStyle]` |
| `class=["a", y]`, or a shorthand beside `class=`: `<div.a class=y/>` | `[class]="__mxClass(['a', y])"`: the same class set Marko prints (falsy parts skipped); Angular may order the words differently |
| the same `class=` on an MX tag call whose `Input` declares `class` | `[class]="['a', y]"`, `[class]="y"`: the callee's `class` input gets the value as written, as Marko hands it to `input.class`. A static class (`<Card class="lit"/>`, `<Card.a/>`) goes to the input the same way and not also onto the callee's host element |
| `<const/x=expr/>` | `@let x = expr;`. In the body of a native element (`<div><const/x=1/>…</div>`) `x` gets a name of its own: see below |
| `<define/Row\|p\|>` and `<Row(value)/>` | an `<ng-template>` with `let-` params, and `ngTemplateOutlet` |
| an MX tag call | the tag's component element |
| `<${Comp} x=1/>`, or a tag named by a module-scope `const` | `<ng-container [ngComponentOutlet]="Comp" [ngComponentOutletInputs]="…">`; content and tag arguments are errors |
| `<@name>` on an MX tag | `<ng-container ngProjectAs="[name]">` |
| `onClick=f` | `(click)="__mxOn(f, this, $event)"` |
| `attr=expr` on an element | `[attr]`, or `[attr.attr]`: see below |

An array `class` is never bound to `[ngClass]`: Angular throws in dev mode on any entry that is not a string (`null`, `false`, a number, an object, a nested array), and a shorthand beside `class=y` is always an array. `__mxClass` is a member on the component class, like the event invokers: a `.ng.mx` and a tag module get it automatically, a page extends `MxHandlers` / `MxHandlersMixin(Base)` or pastes the member the warning prints.

On an MX tag call Marko passes `class` to the callee's `input.class` unchanged: `class=y` is `y`, `<Card.a class=y/>` is `["a", y]`. When the callee's `Input` declares `class`, the call binds `[class]` with the value as written and the callee gets exactly that. A static class (`class="lit"`, or a shorthand such as `<Card.a/>`) goes to the same input as a string and is not also set as an attribute on the callee's host element, so the class appears only where the callee prints it, as in Marko. A callee without a `class` input keeps the class on its host element. Type the callee's `class` input `unknown`: it receives whatever the caller wrote (a string, an array, an object), and `class?: string` fails under `strictTemplates` with TS2322 for `<Card.a class=y/>`. That tag module is emitted with `changeDetection: Eager`, because Angular components default to OnPush and a call assigns `class` as a plain property: without it the callee would keep the first class it received. Inside a tag module or a `.ng.mx`, a dynamic `class=` on a native element or a tag call (other than an object literal, which stays `[ngClass]`) is joined by `__mxClass`, so `class=input.class` or `class=y` prints Marko's class text for an array, object, `null`, `0` or a number. Those two files own their component class, which is why the member is injected there. A plain `.mx` page is unchanged: it would need the author to add the member, so its non-literal `class=` keeps the plain `[class]` binding.

A name a body declares belongs to that body, as in Marko: `<const/n=1/><div><const/n=2/>${n}</div>${n}` renders `<div>2</div>1`. Angular scopes a `@let` (and a `#ref`) to a view, not to an element, so two `@let n` in one view would collide and every read would get the first value. The same holds for the body of an MX tag call (`<Card>…</Card>`) and of an attribute tag (`<@header>…</@header>`): Angular projects them into the callee, but they are written in the caller's template, so their `@let` is in the caller's view. The emitter renames a `<const>` or `<define>` written directly in the body of a native element, a tag call or an attribute tag only when its name collides: another `<const>`, `<define>`, parameter or `/var` in the template has the same name, an Angular template reference or variable (`#a`, `ref-a`, `let-a`) has it, or the name is read outside the declaration's own body. The renamed one gets a name of its own (`@let __mxConst_n1 = 2;`, `#__mxDefine_D1`) and the reads after it, in that body, are pointed at it. A name nothing else shares is emitted as written (`<section><const/a=1/></section>` is `<section>@let a = 1;</section>`), so an ordinary single-root template never shows a generated name. No view is opened, so the DOM, the comment nodes and content projection into a hand-written component called by selector (named slots included) are unchanged. `<const/a=1/><Card><const/a=2/>${a}</Card>${a}` is `@let a = 1;<mx-card>@let __mxConst_a = 2;{{ __mxConst_a }}</mx-card>{{ a }}`, and `<Card><const/a=2/>${a}</Card>` is `<mx-card>@let a = 2;{{ a }}</mx-card>`. A body that declares nothing is emitted as before. The body of a `<define>`, `<if>` or `<for>` is a view of its own and is not renamed.

MX's own messages print a renamed name as written, and the Angular diagnostics `mx-tsc` reports for a `.ng.mx` (the unused `@let` warning NG8112, a `@let` in a two-way binding) are printed with each generated name replaced by the authored one, so a renamed `<const/a=…/>` is still `@let a`. `ng build` and `ng serve` run Angular on the files `mx-angular build` wrote (a page's `.html`, a tag module's `.ts`, a `.ng.mx`'s `.ts`) with no MX layer in between, so a name that collides shows there as `__mxConst_a`. A name nothing else shares is never renamed, so that happens only for the collisions above.

When a name is renamed, the new name is part of the expression text Angular hashes into an `i18n` message id, so an `i18n` element that reads such a name has a different id than the same read written `n` had, and the id depends on declaration order: the suffix counts the renamed `<const>` and `<define>` of that name written in element, tag call and attribute tag bodies earlier in the file (`__mxConst_n`, `__mxConst_n1`), so adding one changes the ids of later messages that read a renamed `n`. A translation file keyed by message id needs re-extracting for such an element.

An Angular `@let` cannot read an outer binding of the same name in its own value: `<const/a=a+1/>` inside an `<if>` or `<for>` body reads itself, not the outer `a`. Name the inner binding differently.

Give `<for>` a `by`: Angular requires `track`. A loop without one emits `track $index`, and MX warns once per file, since reordering such a list re-renders its rows.

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

## Shorthands and colons

`#id` and `.class` next to the tag name work as on every host, with three Angular facts:

- **`<div #ref>` is a template reference.** In attribute position `#x` is Angular's; next to the tag name, `<div#x>`, it is the `id` shorthand.
- **`<svg:rect>` is one tag name.** A colon in a tag name is part of the name, as in Marko, so it reaches the template as Angular's `svg:`-prefixed element.
- **A class beside `class=` has the same set of words, maybe in another order.** `<div.a class=y/>` is bound as `[class]`, and Angular may reorder the words of a `[class]` string. Marko prints the shorthand first. A repeated word collapses to one, and a class that becomes empty after an update leaves `class=""`.

## Events

`onClick=f`, `on-<exact-name>=f` and a lowercase `onclick=f` are event bindings. MX reads the DOM event name and emits `(name)`.

| Written | Emitted |
|---|---|
| `onClick=f` | `(click)="__mxOn(f, this, $event)"` |
| `onClick=svc.f` | `(click)="__mxOnAt(svc, 'f', $event)"`, so `this` is `svc` |
| `onClick=(e => handle(e))` | `(click)="__mxOn(e => handle(e), null, $event)"` |
| `on-my-event=f` | `(my-event)="__mxOn(f, this, $event)"` |

- **The handler is called with `(event, element)`**, as in Marko, and a handler that returns `false` prevents the default. A falsy handler (`onClick=(ready && save)`) does nothing.
- **`this` is the component** (or the object the method was read from), where Marko's is the element. `element` is `$event.currentTarget`, typed `EventTarget | null`.
- **Custom events work**: Angular's binding takes any event name, so `on-my-event` is first-class here.
- **Spell the DOM name.** `onDoubleClick` is not a DOM event; MX warns and emits `(doubleclick)` as written. Write `onDblClick`.
- **On a component**, `onSelect=pick` binds the input `[onSelect]`. MX does not infer an `@Output()`.
- **No statement bodies.** Angular templates have no `function` keyword and no block bodies, so the method form `onClick() { … }`, a `function` expression and a block-bodied arrow are positioned errors. Use a method reference or an expression arrow.

`__mxOn` and `__mxOnAt` are two members on the component class. A `.ng.mx` gets them [automatically](/hosts/angular/ng-mx/#angular-ngmx-in-detail-event-handlers); a [page template](/hosts/angular/pages-and-tags/) needs them on its hand-written class. Use `strictTemplates`: without it Angular checks only top-level bindings, and a missing member inside `@if` or `@for` fails at run time instead of at build.

## What is an error

- **State and effects**: `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `<id>`, `<await>`, `<log>`, `<debug>`, `client` and `server` blocks, and `:=`. State belongs in the component class.
- **`class:x`, `style:x`**: not MX syntax; the only reserved colon prefixes. The error points to an object or array `class=` value (lowered to `[ngClass]`) or an object `style=` value (lowered to `[ngStyle]`). Every other colon name, `attr:x` included, is an ordinary attribute that keeps its full name. Angular's `attr.` prefix is not needed either: write the attribute plainly (`data-kind=x`) and MX picks the binding.
- **`<return>` and tag variables (`<Tag/x>`)**: an Angular component has no channel to hand a value back to its caller. **`<try>`**: Angular has no template-level error boundary; handle the error in the component and render the fallback with `<if>`.
- **A refined bound attribute on an optional chain** (`<input value:fn:=q?.a/>`): Marko compiles it with a nullish guard, but Angular's two-way binding needs a writable target, so the error says to bind a name or a member of one. The unrefined `value:=q?.a` emits `[(value)]="q?.a"`.
- **`on:click`**: the error names `onClick`.

Angular template syntax written as literal text (`{{ name }}`, `@if (x) {`, `@for`, `@let name = …;`) in any text node, `<pre>`, `<code>` and `<textarea>` included, compiles to literal text and gets a **warning** that points to the MX form (`${name}`, `<if>`, `<for>`, `<const>`) and to the escape for text you mean literally. Braces inside an expression attribute value or already escaped do not warn, and an `@` keyword warns only before real block syntax.

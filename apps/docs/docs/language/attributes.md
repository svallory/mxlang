---
title: "Attributes"
description: "Attribute forms on elements and components: the #id, .class and :name sugars, and how event handlers are named."
---

# Attributes

## `#id` and `.class` without a tag name

`#id` and `.class` are shorthands for the `id` and `class` attributes. Written
without a tag name (`<#main>`, `<.card.wide>`, or a concise-mode line starting
with `#` or `.`), they stand on an **unnamed tag**, and the *target* decides
which tag that is. On every HTML target it is `div`, so nothing changes for a
web page:

```mx
<#main>
  <.card.wide>hello</>
</>
```

```html
<div id="main"><div class="card wide">hello</div></div>
```

On the [data target](/specification/#the-mx-language-13-host-semantics-table-137-the-data-target) there is no `div`; the
unnamed tag is the built-in `object`, a tag with an open contract that carries
`id` and `class` as ordinary attributes:

```mx
<#a/>
<.b/>
```

`parseData` returns two tags named `object`, the first with `id="a"`, the second
with `class="b"`.

You can change the answer. In the order they win:

1. **The parent tag's contract.** A tag declares `defaultTag` beside `children`
   ([custom tags](/custom-tags/reference/)), so everything shorthand-only under it
   is that tag.
2. **Your package**: `package.json#mx.<target>.defaultTag`, for example
   `{ "mx": { "html": { "defaultTag": "section" } } }` makes the first example
   `<section id="main"><section class="card wide">hello</section></section>`.
3. **The host**, if it overrides its target.
4. **The target's built-in**: `div` or `object`.

The name must be a tag the target knows (an element, or one of your custom tags)
and must be a plain tag: `input`, `pre`, `title` and `script` are refused with
``invalid `defaultTag` value: …`` at the declaration. After the name is resolved
the tag is an ordinary one, so the parent's `children` list and the tag's own
`attributes` contract apply to it. The full rules are in
[The unnamed tag](/specification/#the-mx-language-4-elements-and-attributes-the-unnamed-tag) and
[ADR 145](/design-notes/adr-default-tag/).

## `:name`, and `#id` and `.class` after an attribute

`:email` sets `name="email"`, the way `#main` sets `id` and `.big` sets `class`.
A great many tags carry a `name` (`<input>`, `<select>`, `<button>`, and every
entry of a data vocabulary), and this is the short spelling. It works in three
positions, in HTML and concise mode alike:

```mx
<input:email type="email"/>
<input type="email" :email/>
<input :email type="email"/>
<input x="1" #main .big/>
```

```html
<input name="email" type="email">
<input type="email" name="email">
<input name="email" type="email">
<input x="1" id="main" class="big">
```

- **Tag-adjacent** (`<input:email>`): the sugar sits on the tag name.
- **First attribute** (`<input :email type="email">`).
- **After any attribute** (`<input type="email" :email>`, `<input x="1" #main .big>`):
  the attribute lands where you wrote it. In concise mode,
  `input x="1" #main .big :email` is `<input x="1" id="main" class="big" name="email">`.
- **On Angular**, attribute-position `#x` stays Angular's template reference (`<div #ref>`; see the [Angular host](/hosts/angular/lowering/#angular-what-mx-compiles-to-name-sugar)); tag-adjacent `<div#x>` is the `id` sugar there too, and `:name` and `.class` apply in every position.

`name` is then an ordinary attribute, so a tag's declared `attributes` apply to
it, and a type or "unknown attribute" error names what you wrote, with what it
stands for: ``attribute `:email` (`name`) must be number, got string``.

In an expression position the same `:name` is an [atom](/language/atoms/), a
value that represents itself: `mode=:strict` is `"strict"` at runtime, and a
contract can type it (`type: "atom"`, `values`, `pattern`, `ref`). The sugar
above is the one case where an atom standing alone sets `name` instead, and the
`name` it sets keeps its atom-ness.

### Composition

Tag-adjacent sugars combine in any order. With no tag name the tag is the
[unnamed tag](#attributes-id-and-class-without-a-tag-name), so `<:email/>` is the target's
default tag with a name:

```mx
<a.c:b#d/>
<a#d:b.c/>
<:b.c/>
```

```html
<a name="b" class="c" id="d"></a>
<a name="b" class="c" id="d"></a>
<div name="b" class="c"></div>
```

A tag takes **one** `:name`. `<a:b.c:d/>` is an error at the second colon (write
the second as `name="…"`). In attribute position `#x` and `.x` merge like the
shorthand next to the tag name: `<div.a #m .b/>` and `<div.a.b#m/>` are the same
tag. The class order follows one rule. **With a tag-adjacent class** (`<div.c>`),
`.x` joins it, ahead of an authored `class` (`<div.c class="x" .d/>` renders
`class="c d x"`, the same as `<div.c.d class="x"/>`). **With no tag-adjacent
class**, `.x` and an authored `class` keep their written order
(`<div class="a" .b/>` is `a b`, `<div .b class="a"/>` is `b a`). A falsy authored
literal (`false`, `0`, `null`, `undefined`) drops out, as Marko's class value does. A repeated `#x` or `:x`, or one
beside an explicit `id=` or `name=`, follows the
[duplicate-attribute rule](/specification/#the-mx-language-4-elements-and-attributes-name-sugar-name-id-and-class-anywhere-on-a-tag):
the later one wins, with a warning (`<input name="a" :b/>` renders
`<input name="b">`).

### A sugar followed by a value

`=` and `(` cannot be part of a sugar, so the space after a sugar is optional, and
what follows sets the tag's **default attribute** (`value`). `<input #x=1/>` is
`id="x"` plus `value=1`; `:x` and `.c` work the same way. A method after a sugar
is the default attribute's function, which is how a data vocabulary writes a
computed member, in any of three spellings that are one tag:

```mx
boolean #isOverdue({ self }) { return self.x }
boolean #isOverdue ({ self }) { return self.x }
boolean ({ self }) { return self.x } #isOverdue
```

(on the [data target](/specification/#the-mx-language-13-host-semantics-table-137-the-data-target):
a tag `boolean` with `id="isOverdue"` and a function `value`). A tag takes **one**
default value: `kind=1 #x=2` and `<if=a #x=b>` are errors at the second. A bound
`value:=y` counts as the default value too. On Angular an attribute-position
`#x=1` stays the template reference (it emits `[#x]="1"`, not `id` plus `value`);
`:n=1`, `.c=1` and tag-adjacent `<div#x=1>` set the default value there.

Tag-adjacent `=value` (`<a#x=1>`) is Marko's own default attribute, not this sugar's value, so a second plain `value=` beside it is decision 135's duplicate warning there, not the double-default error. A bound `:=` right after a sugar (`<a :n:=y/>`, `#x:=y`, `.c:=y`) is an error: write `name=... value:=...`.

### What stays what Marko does

| You write | You get |
|---|---|
| `<a class="hover:x"/>` | `class="hover:x"`, untouched |
| `<a.hover:x/>` | class `hover` plus `name="x"`: a shorthand class cannot contain `:` |
| `<div value:foo="y"/>` | Marko's attribute `value:foo`, untouched (the explicit `value:x` spelling) |
| `<a :x=1/>` | `name="x"` plus `value=1`: a sugar followed by `=value` sets the default attribute (see [A sugar followed by a value](#attributes-name-and-id-and-class-after-an-attribute-a-sugar-followed-by-a-value)) |
| `<div :/>` | an error: `:` is name sugar and needs a name (Marko read a bare `:` as `value:`; write `value:` for that attribute) |
| `<div :1a/>` | an error: `:name` takes an identifier (`#x` and `.x` take whatever Marko's shorthand takes, so `<div #1a .2xl/>` is `id="1a"`, `class="2xl"`) |
| `<div.bg-[#fff]/>` | an error at the `.bg-[`: a class shorthand cannot hold a Tailwind bracket value; write `class="bg-[#fff]"` |
| `<div.w-1.5/>` | an error at `.w-1`: the chain splits at the `.`, and the part `.5` may not start with a digit (it would silently render class `5`); write `class="w-1.5"` |
| `<div.w-1/2/>` | an error at `.w-1`: `/2` is not part of the class (Marko reads it as a tag variable, which a whole-file parse rejects and a region parse silently drops); write `class="w-1/2"` |
| `<div .bg-[#fff]/>` | the same errors in attribute position (`<div .w-1.5/>` and `<div .w-1/2/>` too) |
| `<div.bg-[url('/x.png')]/>` | an error at `.bg-[url('/x.png')]`, not Marko's `Mismatched group`: the parser cannot read the shorthand, so it is rewritten to the class-shorthand diagnostic |
| `<div.hover:bg-red/>` | class `hover` plus `name="bg-red"`, unchanged — valid shorthands stay valid |

An attribute tag's name (`<@svg:rect>`) is a property key and is not split;
sugar inside one applies. `<svg:rect>` is the tag `svg` plus `name="rect"`, on
every target.

### After a value: what changes

A `:name`, `#id` or `.class` after whitespace inside an attribute value starts a
new attribute. That changes one thing Marko reads differently: `.c` after a space
is no longer member access.

```mx
<a x=input.s .c/>
<a x=input.o.c/>
<a x=(input.o .c)/>
```

```html
<a x="S" class="c"></a>
<a x="C"></a>
<a x="C"></a>
```

Write a member chain without the space, or in parentheses. A multi-line chain in
an attribute value (`x=foo\n  .bar()`) is split the same way.

**The default attribute is exempt.** A value written right after the tag name
(`<if=cond>`, `<const/x=items>`, `<let/x=…/>`) keeps Marko's meaning, so a chain
across lines is still a chain:

```mx
<const/x=input.items
  .filter(Boolean)/>
<p>${x.length}</p>
```

```html
<p>2</p>
```

and sugar right after such a value is not supported:

```text
<if=input.x :b>y</if>
1:12 `:b` right after a default value is not supported (decision 151, ruling 2); put it before the value or on the tag (`<input:email type="email">`). See "the parser after-value rule" in divergences.md.
```

The one exception (decision 146 addendum 5): when the default value is a single
[atom](/language/atoms/), a `:name` after it is the name sugar, because an atom
takes no member access or operator and nothing else can follow it. `belongs-to=:Customer
:customer` sets the default value to the atom `:Customer` and `name` to the atom
`:customer`; `belongs-to=a :customer` is still the error above.

### Needs the patched parser (a limit, in plain words)

Sugar after an attribute value needs a small patch to `htmljs-parser`, which this
repository installs. A project that installs the published `@mxlang/*` packages
gets the stock parser through `@marko/compiler`, and there:

- `<input type="email" :email>` is a positioned MX error that says so and points
  at the tag-adjacent spelling (`<input:email type="email">`), which works with
  any parser, as does the first-attribute spelling (`<input :email type="email">`);
- `x=a.b .c` is **silently** member access. MX cannot see that per use, so on a
  stock parser keep `.c` out of attribute position after a value.

Do not run `prettier-plugin-marko` on a file that uses sugar after a value: it
bundles a stock parser and rewrites `<a x=a .b/>` to `<a x=a.b/>`, which turns a
class into member access without any error. See [formatting](/editors/vscode/#vs-code-formatting).

The rules, in full: [Name sugar](/specification/#the-mx-language-4-elements-and-attributes-name-sugar-name-id-and-class-anywhere-on-a-tag)
and [ADR 146](/design-notes/adr-name-sugar/).

## Event attributes

An attribute on an **element** whose name starts with `on` followed by a capital
letter or a dash is an event handler. Its value is the handler expression, and
its DOM event name is derived from the spelling:

| You write | The DOM event | Use it for |
|---|---|---|
| `onClick=handle` | `click` | ordinary DOM events |
| `onDblClick=handle` | `dblclick` | everything after `on` is lowercased |
| `onPointerDown=handle` | `pointerdown` | same rule, no special cases |
| `on-my-event=handle` | `my-event` | custom events, verbatim |
| `on-DOMContentLoaded=handle` | `DOMContentLoaded` | names camelCase cannot spell |

Two rules, and that is all:

- **`on<Name>`** — everything after `on` is **lowercased**.
- **`on-<exact>`** — everything after `on-` is taken **verbatim**. Reach for it
  when the name has capitals, dashes, dots or colons.

This is Marko's own rule, so an MX template and the equivalent Marko template
bind the same event. Each host then writes the handler in its own form — Solid
gets `onDblClick`, Angular gets `(dblclick)` — from the one resolved name, so
`onDblClick` and `on-dblclick` produce the same binding everywhere.

```mx
<button onClick=() => count++>increment</button>
<video on-loadedmetadata=start/>
<my-widget on-value-changed=sync/>
```

A name that is not event-shaped is an ordinary attribute: `onclick`, `once` and
`on` are plain data, and `<div on="x">` renders an `on` attribute.

**The value has to be an expression.** Only a handler expression makes an event
handler, so these two are ordinary attributes and render exactly as written:

```mx
<div onClick>x</div>
<div onClick="alert(1)">x</div>
```

The first is HTML's way of writing `true`; the second is an attribute string.
MX has no opinion about inline handler strings — it simply never creates one
for you out of a function.

### Events belong to elements; components get props

An `on*` attribute on a **component** — or a `<define>` call, a custom tag, a
host tag like `<try>`, or an attribute tag — is an ordinary prop, not an event:

```mx
<Row onSelect=pick/>
```

`onSelect` is passed through as the callback the component's author declared.
Components have props; elements have events. (It is the same reason `class` is
not renamed when you pass it to a component.)

### Spell the DOM name — MX has no aliases

MX never rewrites one spelling into another, because a name that silently means
something else is exactly the bug this rule prevents. React's `onDoubleClick`
lowercases to `doubleclick`, which is **not** a DOM event and which no element
ever fires. MX emits what you wrote and warns:

```mx
<button onDoubleClick=handle>x</button>
```

> ``  `onDoubleClick` is not a DOM event; did you mean `onDblClick` ``

The rule is simply this: **if the lowercased `on<Name>` is not a DOM event
name, MX warns** — and suggests the right spelling when one exists. It never
rewrites what you wrote. The warning points at the attribute name, so your
editor underlines it.

In practice that catches very little, because most React names are already
correct: `onKeyDown`, `onMouseEnter`, `onFocusIn`, `onPointerDown`,
`onTimeUpdate` and the rest all lowercase to the real DOM event and work
unchanged. Today the rule bites on just three — `onDoubleClick`, plus
`onDragExit` and `onEncrypted`, which are React-only synthetic events with no
DOM equivalent to suggest.

`on-<exact>` is never checked: naming an event MX cannot know about is exactly
what it is for. (`on-` with nothing after the dash is an error.)

### `on:click` and `oncapture:click` are not MX syntax

MX has no event modifiers. `on:*` and `oncapture:*` are handed to the host,
which rejects them with a fix-it naming the `on-<exact>` form (Solid 2, React
and Angular all do). To stop an event, call `event.preventDefault()` in the
handler; for listener options such as `capture` or `passive`, use a `ref`
callback that calls `addEventListener` itself.

### Two host differences worth knowing

These are documented rather than papered over, because hiding them would mean
guessing on your behalf:

- **The handler's arguments are the host runtime's**, not MX's. On every
  current host that means the DOM event object.
- **On hono, `onChange` binds the `input` event** (React compatibility), while
  every other host binds `change`. So the same template fires on each keystroke
  on hono and on commit elsewhere. If you need one specific behaviour, be
  explicit: write `onInput` for per-keystroke.

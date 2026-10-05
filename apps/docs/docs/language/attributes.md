---
title: "Attributes"
description: "Attribute forms on elements and components, and how event handlers are named."
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

> ``  `onDoubleClick` is not a DOM event; did you mean `onDblclick` ``

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

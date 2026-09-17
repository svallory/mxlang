---
title: "Attributes"
description: "Attribute forms on elements and components, and how event handlers are named."
---

# Attributes

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

```marko
<button onClick=() => count++>increment</button>
<video on-loadedmetadata=start/>
<my-widget on-value-changed=sync/>
```

A name that is not event-shaped is an ordinary attribute: `onclick`, `once` and
`on` are plain data, and `<div on="x">` renders an `on` attribute.

### Events belong to elements; components get props

An `on*` attribute on a **component** — or a `<define>` call, a custom tag, a
host tag like `<try>`, or an attribute tag — is an ordinary prop, not an event:

```marko
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

```marko
<button onDoubleClick=handle>x</button>
```

> ``  `onDoubleClick` is not a DOM event; did you mean `onDblclick` ``

The warning points at the attribute name, so your editor underlines it. Only
three React spellings need it — `onDoubleClick`, and `onDragExit` and
`onEncrypted`, which are React-only synthetic events with no DOM equivalent.
Every other React name you know (`onKeyDown`, `onMouseEnter`, `onFocusIn`,
`onPointerDown`, `onTimeUpdate`, …) already lowercases to the real DOM event and
works unchanged.

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

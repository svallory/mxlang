---
title: "Preact: what MX compiles to"
description: "Each MX construct and the Preact TSX it becomes; event names, keys, class values and error boundaries on the Preact host."
---

# Preact: what MX compiles to

Preact has no control-flow components, so every structural tag becomes a plain JSX expression: what you would have written by hand.

| Written | Emitted |
|---|---|
| `text`, `${expr}` | text, `{expr}` |
| `$!{expr}` as the sole child | `dangerouslySetInnerHTML={{ __html: expr }}` |
| A spread key named `dangerouslySetInnerHTML`, `innerHTML` or `outerHTML` | an escaped, lowercase attribute (never raw HTML), as Marko prints it; a literal `innerHTML=` or `outerHTML=` is the same lowercase attribute; a literal `dangerouslySetInnerHTML=` on an element is a compile error |
| `class="a"`, `.a` | `class="a"` |
| `class={ a: cond }`, `class=[…]` | `class={mxClass({ a: cond })}` |
| `style={ color: c }` | `style={{ color: c }}` |
| `onClick() { … }` | `onClick={() => { … }}` |
| `...rest` | `{...rest}` |
| `<if>` / `<else if>` / `<else>` | a conditional expression, `null` for a missing else |
| `<for\|x\| of=xs>` | `[...xs].map((x) => …)` with a `key` |
| `<for\|v, k\| in=obj>` | an `Object.entries` map, keyed by the property name |
| `<for\|i\| from=a to=b>` | a generated range map |
| `<Comp x=1>children</Comp>` | the component called with `x` and `children` |
| `<@name>` | the prop `name`; repeated tags become an array |
| `<@name\|p\|>` | the prop `name` as a function of `p` |
| `<define/Row\|p\|>` | a local function, called as `Row(p)` |
| `<${expr}>` | a dynamic tag: a component or an element name chosen at run time |
| `<try>` | `MxErrorBoundary`, with `MxPlaceholder` for `<@placeholder>` |

## Element or component?

A lowercase tag is the native element, a [discovered custom tag](/custom-tags/discovery/) or a contract child, whatever else is in scope: a `tags/badge.mx` makes `<badge/>` a component call, and an import named like an element (`import { label } from "./i18n"`) leaves `<label>` the native element. A binding in scope is called as a component only when its name is PascalCase, or through a dynamic tag, `<${label}/>`. A lowercase tag named like any local binding in scope — a `<define>`, an import of a tag module or of a value, a `<const>`, a tag param, a `static` or `export` declaration — is Marko's positioned local-variable error when the name is neither an element nor a registered tag. An element name stays the element, with a warning naming both spellings for a `<define>` or a tag-module import and silently for a value binding; a registered tag is called as usual, with no diagnostic.

A colon in a tag name is part of the name: `<uuid:id/>` is one custom tag, never a JSX namespace element. With no declaration for it, it is a compile error at the tag: ``Unable to find entry point for custom tag `<uuid:id>`.`` and the fix. Write the name without the colon, or declare the tag from an [`mx.tags` directory](/custom-tags/discovery/) with `prefix: "uuid:"`. A prefix can produce a name only when the name ends in a file stem (a letter, digit or `_`, then letters, digits, `_` or `-`): the prefix is everything before that stem, so `<a:-x/>` is `prefix: "a:-"` with `x.mx`. A name that ends otherwise (`<uuid:/>`, `<a:b$/>`) is told only to write it without the colon. An import cannot bind a colon name and a `tags/` file name cannot spell one.

## Keys

Every `<for>` row carries a `key`.

- `by="id"` keys by a field of the row. Use it for objects.
- `by=fn` keys by a function of the row and its index.
- With no `by`, the key is the row itself: the item for `of`, the property name for `in`, the number for a range.

The default is right for unique strings and numbers. It is wrong for a list with duplicates (Preact may reuse the wrong node) and for objects (a rebuilt array remounts every row). Give those a `by`.

## Events

`onClick=fn` and `onClick() { … }` bind a handler on an element. MX reads the DOM event name (the text after `on`, lowercased) and emits the prop Preact's JSX types declare for it: `onClick=f` is `onClick={f}`, `onKeydown=f` and `on-keydown=f` are both `onKeyDown={f}`, and `onDblClick=f` and `on-dblclick=f` are both `onDblClick={f}`, which Preact binds to `dblclick`.

- **Only names Preact declares.** A DOM event Preact's types have no handler prop for is a compile error, never a prop the types reject or Preact ignores. That includes `onDoubleClick` (`doubleclick` is not a DOM event; MX also warns): write `onDblClick`. It also includes `on-fullscreenchange`, which only Hono's types declare.
- **Custom DOM events** (`on-my-event=f`) are a compile error on React, Preact and Hono alike, so one source never works on one and fails on another. Use a `ref` callback that calls `addEventListener`.
- **On a component**, `onSelect=pick` is an ordinary prop.
- `on:click` is not MX syntax; the error names `onClick`.

The handler receives the DOM event. The shared rules are in [Attributes](/language/attributes/#attributes-event-attributes).

## `<try>`: error and loading states

```mx
<try>
  <Profile id=userId/>
  <@placeholder><p>Loading…</p></@placeholder>
  <@catch|err|><p.error>${err.message}</p></@catch>
</try>
```

Preact has no error boundary component, so the host ships one: `<@catch>` becomes `MxErrorBoundary`, a class component using `componentDidCatch`, and `<@placeholder>` becomes `MxPlaceholder`, which is `preact/compat`'s `Suspense`. Both come from `@mxlang/host-preact/runtime` and are imported only when used. With both present, the placeholder sits inside the boundary, so a render error reaches the catch.

The body is handed to the boundary as a function, so a throw written directly in the `<try>` body is caught with the real error, and none of the partial body is rendered. A descendant component's throw is caught during a server render as well: `MxErrorBoundary` sets `options.errorBoundaries`, which `preact-render-to-string` needs before it runs boundaries. That flag is a process-global of your `preact`: once a `<try>` with `<@catch>` renders, it applies to every class component's error boundary, not only MX's.

## What is an error

Anything Preact cannot express fails the build with the construct and its line; nothing degrades silently.

- Marko's stateful tags, each naming the hook: `<let>` (`useState`), `<effect>` (`useEffect`), `<id>` (`useId`), `<lifecycle>`, `<script>`, and `:=`.
- `<await>`, a `client` block, and `<!doctype html>` (it belongs to the HTML page that mounts the app).
- A raw `$!{…}` with siblings: the prop replaces the whole subtree, so it must be the only child.
- A dynamic `style` that is not an object literal (`style=s`). A static string is fine.

## Children and `content`

MX calls a component with `children`, the JSX way, passing a body exactly as hand-written JSX would pass it, so hand-written Preact components work unchanged. A whole-file `.mx` component that reads Marko's `input.content` receives the same value.

## Data in a text placeholder

`${expr}` holding a plain object (JSON from a request, say) renders nothing on Preact, where Marko prints `[object Object]`. Preact drops an object that is not a vnode, so MX keeps that behaviour: data never becomes markup, on the server or in the browser. Pass a string, a number or a vnode, or call `JSON.stringify` yourself to print data.

Preact's server renderer takes any object with no `constructor` for a vnode, so a null-prototype object shaped like one (what `qs` builds with `plainObjects`) would render as an element there while the browser renders nothing. MX therefore hands each placeholder to a small check that lets through strings, numbers, vnodes, class instances and arrays of them, and drops every other object. A vnode is told apart by its own `constructor: undefined`, which JSON cannot carry. Data decoded by a library that keeps `undefined` (`devalue`, `superjson`, `structuredClone`) can imitate one, so do not pass it to a placeholder.

## Data as a dynamic tag

`<${expr}>` holding data works as in Marko: a string is an element name, a component is called, a vnode passes through, and any other plain object (JSON from a request, say) renders nothing. A vnode is told apart by its own `constructor: undefined`, which JSON cannot carry. Data decoded by a library that keeps `undefined` (`devalue`, `superjson`, `structuredClone`) can imitate one, so do not pass it as a dynamic tag.

## Attribute tags on your own components

> **Being replaced.** This describes the attribute-tag shape that ships
> today. MX is moving to Marko's attribute-tag record with extra prototype
> members (`map`, `filter`, `length`, `at`, `toArray`) on every target, so
> cardinality stops depending on the `Input` declaration
> ([specification §8](/specification/) is normative).

Export an `Input` type from the component and mark the markup props with `AttrTag` from `@mxlang/host-preact`. A renderable is `ComponentChildren`; with `params` it is a function returning one; `AttrTag[]` is a real array. With no declaration, MX infers the shape from the call. [AttrTag](/language/attr-tag/) has a hand-written Preact component and a worked example.

## How this is checked

`bun run oracle:preact` renders the shared fixture set with `preact-render-to-string` and compares it with Marko's own output on every CI run. `examples/preact-app` is driven in a real browser.

---
title: "Solid: what MX compiles to"
description: "Each MX construct and the Solid 2 JSX it becomes: every <for> form, <if> chains, events, <try>, children, attribute tags, and the errors."
---

# Solid: what MX compiles to

Each MX region compiles to Solid 2 JSX at the same position in the file, and Solid's own compiler takes it from there. The control-flow components (`For`, `Show`, `Switch`, `Match`, `Repeat`, `Loading`, `Errored`) are imported for you.

## Markup

| Written | Emitted |
|---|---|
| `text`, `${expr}` | text, `{expr}` |
| `$!{expr}` | `innerHTML={expr}`; it must be the only child |
| A spread key named `innerHTML`, `outerHTML`, `textContent` or `innerText` | an escaped, lowercase attribute (never raw HTML), as Marko prints it; `prop:innerHTML`, `prop:outerHTML` and an object `children` are dropped; a literal `innerHTML=` on an element is a compile error, so write `$!{html}` |
| `.cls`, `#id` | `class="cls"`, `id="id"`; beside any `class=` value it is `class={["cls", value]}`, shorthand first, as in Marko; a native element prints the joined string (numbers and `true` as text, falsy values skipped) |
| `class={ a: on() }` | `class={{ a: on() }}` (no `classList`) |
| `prop:name=value` | `prop:name={value}` |
| a component | a JSX element; ordinary children are `props.children` |
| `<Tag\|a, b\|>body</Tag>` | `<Tag>{(a, b) => body}</Tag>` |
| `<@name>` on a component | the prop `name`, as an accessor |
| `<if>` with one or two branches | `<Show when fallback>` |
| `<if>` chain with three or more | `<Switch fallback><Match when>…</Match></Switch>` |
| `<try>` | `<Loading fallback>`, inside `<Errored fallback>` when there is a `<@catch>` (`<@catch\|e, reset\|>` may name the second parameter; there is no sugar for `<Reveal>`, write the component); Solid's `Errored` fallback receives an `ErrorAccessor` function, so the lowering calls it once and passes the result to an inner arrow whose parameter list is the author's `<@catch>` params verbatim — `<Errored fallback={(__mxErr, ...__mxArgs) => ((e, reset) => …)(__mxErr(), ...__mxArgs)}>`, so defaults, type annotations, destructuring and rest all stay valid (a param-less catch keeps a plain body fallback) |

A colon in a tag name is part of the name: `<uuid:id/>` is one custom tag, never a JSX namespace element. With no declaration for it, it is a compile error at the tag: ``Unable to find entry point for custom tag `<uuid:id>`.`` and the fix. Write the name without the colon, or declare the tag from an [`mx.tags` directory](/custom-tags/discovery/) with `prefix: "uuid:"`. A prefix can produce a name only when the name ends in a file stem (a letter, digit or `_`, then letters, digits, `_` or `-`): the prefix is everything before that stem, so `<a:-x/>` is `prefix: "a:-"` with `x.mx`. A name that ends otherwise (`<uuid:/>`, `<a:b$/>`) is told only to write it without the colon. An import cannot bind a colon name and a `tags/` file name cannot spell one.

## `<for>`

| Written | Emitted |
|---|---|
| `<for\|item, i\| of=xs()>` | `<For each={xs()}>{(item, i) => …}</For>` |
| `<for\|item, i\| of=xs() by=identity>` | `<For each={xs()}>…</For>`; `identity` needs no import |
| `<for\|item, i\| of=xs() by="id">` | `<For each={xs()} keyed={x => x.id}>…</For>` |
| `<for\|item, i\| of=xs() by=fn>` | `<For each={xs()} keyed={fn}>…</For>` |
| `<for\|k, v\| in=obj()>` | `<For each={Object.entries(obj() ?? {})} keyed={e => e[0]}>…</For>` |
| `<for\|i\| from=a to=b>` | `<Repeat count={(b) - (a) + 1} from={a}>{(i) => …}</Repeat>` |
| `<for\|i\| from=a until=b>` | `<Repeat count={(b) - (a)} from={a}>…</Repeat>` |
| `<for\|i\| to=b>` | `<Repeat count={(b) - (0) + 1}>`: `from` is emitted only when you wrote it |
| `<for\|i\| from=a to=b step=s>` | `<Repeat count={N}>`, with `i` computed as `a + k * s` from the row index `k` |

Without `by=`, rows are keyed by reference and the body receives plain values. Solid hands some parameters in as accessors: the index in the `of=` forms, both parameters under `by=`, and the `in=` entry. You still write `member.name`: MX rewrites each read to call the accessor (`member().name`), so it stays tracked. Assigning to such a parameter is a compile error.

When both bounds are numeric literals, `count` is folded to a literal.

Keep `from`, `to`, `until` and `step` pure (a signal, a literal or a memo): they are read like any other Solid attribute, and a stepped range tracks its bounds like an unstepped one. Negative steps are allowed. A literal `step=0` is a compile error; a `step` that is `0` at run time renders no rows.

## Children

MX passes a component's body as `props.children`, so a hand-written Solid component called from MX, and a `.solid.mx` component called from TSX, both work. In a `.solid.mx` file you read `props.children`, as in any Solid component.

## Data in a text placeholder

Pass only strings, numbers or nodes to `${expr}`. On Solid's server renderer a rendered node is a plain `{ t: ... }` object, and `@solidjs/web` writes its `t` unescaped, exactly as in hand-written Solid. An object of that shape that came from JSON (`{ t: "<b>x</b>" }`) is therefore written as markup, where Marko prints `[object Object]`. MX cannot tell such an object from a real node, because `${props.children}` and a component's return value have the same shape, so this stays open until Solid marks its rendered nodes. Never pass request data in an object to a text placeholder on Solid SSR; pick the field you want to print.

## Attribute tags

> **Being replaced.** This describes the attribute-tag shape that ships
> today. MX is moving to Marko's attribute-tag record with extra prototype
> members (`map`, `filter`, `length`, `at`, `toArray`) on every target, so
> cardinality stops depending on the `Input` declaration
> ([specification §8](/specification/) is normative).

Solid's renderable is an accessor, `() => JSX.Element`, and that is what an attribute tag delivers.

```tsx
import type { AttrTag } from "@mxlang/host-solid";

export interface Input {
  header: AttrTag<{ as: "renderable" }>;                    // () => Element
  row: AttrTag<{ as: "renderable"; params: [name: string] }>; // (name) => () => Element
}
```

In TSX, render them with `{props.header()}` and `{props.row("Ada")()}`. In MX, with a dynamic tag: `<${input.header}/>` and `<${input.row("Ada")}/>`. Without `as: "renderable"` the prop is a data object, `{ ...attrs, content }`, and `content` is the accessor. The compiler reports a parameterized tag rendered without its arguments. The full contract is in [AttrTag](/language/attr-tag/).

## Events

`onClick=fn` and `onClick() { … }` bind a handler on an element. MX reads the DOM event name (the text after `on`, lowercased) and emits Solid's own prop for it: `onDblClick=f` and `on-dblclick=f` are both `onDblClick={f}`, and `onKeydown=f` is `onKeyDown={f}`.

- **Spell the DOM name.** `onDoubleClick` is not a DOM event, so MX warns and emits `onDoubleclick`, which binds nothing useful. Write `onDblClick`.
- **Custom DOM events** (`on-my-event=f`) are a compile error: Solid has no prop for them. Use a `ref` callback that calls `addEventListener`.
- **On a component**, `onSelect=pick` is an ordinary prop.

The handler receives the DOM event. The shared rules are in [Attributes](/language/attributes/#attributes-event-attributes).

## What is an error

| Written | Why | Write instead |
|---|---|---|
| `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `:=` | State is Solid's | `createSignal`, `createEffect`, an explicit handler, in the TypeScript around the region |
| `<const>`, `import`, `static` in a region | A region is an expression | Write them in the module |
| `<define>` inside `<if>`, `<for>` or an attribute tag, or one that reads a value the region introduced | It is hoisted to module scope | Make it a direct child of the region, and pass what it needs as params |
| `on:x` | Removed in Solid 2, and Marko rejects it too | `onX=fn` for a delegated event, or `on-x=fn` for a custom event name |
| `<if\|u\|=cond>`, `<@name>` on an HTML element, `<fragment>` | Marko rejects them too | A TSX fragment `<>…</>` for a wrapper. See [Divergences](/divergences-and-mx-2/) |

`oncapture:x`, `attr:x`, `bool:x` and `use:x` are not errors: as in Marko, each is an ordinary attribute that keeps its full name. Only `prop:` has a meaning of its own on Solid (a property write).

## Whole-file `.mx` on Solid

A plain `.mx` compiles to a Solid component when `package.json` has `"mx": { "host": "solid" }` (or `mx.target: "solid-jsx"`). `.solid.mx` needs neither: its extension selects the host. In a whole-file component the body is `input.content`, Marko's name for it (an explicit `content=` prop wins over children), and `<if=input.content>` is true when a body was passed. Top-level `import` statements work as in a whole-file `.mx` on any other host, and the Vite plugin, the TypeScript plugin and the language server all compile the file as a Solid component, never as a region file or with the HTML target.

## How this is checked

`bun run oracle` compiles every fixture twice, as MX and as a hand-written Solid twin, through both Solid 2 compilers (Babel and Oxc), and compares the generated code.

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
| `.cls`, `#id` | `class="cls"`, `id="id"`; beside `class={…}` it is `class={["cls", {…}]}` |
| `prop:name=value` | `prop:name={value}` |
| a component | a JSX element; ordinary children are `props.children` |
| `<Tag\|a, b\|>body</Tag>` | `<Tag>{(a, b) => body}</Tag>` |
| `<@name>` on a component | the prop `name`, as an accessor |
| `<if>` with one or two branches | `<Show when fallback>` |
| `<if>` chain with three or more | `<Switch fallback><Match when>…</Match></Switch>` |
| `<try>` | `<Loading fallback>`, inside `<Errored fallback>` when there is a `<@catch>` |

## `<for>`

| Written | Emitted |
|---|---|
| `<for\|item, i\| of=xs()>` | `<For each={xs()}>{(item, i) => …}</For>` |
| `<for\|item, i\| of=xs() by="id">` | `<For each={xs()} keyed={x => x.id}>…</For>` |
| `<for\|k, v\| in=obj()>` | `<For each={Object.entries(obj())} keyed={e => e[0]}>…</For>` |
| `<for\|i\| from=a to=b>` | `<Repeat count={(b) - (a) + 1} from={a}>{(i) => …}</Repeat>` |
| `<for\|i\| from=a until=b>` | `<Repeat count={(b) - (a)}>…</Repeat>` |
| `<for\|i\| from=a to=b step=s>` | `<Repeat count={N}>`, with `i` computed from the row index |

With `by`, Solid hands the row and the index to the child as accessors. You still write `member.name`: MX rewrites each read to call the accessor, so it stays tracked.

Keep `from`, `to`, `until` and `step` pure (a signal, a literal or a memo): they are read like any other Solid attribute. A `step` of `0` at run time renders no rows.

## Children: `props.children` and `input.content`

MX passes a component's body as `props.children`, so a hand-written Solid component called from MX, and an MX component called from TSX, both work. Inside a `.solid.mx` component, `input.content` is Marko's name for the same body (an explicit `content=` prop wins over children). `<if=input.content>` is true when a body was passed.

## Attribute tags

Solid's renderable is an accessor, `() => JSX.Element`, and that is what an attribute tag delivers.

```tsx
import type { AttrTag } from "@mxlang/solid";

export interface Input {
  header: AttrTag<{ as: "renderable" }>;                    // () => Element
  row: AttrTag<{ as: "renderable"; params: [name: string] }>; // (name) => () => Element
}
```

In TSX, render them with `{props.header()}` and `{props.row("Ada")()}`. In MX, with a dynamic tag: `<${input.header}/>` and `<${input.row("Ada")}/>`. Without `as: "renderable"` the prop is a data object, `{ ...attrs, content }`, and `content` is the accessor. The compiler reports a parameterized tag rendered without its arguments. The full contract is in [AttrTag](/language/attr-tag/).

## Events

`onClick=fn` and `onClick() { … }` bind a handler on an element. MX reads the DOM event name (the text after `on`, lowercased) and emits `on` plus that name capitalized: `onDblClick=f` and `on-dblclick=f` are both `onDblclick={f}`, which Solid binds to `dblclick`.

- **Spell the DOM name.** `onDoubleClick` is not a DOM event, so MX warns and emits it as written.
- **Custom DOM events** (`on-my-event=f`) are a compile error: Solid has no prop for them. Use a `ref` callback that calls `addEventListener`.
- **On a component**, `onSelect=pick` is an ordinary prop.

The handler receives the DOM event. The shared rules are in [Attributes](/language/attributes/#attributes-event-attributes).

## What is an error

| Written | Why | Write instead |
|---|---|---|
| `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `:=` | State is Solid's | `createSignal`, `createEffect`, an explicit handler, in the TypeScript around the region |
| `<define>`, `<const>`, `import`, `static` in a region | A region is an expression | Write them in the module |
| `on:x`, `oncapture:x`, `attr:x`, `bool:x`, `use:x` | Removed in Solid 2 | `onX=fn`; a `ref` callback for capture; the plain attribute; `ref=foo(opts)` |
| `<if\|u\|=cond>`, `<@name>` on an HTML element, `<fragment>` | Marko rejects them too | A TSX fragment `<>…</>` for a wrapper. See [Divergences](/divergences-and-mx-2/) |

## Whole-file `.mx` on Solid

A plain `.mx` compiles to a Solid component when `package.json` has `"mx": { "host": "solid" }` (or `mx.target: "solid-jsx"`). `.solid.mx` needs neither: its extension selects the host.

## How this is checked

`bun run oracle` compiles every fixture twice, as MX and as a hand-written Solid twin, through both Solid 2 compilers (Babel and Oxc), and compares the generated code.

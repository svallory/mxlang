---
title: "AttrTag"
description: "Declare named blocks with explicit cardinality, data or renderable values, parameters, nesting, and host-specific content types."
---

# AttrTag

An attribute tag is a named block inside a component call. `<@tab>` becomes
the `tab` property received by the component, while ordinary children remain
the component's `content` (or JSX `children`). The callee owns the contract:
its exported `Input` marks attribute-tag properties with `AttrTag`.

`AttrTag` is ambient inside `.mx` files. Generated code imports the specialized
type from the active host package. In hand-written TypeScript or TSX, import it
from that package yourself, such as `@mxlang/html`, `@mxlang/preact`,
`@mxlang/react`, `@mxlang/hono`, `@mxlang/solid`, `@mxlang/astro`, or
`@mxlang/angular`. The generic `AttrTag`, `AttrTagOf`, and `AttrTagConfig` are
also exported by `@mxlang/core` for host authors.

## The config

`AttrTag<C>` takes one config object. `AttrTagConfig` is the constraint:
`{ as?: "data" | "renderable"; attrs?: object; params?: readonly unknown[] }`.

| Field | Default | Meaning |
| --- | --- | --- |
| `as` | `"data"` | Chooses the value the callee receives. |
| `attrs` | `{}` | Declares attributes accepted on `<@name>` and any nested `AttrTag` properties. |
| `params` | `[]` | A tuple of parameters declared between pipes, such as `[row: Row, index: number]`. |

The config must be syntactically readable. Literal object types and resolvable
type aliases work; conditional, mapped, intersection, and otherwise evaluated
configs do not. `params` must be a tuple, not `string[]`. The resulting errors
are `declare this attribute tag's config literally` and
`attribute tag params must be a tuple type`.

## Cardinality belongs to the property

Cardinality is not a config field:

| Declaration | Accepted calls | Received value |
| --- | --- | --- |
| `head?: AttrTag<C>` | zero or one `<@head>` | `undefined` or one value |
| `head: AttrTag<C>` | exactly one `<@head>` on every path | one value |
| `head: AttrTag<C>[]` | zero or more, including inside `<for>` | always a real array, including `[]` |

The compiler reports these exact messages:

| Violation | Message |
| --- | --- |
| A singular tag occurs twice | `` `<@head>` may appear at most once (`head` is declared `AttrTag`, not `AttrTag[]`) `` |
| A singular tag is inside `<for>` | `` `<@head>` may not appear inside `<for>` (`head` is declared `AttrTag`, not `AttrTag[]`) `` |
| A required tag is absent | `` missing required attribute tag `<@head>` `` |
| A required tag is missing from any conditional path | `` `<@head>` is required but not provided on every `<if>` path `` |

An optional singular tag may occur once in every mutually exclusive
`<if>`/`<else-if>`/`<else>` branch because only one branch is selected. A
required singular needs a final `else` or another occurrence outside the
conditional so that every path supplies it.

## Data and renderable values

The default, `as: "data"`, receives an object shaped as
`{ ...attrs, ...nestedTags, content }`. `content` is optional because a data tag
may be bodiless. Render its body with `<${input.head.content}/>`; rendering the
object itself as `<${input.head}/>` is an error with the exact fix-it:
`` `input.head` is a data attribute tag; render its body with
`<${input.head.content}/>` ``.

`as: "renderable"` receives the body itself and is rendered with
`<${input.head}/>` (or the host's native equivalent). It cannot declare
`attrs`, accept authored attributes, or contain nested attribute tags: a bare
renderable has nowhere to carry that data. React elements, for example, are
not mutable records. The declaration error is exactly
`renderable attribute tags can't take attributes; declare as: "data"`.

At runtime, passing a real data value to a dynamic renderer is guarded too:
`MX: this value is a data attribute tag ({ ...attrs, content }); render its
body with <${x.content}/>`.

## Params make render functions

`params` describes the names and types that must appear between pipes at the
call site. In data mode the function is stored in `.content`; in renderable
mode the property itself is the function.

| Declaration | Caller | Callee |
| --- | --- | --- |
| `row: AttrTag<{ params: [row: Row] }>` | `<@row|row|>…</@row>` | `<${input.row.content(item)}/>` |
| `row: AttrTag<{ as: "renderable"; params: [row: Row] }>` | `<@row|row|>…</@row>` | `<${input.row(item)}/>` |

The caller gets `` `<@row>` declares params in `<Table>`; add `|…|` `` when it
omits pipes, and `` `<@row>` declares no params in `<Table>`; remove `|…|` ``
when it invents them. Rendering a known parameterized value without calling it
is also rejected, for example: `` `input.row.content` is a parameterized
attribute tag; pass its arguments with
`<${input.row.content(/* arguments */)}/>` ``.

Solid adds one layer: its renderable is an accessor. A parameterized data tag
there is `(p) => () => JSX.Element`, so call it and then render the returned
accessor: `<${input.row.content(item)}/>`.

## Control flow and nesting

Attribute tags may sit inside `<if>` and `<for>` directly under a component
call. A control-flow body must contain attribute tags or ordinary content, not
both; mixing them produces exactly `Cannot have attribute tags and body content
under a control flow tag.` An array declaration is required for a tag that can
repeat or appears in a loop.

Nested attribute tags are declared recursively inside `attrs`. Cardinality,
shape, params, conditionals, loops, and errors apply again at every level. All
occurrences of the same property get one stable nested plan: if one `<@tab>`
has an attributed `<@icon>`, every `tab.icon` occurrence is data-shaped; if one
occurrence repeats `<@icon>`, every `tab.icon` is an array. Sibling properties
with the same nested name are independent.

`content` is reserved as an authored attribute because it already names the
body. The exact diagnostic is `` `content` is reserved on an attribute tag; it
names the body ``.

## How the caller finds `Input`

The caller reads the callee's type syntax without running a TypeScript program:

- `Input` in the same `.mx` file and an exported `Input` in imported `.mx`,
  `.ts`, `.tsx`, or `.solid.mx` files are supported. Script components must
  export the name `Input`; `Props`, a function parameter annotation, and an
  unexported interface are intentionally ignored.
- Type aliases and imported aliases are followed, including nested `AttrTag`
  configs. Resolution tries the tool's synchronous `resolveImport` hook first,
  then relative files and package resolution.
- If an import cannot be resolved, compilation continues with the fallback and
  warns: `` couldn't read `<Card>`'s Input (`@app/Card` not resolvable);
  attribute-tag shape inferred from this call ``. Bundlers and editor tooling
  use `resolveImport` for aliases so they do not need that fallback.
- A resolved component with an unknown extension is untyped unless its host
  registered a reader. It is not parsed as TypeScript or MX by guesswork.

For an untyped, unresolved, or dynamic callee, MX infers cardinality and shape
from the whole call. A property is singular when at most one occurrence can be
selected on a path, and an array when it repeats or appears in `<for>`. Under
decision 108 it is a bare renderable when none of its occurrences has
attributes or nested tags. If any occurrence has either, every occurrence is
data-shaped. This keeps library patterns such as
`<Suspense><@fallback>Loading…</@fallback>…</Suspense>` working. A declared
`Input` remains authoritative and still defaults to data.

## Host values and limits

| Host | `content` / renderable | Notes |
| --- | --- | --- |
| HTML | `() => string`; with params, `(...p) => string` | A thunk, not an already-rendered string. |
| Preact | `ComponentChildren`; params return `ComponentChildren` | Data objects and real arrays are ordinary JSX props. |
| React | `ReactNode`; params return `ReactNode` | Same structural lowering as Preact. |
| Hono | `Child`; params return `Child` | Same structural lowering as Preact. |
| Solid | reusable `() => SolidElement`; params produce `(…p) => () => SolidElement` | Render the accessor with a dynamic tag or Solid's `<Dynamic>`. |
| Astro | named-slot `() => string` thunk, exposed directly for renderable and as `.content` for data | Projection only. Arrays, attrs, params, nested tags, and bodiless tags are errors. |
| Angular | content projection; no class value (`AttrTag<C>` is `never`) | `${input.x()}`, `${input.x.content()}`, `<${input.x.content}/>` and renderable `<${input.x}/>` become `<ng-content>`. Other value reads are errors. Arrays, attrs, params, nested tags, and bodiless tags are errors. |

Astro and Angular support mutually exclusive conditional projections, because
only one projection is emitted. They cannot represent repeated/looped values.

## Hand-written JSX and TSX components

A hand-written component called from MX exports `Input`, imports `AttrTag` from
its host package, and reads the same shapes. Here a Preact component receives
a data object, its `.content`, and an array:

<!-- attr-tag-example: handwritten-preact preact Tabs.tsx -->
```tsx
import type { AttrTag } from "@mxlang/preact";

export interface Input {
  title: string;
  tab: AttrTag<{ attrs: { label: string } }>[];
}

export default function Tabs(props: Input) {
  return (
    <section>
      <h2>{props.title}</h2>
      {props.tab.map((tab) => (
        <button>{tab.label}: {tab.content}</button>
      ))}
    </section>
  );
}
```

<!-- attr-tag-example: handwritten-preact preact App.mx -->
```mx
import Tabs from "./Tabs.tsx"

<Tabs title="Account">
  <@tab label="Profile">Edit</@tab>
  <@tab label="Security">Review</@tab>
</Tabs>
```

The same pattern uses `@mxlang/react` in React and `@mxlang/hono` in Hono.
When consuming an MX-generated component from JSX/TSX, import that component
normally; its exported `Input` already exposes these host-specialized prop
types.

## Worked examples

These examples are extracted from this page, compiled as real multi-file
programs, and rendered in the HTML and Preact test suites.

### Tabs: a repeated data tag

<!-- attr-tag-example: tabs both Tabs.mx -->
```mx
export interface Input {
  tab: AttrTag<{ attrs: { label: string; selected?: boolean } }>[];
}

<nav>
  <for|tab| of=input.tab>
    <button data-selected=String(tab.selected ?? false)>
      ${tab.label}: <${tab.content}/>
    </button>
  </for>
</nav>
```

<!-- attr-tag-example: tabs both App.mx -->
```mx
import Tabs from "./Tabs.mx"

<Tabs>
  <@tab label="Overview" selected>Summary</@tab>
  <if=input.showSettings>
    <@tab label="Settings">Preferences</@tab>
  </if>
  <for|project| of=input.projects>
    <@tab label=project>${project}</@tab>
  </for>
</Tabs>
```

### Layout: renderable slots

<!-- attr-tag-example: layout both Layout.mx -->
```mx
export interface Input {
  header: AttrTag<{ as: "renderable" }>;
  footer?: AttrTag<{ as: "renderable" }>;
}

<header><${input.header}/></header>
<main><${input.content}/></main>
<if=input.footer><footer><${input.footer}/></footer></if>
```

<!-- attr-tag-example: layout both App.mx -->
```mx
import Layout from "./Layout.mx"

<Layout>
  <@header><h1>Dashboard</h1></@header>
  <@footer>© MX</@footer>
  <p>Welcome.</p>
</Layout>
```

### Table: a row render function

<!-- attr-tag-example: table both Table.mx -->
```mx
export type Row = { name: string };
export interface Input {
  rows: Row[];
  row: AttrTag<{ as: "renderable"; params: [row: Row, index: number] }>;
}

<table><tbody>
  <for|row, index| of=input.rows>
    <${input.row(row, index)}/>
  </for>
</tbody></table>
```

<!-- attr-tag-example: table both App.mx -->
```mx
import Table from "./Table.mx"

<Table rows=input.rows>
  <@row|row, index|>
    <tr><td>${index}</td><td>${row.name}</td></tr>
  </@row>
</Table>
```

### Nested tabs and icons

<!-- attr-tag-example: nested both Tabs.mx -->
```mx
export interface Input {
  tab: AttrTag<{
    attrs: {
      label: string;
      icon?: AttrTag<{ as: "renderable" }>;
    };
  }>[];
}

<ul><for|tab| of=input.tab>
  <li><${tab.icon}/> ${tab.label}: <${tab.content}/></li>
</for></ul>
```

<!-- attr-tag-example: nested both App.mx -->
```mx
import Tabs from "./Tabs.mx"

<Tabs>
  <@tab label="Files">
    <@icon>📁</@icon>
    Browse
  </@tab>
</Tabs>
```

## Marko 6 compared with MX

| Question | Marko 6 | MX |
| --- | --- | --- |
| Repeated value | One iterable `attrTag`/`attrTags` record; a single tag is iterable too. | The `Input` property chooses one value or a real array. |
| Attributes on repeats | Direct property reads expose the first occurrence's attributes; iteration reaches every occurrence. | Every array item owns its own attrs, nested tags, and `content`. |
| Unused attributes | The compiler can tree-shake attributes the callee never reads. | Every authored attribute is passed. |
| No declaration | Marko's runtime shape applies. | Decision 108 uses a bare renderable for body-only occurrences, data when any occurrence carries attrs/nested tags, and infers single versus array separately. |

For Marko authors migrating a component, declare every named block in
`Input`. Use `AttrTag[]` anywhere Marko code iterated a tag, replace direct
body rendering of a data tag with `.content`, and choose `as: "renderable"`
only for body-only render-prop APIs. Code that relied on the first repeated
tag's attributes should instead select an explicit array item. Do not remove
"unused" authored attributes expecting Marko's tree-shaking; MX intentionally
passes them through.

See [Attribute tags and tag params](/language/attribute-tags-and-params/) for
the syntax overview and [Errors](/language/errors/#attribute-tag-errors) for
the complete diagnostic catalog.

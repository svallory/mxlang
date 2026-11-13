---
title: "AttrTag"
description: "The attribute-tag record a component receives: Marko's record, with map, filter, length, at and toArray, typed by AttrTag<T>."
---

# AttrTag

An attribute tag is a named block inside a component call. `<@tab>` becomes
the `tab` property received by the component, while ordinary children remain
the component's `content` (or JSX `children`).

Every value host (HTML, Preact, React, Hono, Solid) passes the callee
Marko's attribute-tag record ([specification §8](/specification/) is
normative):

- One `<@tab label="A">Body</@tab>` gives an object holding its attributes as
  own properties (`label`) plus `content`, the body.
- A repeated `<@tab>` gives the **first** occurrence's object; every later
  occurrence is reachable from it. A property read (`input.tab.label`) reads
  the first occurrence; iteration (`for of`, `[...input.tab]`) yields every
  occurrence in source order.
- An attribute tag the call never writes is `undefined`.

MX adds five members on the record's prototype: `map`, `filter` (both return
plain arrays; the callback gets `(item, index)`), `length`, `at` (a negative
index counts from the end, as `Array.prototype.at`) and `toArray`. They are
not own properties, so a spread or `JSON.stringify` never sees them, and
Marko-written callee code runs unchanged.

The value never depends on the callee's types. The same call compiles to the
same output whatever the callee declares: one occurrence, several, inside
`<if>` or `<for>`, it is always the record.

## Typing it: `AttrTag<T>`

`AttrTag<T>` is the record's type: `T`, the attributes of one occurrence, plus
`[Symbol.iterator]`, `length`, `at`, `map`, `filter` and `toArray`. It is
assignable to Marko's `Marko.AttrTag<T>`.

`AttrTag` is ambient inside `.mx` files. Generated code imports it from the
active host package. In hand-written TypeScript or TSX, import it from that
package yourself, such as `@mxlang/target-html`, `@mxlang/host-preact`,
`@mxlang/host-react`, `@mxlang/host-hono` or `@mxlang/host-solid`. A host's
`AttrTag<T>` adds that host's `content` type unless `T` declares its own;
the generic `AttrTag<T>` from `@mxlang/core` adds none.

| Declaration | Meaning |
| --- | --- |
| `head?: AttrTag` | An optional body-only tag. |
| `head: AttrTag` | A tag the caller must write. |
| `tab: AttrTag<{ label: string }>` | A tag with a `label` attribute; zero, one or many occurrences all type the same. |
| `row: AttrTag<{ content: (row: Row) => … }>` | A tag whose body takes params, `<@row|row|>`. |

The callee's `Input` types the record for the type checker and the editor
tools (`mx-tsc`, the language server, the TypeScript plugin): a call that
does not match it is a type error there, not a compile error. A custom tag's
sidecar contract (`attributeTags`, with `required` and `repeatable`) is still
checked by the compiler.

## The body: `content`

`content` is the body, in the host's shape (table below). Render it with
`<${input.head.content}/>`, or render the record itself, `<${input.head}/>`:
a dynamic tag given a record renders its `content`, as Marko does. A record
whose tag had no body (`<@head/>`) has no `content`, so a dynamic tag given it
renders nothing of its own (only the call's own body, if any), as Marko does.

With params, `<@row|row, index|>…</@row>` makes `content` a function of them:
the callee passes the arguments as tag arguments,
`<${input.row.content}(row, index)/>`. On Solid, `content` is an accessor, so
a parameterized one is called where it renders,
`<${input.row.content(row, index)}/>`.

`content` is reserved as an authored attribute because it already names the
body. The exact diagnostic is `` `content` is reserved on an attribute tag; it
names the body ``.

## Control flow and nesting

Attribute tags may sit inside `<if>` and `<for>` directly under a component
call; each occurrence a branch or an iteration produces joins the record in
source order. A control-flow body must contain attribute tags or ordinary
content, not both; mixing them produces exactly `Cannot have attribute tags
and body content under a control flow tag.`

Nested attribute tags are records on their parent's record, by the same rule:
`<@tab><@icon>📁</@icon>Files</@tab>` gives `input.tab.icon`, a record.

## Host values and limits

| Host | `content` | Notes |
| --- | --- | --- |
| HTML | `() => string`; with params, `(...p) => string` | A thunk, not an already-rendered string. |
| Preact | `ComponentChildren`; params return `ComponentChildren` | The record is an ordinary JSX prop. |
| React | `ReactNode`; params return `ReactNode` | Same lowering as Preact. |
| Hono | `Child`; params return `Child` | Same lowering as Preact. |
| Solid | reusable `() => SolidElement`; params produce `(…p) => () => SolidElement` | Render the accessor with a dynamic tag or Solid's `<Dynamic>`. |
| Astro | named-slot `() => string` thunk, exposed directly and as `.content` | Projection only. Repeats, attrs, params, nested tags, and bodiless tags are errors. |
| Angular | content projection; no class value (`AttrTag` is `never`) | `${input.x()}`, `${input.x.content()}`, `<${input.x.content}/>` and `<${input.x}/>` become `<ng-content>`. Other value reads are errors. Repeats, attrs, params, nested tags, and bodiless tags are errors. |

Astro and Angular support mutually exclusive conditional projections, because
only one projection is emitted. They cannot represent repeated or looped
values.

An own attribute named like a prototype member (`<@item length=3>`) shadows
it on that occurrence, as any own property shadows its prototype's.

## Hand-written JSX and TSX components

A hand-written component called from MX exports `Input`, imports `AttrTag` from
its host package, and reads the record. Here a Preact component maps over
every `<@tab>`:

<!-- attr-tag-example: handwritten-preact preact Tabs.tsx -->
```tsx
import type { AttrTag } from "@mxlang/host-preact";

export interface Input {
  title: string;
  tab: AttrTag<{ label: string }>;
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

The same pattern uses `@mxlang/host-react` in React and `@mxlang/host-hono` in Hono.
When consuming an MX-generated component from JSX/TSX, import that component
normally; its exported `Input` already exposes these host-specialized prop
types.

## Worked examples

These examples are extracted from this page, compiled as real multi-file
programs, and rendered in the HTML and Preact test suites.

### Tabs: a repeated tag

<!-- attr-tag-example: tabs both Tabs.mx -->
```mx
export interface Input {
  tab: AttrTag<{ label: string; selected?: boolean }>;
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

### Layout: rendering a record

<!-- attr-tag-example: layout both Layout.mx -->
```mx
export interface Input {
  header: AttrTag;
  footer?: AttrTag;
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

### Table: a body with params

<!-- attr-tag-example: table both Table.mx -->
```mx
export type Row = { name: string };
export interface Input {
  rows: Row[];
  row: AttrTag<{ content: (row: Row, index: number) => unknown }>;
}

<table><tbody>
  <for|row, index| of=input.rows>
    <${input.row.content}(row, index)/>
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
  tab: AttrTag<{ label: string; icon?: AttrTag }>;
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
| The value | One iterable `attrTag`/`attrTags` record; a single tag is iterable too. | The same record, plus `map`, `filter`, `length`, `at` and `toArray` on its prototype. |
| Unused attributes | The compiler can tree-shake attributes the callee never reads. | Every authored attribute is passed. |
| Typing | `Marko.AttrTag<T>` | `AttrTag<T>`, assignable to `Marko.AttrTag<T>`. |

Do not remove "unused" authored attributes expecting Marko's tree-shaking; MX
intentionally passes them through.

See [Attribute tags and tag params](/language/attribute-tags-and-params/) for
the syntax overview and [Errors](/language/errors/#errors-attribute-tag-errors) for
the complete diagnostic catalog.

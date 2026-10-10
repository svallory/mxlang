---
title: "React"
description: "MX in place of JSX inside a React component: attribute tags for props that hold markup, tags for control flow, and the #id .class :name sugar. Hooks, props and tooling stay React."
---

# React

A `.react.mx` file is a React component with MX where the JSX was. The function, its props, `useState` and every other hook are the TypeScript you already write. The markup changes.

This is one component, in TSX and then in MX. `Table` is a hand-written React component with three props that hold markup.

```tsx "Team.tsx"
import { useState } from "react";
import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team({ members }: { members: Member[] }) {
  const [query, setQuery] = useState("");
  const shown = members.filter((member) => member.name.includes(query));

  return (
    <section id="team" className="panel">
      <input
        name="q"
        className="search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <Table
        rows={shown}
        head={
          <>
            <th>Name</th>
            <th>Teams</th>
          </>
        }
        row={(member) => (
          <>
            <td className={member.admin ? "admin" : undefined}>{member.name}</td>
            <td>
              {member.teams.map((team) => (
                <span key={team} className="tag">
                  {team}
                </span>
              ))}
            </td>
          </>
        )}
        empty={
          query ? (
            <p className="empty">Nobody matches “{query}”.</p>
          ) : (
            <p className="empty">No members yet.</p>
          )
        }
      />
    </section>
  );
}
```

```mx "Team.react.mx"
import { useState } from "react";
import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team({ members }: { members: Member[] }) {
  const [query, setQuery] = useState("");
  const shown = members.filter((member) => member.name.includes(query));

  return (
    <section#team.panel>
      <input:q.search type="search" value=query onChange(event) { setQuery(event.target.value); }/>
      <Table rows=shown>
        <@head>
          <th>Name</th>
          <th>Teams</th>
        </@head>
        <@row|member|>
          <td class={ admin: member.admin }>${member.name}</td>
          <td>
            <for|team| of=member.teams><span.tag>${team}</span></for>
          </td>
        </@row>
        <@empty>
          <if=query><p.empty>Nobody matches “${query}”.</p></if>
          <else><p.empty>No members yet.</p></else>
        </@empty>
      </Table>
    </section>
  );
}
```

What changed:

- **`<@head>`, `<@row|member|>`, `<@empty>` are `Table`'s props.** These are [attribute tags](/language/attribute-tags-and-params/): a prop that holds markup is written as markup. The pipes make `row` a function of `member`, the render prop the TSX spells `row={(member) => …}`. `Table` declares them with `AttrTag`, so each one is checked against its props type.
- **`<section#team.panel>` and `<input:q.search>`** are `id`, `className` and `name`. `class` is `class`; MX emits `className`.
- **`<if>` / `<else>` and `<for>`** replace the ternary and the `.map()`. Every `<for>` row gets a `key`; `by="id"` names the field when the row is an object.
- **`class={ admin: member.admin }`** takes an object or an array, so there is no `clsx` call.
- **`onChange(event) { … }`** is a handler written as a method.

## Setup

```bash
bun add @mxlang/host-react
bun add -d @mxlang/vite-plugin @mxlang/typescript-plugin @mxlang/tsc
```

```jsonc
// package.json: which host compiles a plain .mx; region files carry it in their name
{ "mx": { "host": "react" } }
```

```ts
// vite.config.ts: mx() first, so React's plugin receives TSX
import mx from "@mxlang/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [mx(), react()] });
```

```jsonc
// tsconfig.json: type errors inside .react.mx, at the line you wrote
{ "compilerOptions": { "plugins": [{ "name": "@mxlang/typescript-plugin" }] } }
```

In CI, run `mx-tsc --noEmit` where you ran `tsc --noEmit`: plain `tsc` does not open `.react.mx` files. Editor setup is on the [VS Code](/editors/vscode/) and [Zed](/editors/zed/) pages. A complete app is in `examples/react-region-app`.

## What stays React, what MX adds

**Stays React:** the component function and its props type, hooks, context, refs, Suspense, `@vitejs/plugin-react` and Fast Refresh, and every component you import. A `.react.mx` component and a `.tsx` component import each other freely.

**MX adds:** the markup syntax above, and three things at build time:

- A `key` on every `<for>` row.
- A type check of each attribute tag the callee declares with `AttrTag`.
- React's own names: `className`, `htmlFor`, `onDoubleClick` for the DOM's `dblclick`.

The output is TSX. MX adds a few inline helpers for attribute values and imports `mxClass` from `@mxlang/host-react/runtime` when a class object needs it. There is no MX component model at run time.

## One rule to know first

An MX region is one element, and state stays in the component: `<let>` and `<const>` inside a region are errors that name the hook or the `const` to write instead. The full list is short and is in [Region files: the rules](/hosts/region-files/).

## Go deeper

- [Region files: the rules](/hosts/region-files/): what may go in a region, `<define>`, and each error.
- [What MX compiles to](/hosts/react/semantics/): the table from MX construct to React TSX, events, keys, and `<try>`.
- [Attribute tags in depth](/language/attr-tag/): declaring them on your own components with `AttrTag`, arrays, nesting.
- [Whole-file `.mx` (alpha)](/hosts/react/whole-file/): a template that is the entire component, with no function to write.

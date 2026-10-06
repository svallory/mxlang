---
title: "Preact"
description: "MX in place of JSX inside a Preact component: attribute tags for props that hold markup, tags for control flow, and the #id .class :name sugar. Hooks, props and tooling stay Preact."
---

# Preact

A `.preact.mx` file is a Preact component with MX where the JSX was. The function, its props and the `preact/hooks` hooks are the TypeScript you already write. The markup changes.

This is one component, in TSX and then in MX. `Table` is a hand-written Preact component with three props that hold markup.

```tsx "Team.tsx"
import { useState } from "preact/hooks";
import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team({ members }: { members: Member[] }) {
  const [query, setQuery] = useState("");
  const shown = members.filter((member) => member.name.includes(query));

  return (
    <section id="team" class="panel">
      <input
        name="q"
        class="search"
        type="search"
        value={query}
        onInput={(event) => setQuery(event.currentTarget.value)}
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
            <td class={member.admin ? "admin" : undefined}>{member.name}</td>
            <td>
              {member.teams.map((team) => (
                <span key={team} class="tag">
                  {team}
                </span>
              ))}
            </td>
          </>
        )}
        empty={
          query ? (
            <p class="empty">Nobody matches “{query}”.</p>
          ) : (
            <p class="empty">No members yet.</p>
          )
        }
      />
    </section>
  );
}
```

```mx "Team.preact.mx"
import { useState } from "preact/hooks";
import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team({ members }: { members: Member[] }) {
  const [query, setQuery] = useState("");
  const shown = members.filter((member) => member.name.includes(query));

  return (
    <section#team.panel>
      <input:q.search type="search" value=query onInput(event) { setQuery(event.currentTarget.value); }/>
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
- **`<section#team.panel>` and `<input:q.search>`** are `id`, `class` and `name`.
- **`<if>` / `<else>` and `<for>`** replace the ternary and the `.map()`. Every `<for>` row gets a `key`; `by="id"` names the field when the row is an object.
- **`class={ admin: member.admin }`** takes an object or an array, so there is no `clsx` call.
- **`onInput(event) { … }`** is a handler written as a method.

## Setup

```bash
bun add @mxlang/preact
bun add -d @mxlang/vite-plugin @mxlang/typescript-plugin @mxlang/tsc
```

```jsonc
// package.json: which host compiles a plain .mx; region files carry it in their name
{ "mx": { "host": "preact" } }
```

```ts
// vite.config.ts: mx() first, so Preact's preset receives TSX
import mx from "@mxlang/vite-plugin";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [mx(), preact()] });
```

```jsonc
// tsconfig.json: type errors inside .preact.mx, at the line you wrote
{ "compilerOptions": { "plugins": [{ "name": "@mxlang/typescript-plugin" }] } }
```

In CI, run `mx-tsc --noEmit` where you ran `tsc --noEmit`: plain `tsc` does not open `.preact.mx` files. Editor setup is on the [VS Code](/editors/vscode/) and [Zed](/editors/zed/) pages.

## What stays Preact, what MX adds

**Stays Preact:** the component function and its props type, hooks, context, refs, signals if you use them, `@preact/preset-vite`, and every component you import. A `.preact.mx` component and a `.tsx` component import each other freely.

**MX adds:** the markup syntax above, and two things at build time:

- A `key` on every `<for>` row.
- A type check of each attribute tag the callee declares with `AttrTag`.

The output is TSX. MX adds a few inline helpers for attribute values and imports `mxClass` from `@mxlang/preact/runtime` when a class object needs it. There is no MX component model at run time.

## One rule to know first

An MX region is one element, and state stays in the component: `<let>` and `<const>` inside a region are errors that name the hook or the `const` to write instead. The full list is short and is in [Region files: the rules](/hosts/region-files/).

## Go deeper

- [Region files: the rules](/hosts/region-files/): what may go in a region, `<define>`, and each error.
- [What MX compiles to](/hosts/preact/semantics/): the table from MX construct to Preact TSX, events, keys, and `<try>`.
- [Attribute tags in depth](/language/attr-tag/): declaring them on your own components with `AttrTag`, arrays, nesting.
- [Whole-file `.mx` (alpha)](/hosts/preact/whole-file/): a template that is the entire component, with no function to write.

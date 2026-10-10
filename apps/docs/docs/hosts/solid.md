---
title: "Solid"
description: "MX in place of JSX inside a Solid component: <if> and <for> compile to <Show> and <For>, attribute tags replace accessor props, and signals stay yours."
---

# Solid

A `.solid.mx` file is a Solid component with MX where the JSX was. The function, its props, signals, memos and effects are the TypeScript you already write, and Solid's compiler still builds the result. The markup changes.

This is one component, in TSX and then in MX. `Table` is a hand-written Solid component with three props that hold markup.

```tsx "Team.tsx"
import { createSignal, For, Show } from "solid-js";
import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team(props: { members: Member[] }) {
  const [query, setQuery] = createSignal("");
  const shown = () => props.members.filter((member) => member.name.includes(query()));

  return (
    <section id="team" class="panel">
      <input
        name="q"
        class="search"
        type="search"
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <Table
        rows={shown()}
        head={() => (
          <>
            <th>Name</th>
            <th>Teams</th>
          </>
        )}
        row={(member) => () => (
          <>
            <td class={{ admin: member.admin }}>{member.name}</td>
            <td>
              <For each={member.teams}>{(team) => <span class="tag">{team}</span>}</For>
            </td>
          </>
        )}
        empty={() => (
          <Show when={query()} fallback={<p class="empty">No members yet.</p>}>
            <p class="empty">Nobody matches “{query()}”.</p>
          </Show>
        )}
      />
    </section>
  );
}
```

```mx "Team.solid.mx"
import { createSignal } from "solid-js";
import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team(props: { members: Member[] }) {
  const [query, setQuery] = createSignal("");
  const shown = () => props.members.filter((member) => member.name.includes(query()));

  return (
    <section#team.panel>
      <input:q.search type="search" value=query() onInput(event) { setQuery(event.currentTarget.value); }/>
      <Table rows=shown()>
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
          <if=query()><p.empty>Nobody matches “${query()}”.</p></if>
          <else><p.empty>No members yet.</p></else>
        </@empty>
      </Table>
    </section>
  );
}
```

What changed:

- **`<@head>`, `<@row|member|>`, `<@empty>` are `Table`'s props.** These are [attribute tags](/language/attribute-tags-and-params/): a prop that holds markup is written as markup. MX wraps each in the accessor Solid needs, so the `() =>` and the `(member) => () =>` are gone. `Table` declares them with `AttrTag`, so each is checked against its props type.
- **`<if>` / `<else>` and `<for>`** compile to `<Show>` and `<For>`. You do not import either.
- **`<section#team.panel>` and `<input:q.search>`** are `id`, `class` and `name`.
- **`onInput(event) { … }`** is a handler written as a method.

Signals are read the way Solid reads them: `query()` in the markup is a tracked read.

## Setup

```bash
bun add -d @mxlang/vite-plugin @mxlang/typescript-plugin @mxlang/tsc
```

```ts
// vite.config.ts: mx() first, so Solid's plugin receives JSX
import mx from "@mxlang/vite-plugin";
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [mx(), solid()] });
```

```jsonc
// tsconfig.json: Solid's JSX settings, and type errors inside .solid.mx
{
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "@solidjs/web",
    "allowImportingTsExtensions": true,
    "plugins": [{ "name": "@mxlang/typescript-plugin" }]
  }
}
```

In CI, run `mx-tsc --noEmit` where you ran `tsc --noEmit`: plain `tsc` does not open `.solid.mx` files. The host targets **Solid 2**: this assumes `solid-js`, `@solidjs/web` and `@solidjs/vite-plugin` are already in the project. Add `@mxlang/host-solid` when you declare attribute tags on your own components.

## What stays Solid, what MX adds

**Stays Solid:** the component function, `props`, signals, stores, effects, context, Solid's compiler and its fine-grained updates. You can still write `<For>`, `<Show>` and any other Solid component by name in MX markup.

**MX adds:** the markup syntax above, compiled to Solid JSX in the same position, with source maps back to your file. There is no MX runtime: `<if>` is `<Show>`, `<for>` is `<For>`, `<try>` is `<Loading>` and `<Errored>`.

## Two rules to know first

- **A region is one element, and state stays outside it.** `<const>`, `import` and state tags such as `<let>` are errors inside a region, each naming what to write in the TypeScript around it. A `<define>` is allowed as a direct child of the region. For several roots, use a TSX fragment `<>…</>`; each child is its own region.
- **Tag params are the child function.** `<Show|user| when=user()>…</Show>` is `<Show when={user()}>{(user) => …}</Show>`, which is how you call any render-prop component.

## Go deeper

- [What MX compiles to](/hosts/solid/semantics/): every `<for>` form, `<if>` chains, events, `<try>`, and the errors.
- [Attribute tags in depth](/language/attr-tag/): declaring them on your own components with `AttrTag`, arrays, nesting.
- `examples/counter-app` and `examples/todomvc`: a small app and the full TodoMVC, both in `.solid.mx`.

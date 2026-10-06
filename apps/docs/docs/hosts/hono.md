---
title: "Hono"
description: "MX in place of JSX inside a hono/jsx component: attribute tags for props that hold markup, tags for control flow, and the #id .class :name sugar. Routes, context and middleware stay Hono."
---

# Hono

A `.hono.mx` file is a `hono/jsx` component with MX where the JSX was. The function and its props are the TypeScript you already write, and your routes render it with `c.html()` as before. The markup changes.

This is one server-rendered component, in TSX and then in MX. `Table` is a hand-written Hono component with three props that hold markup.

```tsx "Team.tsx"
import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team({ members, query }: { members: Member[]; query: string }) {
  const shown = members.filter((member) => member.name.includes(query));

  return (
    <section id="team" class="panel">
      <form method="get">
        <input name="q" class="search" type="search" value={query} />
      </form>
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

```mx "Team.hono.mx"
import type { Member } from "./members.ts";
import { Table } from "./Table.tsx";

export function Team({ members, query }: { members: Member[]; query: string }) {
  const shown = members.filter((member) => member.name.includes(query));

  return (
    <section#team.panel>
      <form method="get">
        <input:q.search type="search" value=query/>
      </form>
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
- **`<if>` / `<else>` and `<for>`** replace the ternary and the `.map()`.
- **`class={ admin: member.admin }`** takes an object or an array.

## Setup

Region files compile through the Vite plugin, so this is for a Hono project built with Vite (`@hono/vite-dev-server`, `@hono/vite-build`).

```bash
bun add @mxlang/hono
bun add -d @mxlang/vite-plugin @mxlang/typescript-plugin @mxlang/tsc
```

```jsonc
// package.json: which host compiles a plain .mx; region files carry it in their name
{ "mx": { "host": "hono" } }
```

```ts
// vite.config.ts: mx() before the Hono plugins
import mx from "@mxlang/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [mx() /* , devServer(…) */] });
```

```jsonc
// tsconfig.json: Hono's JSX runtime, and type errors inside .hono.mx
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",
    "plugins": [{ "name": "@mxlang/typescript-plugin" }]
  }
}
```

In CI, run `mx-tsc --noEmit` where you ran `tsc --noEmit`.

**A plain Bun server with no bundler?** The Bun loader handles whole-file templates only. See [Whole-file `.mx` (alpha)](/hosts/hono/whole-file/): one `preload` line and you `import App from "./App.mx"`.

## What stays Hono, what MX adds

**Stays Hono:** the app, routes, middleware, `c.html()`, the component function and its props, `hono/jsx`'s own `ErrorBoundary` and `Suspense`, and every component you import.

**MX adds:** the markup syntax above, a `key` on every `<for>` row, and a type check of each attribute tag the callee declares with `AttrTag`.

The output is `hono/jsx` TSX. The server render is plain HTML: no hydration script, no island wrappers, nothing for the browser to run. The only runtime import is `mxClass` from `@mxlang/hono/runtime`, when a class object needs it.

## One rule to know first

An MX region is one element, and state stays in the component: `<let>` and `<const>` inside a region are errors that name what to write instead. The full list is short and is in [Region files: the rules](/hosts/region-files/).

## Go deeper

- [Region files: the rules](/hosts/region-files/): what may go in a region, `<define>`, and each error.
- [What MX compiles to](/hosts/hono/semantics/): the table from MX construct to `hono/jsx`, events, keys, and `<try>`.
- [Attribute tags in depth](/language/attr-tag/): declaring them on your own components with `AttrTag`, arrays, nesting.
- [Whole-file `.mx` (alpha)](/hosts/hono/whole-file/): a template that is the entire component, and the Bun loader.

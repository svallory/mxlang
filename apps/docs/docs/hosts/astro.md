---
title: "Astro"
description: "MX in place of the template in an Astro component: the --- fence stays Astro, attribute tags fill named slots, <if> and <for> replace the ternaries and maps."
---

# Astro

An `.astro.mx` file is an Astro component with MX under the fence. The `---` frontmatter, `Astro.props`, imports and `getStaticPaths` are Astro's and pass through untouched, and Astro's own compiler builds the result. The template changes.

This is one component, as `.astro` and then as `.astro.mx`. `Card` is an ordinary Astro component with two named slots.

```astro title="Team.astro"
---
import Card from "./Card.astro";
import type { Member } from "./members.ts";

export interface Props {
  members: Member[];
}
const { members } = Astro.props as Props;
---
<Card>
  <Fragment slot="title">Team <span class="count">{members.length}</span></Fragment>
  {members.length ? (
    <ul class="members">
      {members.map((member) => (
        <li class:list={{ admin: member.admin }}>
          {member.name}
          {member.teams.map((team) => <span class="tag">{team}</span>)}
        </li>
      ))}
    </ul>
  ) : (
    <p class="empty">No members yet.</p>
  )}
  <Fragment slot="footer"><a class="button" href="/invite">Invite someone</a></Fragment>
</Card>
```

```mx title="Team.astro.mx"
---
import Card from "./Card.astro";
import type { Member } from "./members.ts";

export interface Props {
  members: Member[];
}
const { members } = Astro.props as Props;
---
<Card>
  <@title>Team <span.count>${members.length}</span></@title>
  <if=members.length>
    <ul.members>
      <for|member| of=members>
        <li class={ admin: member.admin }>
          ${member.name}
          <for|team| of=member.teams><span.tag>${team}</span></for>
        </li>
      </for>
    </ul>
  </if>
  <else>
    <p.empty>No members yet.</p>
  </else>
  <@footer><a.button href="/invite">Invite someone</a></@footer>
</Card>
```

What changed:

- **`<@title>` and `<@footer>` fill `Card`'s named slots.** These are [attribute tags](/language/attribute-tags-and-params/); each compiles to `<Fragment slot="…">`.
- **`<if>` / `<else>` and `<for>`** replace the ternary and the `.map()`.
- **`<ul.members>`, `<span.tag>`, `<a.button>`** are `class`. `#id` and `:name` work the same way.
- **`class={ admin: member.admin }`** compiles to `class:list`.

The output is static markup, as from any `.astro` file. MX ships nothing to the browser.

## Setup

```bash
bun add -d @mxlang/astro
```

```js
// astro.config.mjs
import mx from "@mxlang/astro";
import { defineConfig } from "astro/config";

export default defineConfig({ integrations: [mx()] });
```

```jsonc
// tsconfig.json: types and errors inside .astro.mx
{ "compilerOptions": { "plugins": [{ "name": "@mxlang/typescript-plugin", "astro": true }] } }
```

Do not also list `@astrojs/ts-plugin`: TypeScript loads one such plugin, and `astro: true` already includes Astro's. In CI, run `mx-tsc --astro --noEmit`.

## What stays Astro, what MX adds

**Stays Astro:** the frontmatter and everything in it, layouts, slots, routing, content collections, and every `.astro` component you import or that imports yours.

**MX adds:** the template syntax above, compiled to Astro's own template syntax. Because the result is static, anything that needs a runtime is a build error, not markup that quietly never updates: event handlers, `<let>`, `:=`.

## Two rules to know first

- **A page cannot be `.astro.mx`.** Astro strips only the last extension, so `src/pages/about.astro.mx` would route to `/about.astro`. The integration reports it. Write `about.astro` and import the `.astro.mx` component, or write the page as [`about.mx`](/hosts/astro/mx-files/).
- **Slots carry markup, not functions.** Attribute tags with params (`<@row|item|>`), repeated attribute tags and `<define>` have no Astro equivalent and are errors. Declare values in the fence.

## Go deeper

- [What MX compiles to](/hosts/astro/semantics/): the table from MX construct to Astro template, and what is not supported.
- [`.mx` components and pages](/hosts/astro/mx-files/): plain `.mx` files rendered by Astro, with slots, layouts and `getStaticPaths`.
- `examples/astro-static`: a full static site using both.

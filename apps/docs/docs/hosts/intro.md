---
title: "Hosts"
description: "A host is a framework MX compiles into. You keep the framework's component, its state and its tools; MX replaces the JSX or the template."
---

# Hosts

A host is a framework MX compiles into. You keep writing that framework's components: its props, state, hooks, signals, router and build tools are untouched. MX replaces one thing, the markup, and compiles it back to the JSX or template the framework expects.

Here is a React component, first in JSX, then with MX where the JSX was.

```tsx title="Invite.tsx"
import { Dialog } from "./Dialog.tsx";

export function Invite({ team, open, send }: { team: string; open: boolean; send: () => void }) {
  return (
    <Dialog
      open={open}
      title={
        <>
          Invite to <b>{team}</b>
        </>
      }
      actions={
        <button className="primary" onClick={send}>
          Send invite
        </button>
      }
    >
      <input name="email" id="email" className="field" type="email" required />
    </Dialog>
  );
}
```

```mx title="Invite.react.mx"
import { Dialog } from "./Dialog.tsx";

export function Invite({ team, open, send }: { team: string; open: boolean; send: () => void }) {
  return (
    <Dialog open=open>
      <@title>Invite to <b>${team}</b></@title>
      <input:email#email.field type="email" required/>
      <@actions><button.primary onClick=send>Send invite</button></@actions>
    </Dialog>
  );
}
```

Three things changed, and they are the same on every host:

- **Attribute tags.** `<@title>` and `<@actions>` are the `title` and `actions` props. A prop that holds markup is written as markup, where it belongs in the tree, and checked against the component's props type.
- **Name sugar.** `<input:email#email.field>` is `name="email" id="email" class="field"`. `<button.primary>` is `class="primary"`.
- **No closing ceremony.** No fragments around a prop's markup, no `{}` around every value, no `className`.

`Dialog` did not change. It is the same hand-written React component in both files.

## Pick your framework

| Host | You write | MX replaces |
|---|---|---|
| [React](/hosts/react/) | `Team.react.mx`, a TSX module | the JSX |
| [Preact](/hosts/preact/) | `Team.preact.mx`, a TSX module | the JSX |
| [Hono](/hosts/hono/) | `Team.hono.mx`, a TSX module | the `hono/jsx` JSX |
| [Solid](/hosts/solid/) | `Team.solid.mx`, a TSX module | the JSX; `<if>` and `<for>` become `<Show>` and `<For>` |
| [Astro](/hosts/astro/) | `Team.astro.mx`, an Astro component | the template under the `---` fence |
| [Angular](/hosts/angular/) | `team.component.ng.mx`, a component module | the value of `template:` |

Each page opens with the same component in the framework's own syntax and in MX, then the setup.

## What you get on every host

- **Control flow as tags.** [`<if>`, `<else>` and `<for>`](/language/structural-tags/) compile to what the framework wants: a ternary and a keyed `.map()` on React, `<Show>` and `<For>` on Solid, `@if` and `@for` on Angular.
- **[Attribute tags](/language/attribute-tags-and-params/).** Named slots and render props as nested markup: `<@header>`, `<@row|item|>`.
- **[Name sugar](/language/attributes/).** `#id`, `.class` and `:name`, on the tag or among its attributes.
- **Errors at the line you wrote.** Type errors and MX errors are reported in the `.mx` file, in the [editor](/editors/vscode/) and in [`mx-tsc`](/editors/typescript/).
- **No MX runtime to adopt.** The output is the framework's own code. Remove MX and you are left with ordinary components.

## No framework?

MX also compiles without a host: to [HTML strings](/targets/html/) for a server or a static build, and to a [data tree](/targets/data/) when the markup describes data instead of a page.

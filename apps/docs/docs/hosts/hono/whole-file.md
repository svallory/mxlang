---
title: "Hono: whole-file .mx (alpha)"
description: "A .mx file that is the entire hono/jsx component, loaded by a plain Bun server with one preload line and no bundler."
---

# Hono: whole-file `.mx` (alpha)

A plain `.mx` file on the Hono host is the whole component. There is no function to write: MX emits the default-exported function component, and `export interface Input` becomes its props type.

**Alpha.** [`.hono.mx`](/hosts/hono/) is the form to start with when you build with Vite. Whole-file `.mx` is the one a Bun server can import directly, which is why it is documented here.

```mx "App.mx"
export interface Input {
  items: string[];
}

<main>
  <h1>${input.items.length} items</h1>
  <ul>
    <for|item| of=input.items><li>${item}</li></for>
  </ul>
</main>
```

## A Bun server, no bundler

```toml
# bunfig.toml
preload = ["@mxlang/hono/bun"]
```

```ts
import { Hono } from "hono";
import App from "./App.mx";

const app = new Hono();
app.get("/", async (c) => c.html(await App({ items: ["alpha", "beta"] }).toString()));
```

The loader compiles `.mx` to TSX and each compiled file carries its own `@jsxImportSource hono/jsx` pragma, so the template needs no JSX configuration. Two limits:

- It declines region files (`.hono.mx`); those need the Vite plugin.
- A hand-written `.tsx` beside it has no pragma, so the project's own `tsconfig.json` must set `jsxImportSource: "hono/jsx"`. Run the script under a different project's tsconfig and Bun silently picks the wrong JSX runtime for that file.

## In the template

- **Props** are `input`: `input.items`.
- **Hooks go in `<const>`** (`<const/state=useState(0)/>`), which becomes a statement in the component body. `static` is module scope and must not call a hook.
- **`import`, `static` and `export`** are hoisted to the module.
- **Marko's stateful tags are errors** that name the `hono/jsx` hook to use: `useState`, `useEffect`, `useId`.

## Selecting the host

A whole-file `.mx` has no host in its name, so `package.json` says which one compiles it: `"mx": { "host": "hono" }`. A project with exactly one `@mxlang/*` host dependency may leave the field out. `mx.target: "hono-jsx"` selects Hono too; if both are given and disagree, the tools report `target-host-mismatch`.

Everything in [What MX compiles to](/hosts/hono/semantics/) applies. `examples/hono-app` is a complete app on this route.

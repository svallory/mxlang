---
title: "Region files: the rules"
description: "What a .react.mx, .preact.mx or .hono.mx file is, what may go in an MX region, and the errors you can meet."
---

# Region files: the rules

A `.react.mx`, `.preact.mx` or `.hono.mx` file is a TSX module. Wherever TypeScript expects an expression, `<` opens an **MX region**, and the region compiles to a JSX expression in the same place. Everything outside the regions is your TypeScript, passed through untouched.

This page is the reference for [React](/hosts/react/), [Preact](/hosts/preact/) and [Hono](/hosts/hono/), which share these rules. In the messages below, `.react.mx` and "React" stand for your host. [Solid](/hosts/solid/semantics/) and [Angular](/hosts/angular/ng-mx/) have their own.

## A region is one element

```mx "Page.react.mx"
import { useState } from "react";

export default function Page() {
  const [label] = useState("from-state");
  return (
    <ul>
      <define/Row|n: number|><li>${label} ${n}</li></define>
      <Row(1)/>
      <Row(2)/>
    </ul>
  );
}
```

A region has one root element. Markup that belongs together, such as an `<if>` and its `<else>`, or a `<define>` and its calls, goes inside one element. A TSX fragment `<>…</>` is not a region: each child element of it is a region of its own.

## What goes inside

Everything the host can render: native elements, components, `<if>` / `<else if>` / `<else>`, `<for>`, attribute tags, dynamic tags, `<define>`, and a `/var` tag variable.

What stays outside, in your TypeScript:

| Written in a region | Error | Do this |
|---|---|---|
| `<let>`, `<effect>`, `<id>`, `<lifecycle>` | ``<let> is Marko reactive state; use React's `useState` in the surrounding component`` (each names its hook) | Call the hook in the component. |
| `<const/x=…/>` | ``<const> cannot declare a binding inside a `.react.mx` expression; declare it in the surrounding component`` | Write `const x = …` above the `return`. |
| `import`, `static`, `export`, `<return>` | ``module-level MX statements cannot appear inside a `.react.mx` expression; write them in the surrounding TypeScript module`` | Write them in the module. |

## `<define>` and tag variables

A `<define>` or a `/var` written directly in the region's markup sees the component's props and hooks, as `Row` reads `label` above. Each call is a plain function call, so a define has no component identity of its own and never remounts.

Two limits:

- **Not inside a body.** A `<define>` or `/var` inside `<for>`, `<if>`, an attribute-tag body or another `<define>` is an error, because lifting it out would change its scope. Declare it directly in the region's markup.
- **One name per region.** Two declarations of one name in a region fail with `Duplicate declaration "Row"` at the second. The same name in two regions of one file is fine.

## Imports MX adds

A region is an expression, so anything it needs at module level is added to the module for you, once: the runtime import (`@mxlang/react/runtime`) when a class object or a `<try>` needs it, the import of a [discovered custom tag](/custom-tags/discovery/), and a few inline helpers.

## Where errors show up

MX errors (the table above, a missing required attribute tag) and TypeScript errors inside a region are both reported at the position you wrote, by the [TypeScript plugin](/editors/typescript/) in the editor and by `mx-tsc` in CI. The [language server](/editors/language-server/) does not run TypeScript, so it reports the MX errors only.

## Tools that read region files

The Vite plugin, the language server, the TypeScript plugin and `mx-tsc` all treat `*.react.mx`, `*.preact.mx` and `*.hono.mx` as region files. The Bun loaders decline them: a region file needs the Vite plugin. A whole-file template keeps the plain `.mx` extension.

---
title: "Introduction"
description: "What MX is, what it is not, and how it relates to Marko."
---

# MX

MX (Markup eXtended) is a language born from Marko. It takes Marko's syntax — the syntax people already know from Marko — and brings it to wherever JSX lives today: React, Preact, Solid, Hono, Astro, Angular, and server-side HTML. Markup is first-class syntax and control flow is closed, statically analyzable tags, on TypeScript, with no runtime attached. MX defines the language, including its reactive tags; each **target** decides how that language is expressed in its output.

`.mx` is the official and only whole-template file extension. Porting a Marko component that uses no construct MX departs from is a rename.

## What MX is

- **The language.** A markup grammar plus a small set of structural tags: `<if>` / `<else if>` / `<else>`, every `<for>` form, attribute tags, tag params, `<define>`, `<const>`, `static`, `import`. These work identically on every target. The reactive tags (`<let>` and friends) are core language too: each target lowers them to its own framework's primitives.
- **Custom tags.** Define project vocabulary as an MX template or a TypeScript sidecar. Calls are discovered without imports and expand to ordinary IR before any emitter runs, so one definition works on all six hosts. Start with [Custom tags](/custom-tags/).
- **The core.** One package (`@mxlang/core`) that lowers MX's own AST to a host-independent IR, applies structural and custom-tag lowerings, and exposes `HostDeclarations` plus generic hooks; it names no host or target.
- **Targets and hosts.** A target is an output format a file compiles to (JSX, an Angular template, an Astro template, an HTML string), and targets are what gets registered. A host is a framework MX lives inside, built on one target: the component stays a native component of that framework and MX takes the place of its JSX or template (the [Hosts overview](/hosts/intro/) shows one side by side):
  - **HTML** (a [target](/targets/html/), not a host) — a `.mx` file compiles to a pure `(input) => string` function. No runtime, no framework.
  - **Astro** — `.astro.mx` is an Astro component with MX as its template; plain `.mx` components and pages render to static markup at build time, no islands, no client JavaScript.
  - **React, Preact, Hono** (`.react.mx`, `.preact.mx`, `.hono.mx`) — a TSX module with MX in JSX's position: the component function, its props and its hooks stay TypeScript, and each MX region compiles to a JSX expression. See [React](/hosts/react/), [Preact](/hosts/preact/) and [Hono](/hosts/hono/).
  - **Solid** (`.solid.mx`) — the same model on Solid: MX in JSX's position, lowered to Solid's own JSX with `<Show>` and `<For>`. See [Solid](/hosts/solid/).
  - **Angular** (`.ng.mx`) — an Angular component module with MX as the value of `template:`. See [Angular](/hosts/angular/).

## What MX is not

- **Not a runtime.** MX has no runtime of its own: compiled output may use a runtime the browser, the framework or a third party owns, never one MX owns. `@mxlang/compat-<target>` packages are shims over a framework's own runtime, not an MX runtime. No resume, no serialized scope data, no `@marko/runtime-tags`. See [why MX has no resume](/design-notes/marko-runtime-modes/).
- **Not a promise that every target runs every tag.** The reactive tags mean the same thing everywhere, but a target with no reactivity cannot honour them: the html target renders their initial values, and the Astro host, which has no reactive target, rejects them.
- **Not a Marko fork with a parity promise.** MX has its own parser and compiler; Marko is its default, not its contract.

## MX and Marko

Marko is the default answer for `.mx`: where MX has no rule of its own, a
construct means what it means in Marko. MX does not promise to be a subset or a
superset of Marko. When MX departs from Marko it does so deliberately, and the
departure is recorded with what changed, why, and the test that pins it. A host
may *forbid* a tag it cannot honour (the Astro host rejects `<let>` because it
has no reactive target), but no host adds syntax, attribute forms or file
conventions; extending the language is a dialect's job. Custom tags use
ordinary tag syntax and expand only after parsing.

Only MX's own language on a web-UI target can diverge from Marko. A dialect is
a language of its own built on MX's machinery, so what a dialect does is never
a Marko divergence. See [Divergences & MX 2](/divergences-and-mx-2/) for the
current list.

## Start here

If you are new to MX, read these five in order — about twenty minutes end to end:

1. [Structural tags](/language/structural-tags/) — `<if>`, `<for>`, and the rest of the portable core. This is the part that means the same thing on every host.
2. [Interpolation and escaping](/language/interpolation/) — `${}` versus `$!{}`, and the whitespace rule that surprises people coming from JSX.
3. [Custom tags](/custom-tags/) — define reusable project vocabulary without coupling it to a host.
4. Pick your host and follow its install: [HTML](/targets/html/) for a plain string, [Astro](/hosts/astro/) for static markup, [React](/hosts/react/) or [Preact](/hosts/preact/) for components, [Hono](/hosts/hono/) for server JSX, [Solid](/hosts/solid/) for MX inside a Solid file.
5. [Stateful tags](/language/stateful-tags/) — `<let>` and the other reactive tags, which every target lowers to its own primitives.

Then set up your editor: [Zed](/editors/zed/), [VS Code](/editors/vscode/), and the [TypeScript](/editors/typescript/) integration that type-checks MX files.

## Reference

- [Language](/language/structural-tags/) — the structural tags, attribute tags, interpolation, and the reactive tags.
- [Custom tags](/custom-tags/reference/) — template and sidecar authoring, discovery, API types, and diagnostics.
- [Architecture](/architecture/core-and-hosts/) — how the core and hosts fit together.
- [Editors](/editors/zed/) — Zed, VS Code, and the diagnostics language server.
- [Contributing](/contributing/) — repo layout, the verification chain, and how to add a host.
- [Divergences & MX 2](/divergences-and-mx-2/) — what MX deliberately does not do yet, and why.

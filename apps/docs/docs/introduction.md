---
title: "Introduction"
description: "What MX is, what it is not, and how the subset rule works."
---

# MX

MX (Markup eXtended) is a template language born from Marko. It takes Marko's syntax — the syntax people already know from Marko — and brings it to wherever JSX lives today: React, Preact, Solid, Hono, Astro, and server-side HTML. MX itself defines the markup and the structural tags; each **host** decides what state, reactivity, and output mean.

`.mx` is the official and only whole-template file extension. Porting a Marko component that stays within the MX 1.0 subset is a rename.

## What MX is

- **The language.** A markup grammar plus a small set of structural tags: `<if>` / `<else if>` / `<else>`, every `<for>` form, attribute tags, tag params, `<define>`, `<const>`, `static`, `import`. These work identically on every host and render exactly the way Marko renders them.
- **Custom tags.** Define project vocabulary as an MX template or a TypeScript sidecar. Calls are discovered without imports and expand to ordinary IR before any emitter runs, so one definition works on all six hosts. Start with [Custom tags](/custom-tags/).
- **The core.** One package (`@mxlang/core`) that consumes Marko's AST, applies structural and custom-tag lowerings, and exposes `HostDeclarations` plus hooks so a host can add its own stateful tags.
- **The hosts.** Each host is a policy over the core, plus the integration that makes it usable in that ecosystem:
  - **HTML** — a `.mx` file compiles to a pure `(input) => string` function. No runtime, no framework.
  - **Astro** — `.mx` components and pages render to static markup at build time, no islands, no client JavaScript.
  - **React** — `.mx` templates compile to native React component modules with hooks through `<const>` and `<try>` through a class error boundary.
  - **Preact** — the same structural JSX lowering targeted at Preact's runtime and native prop vocabulary.
  - **SolidMX** (`.solid.mx`) — MX in JSX's position inside a Solid component file, lowered to Solid's own JSX. See [SolidMX](/hosts/solidmx/).

## What MX is not

- **Not a Marko runtime.** No resume, no serialized scope data, no `@marko/runtime-tags`. A host that wants client-side state uses its own framework's mechanisms. See [why MX has no resume](/design-notes/marko-runtime-modes/).
- **Not a promise of portability for stateful templates.** A template using `<let>` means one thing on the html target (an error, unless explicitly allowed) and something else on a future reactive host — the same way JSX means something different depending on which framework compiles it. The structural core is portable; stateful tags are host-bound.
- **Not a superset of Marko.** MX 1.0 is a strict *subset*.

## The subset rule

Every MX 1.0 file is a valid Marko file, with the same meaning for the structural core. A host may *forbid* a tag it cannot honor — the Astro host rejects `<let>` because it has no reactive target — but no host may add syntax, attribute forms, or file conventions that Marko's own parser would reject. This lets MX reuse Marko's parser, formatting rules, and tree-sitter grammar while MX's own integrations keep the `.mx` identity and apply host policy.

The rule holds until MX 2. From MX 2 on, MX may diverge from Marko, but only deliberately and one recorded step at a time. Custom tags do not break the rule: a call uses ordinary Marko tag syntax and expands only after parsing.

## Divergence policy

Every deliberate divergence from Marko is recorded in a table — what changed,
why, and what test guards it — before it ships. Syntax divergences land only
with the tooling they affect (grammar, formatter, language server). MX 1.0 uses
Marko syntax unmodified; its one deliberate semantic divergence is the
consumer-declared [AttrTag value shape](/language/attr-tag/#marko-6-compared-with-mx).
Two cases where the html target used to be more permissive than Marko were
implementation bugs rather than divergences, and both are fixed — the
Marko-parity oracle now reports no translator bugs.

## Start here

If you are new to MX, read these five in order — about twenty minutes end to end:

1. [Structural tags](/language/structural-tags/) — `<if>`, `<for>`, and the rest of the portable core. This is the part that means the same thing on every host.
2. [Interpolation and escaping](/language/interpolation/) — `${}` versus `$!{}`, and the whitespace rule that surprises people coming from JSX.
3. [Custom tags](/custom-tags/) — define reusable project vocabulary without coupling it to a host.
4. Pick your host and follow its install: [HTML](/targets/html/) for a plain string, [Astro](/hosts/astro/) for static markup, [React](/hosts/react/) or [Preact](/hosts/preact/) for components, [Hono](/hosts/hono/) for server JSX, [SolidMX](/hosts/solidmx/) for MX inside a Solid file.
5. [Stateful tags](/language/stateful-tags/) — what `<let>` and friends mean, which is the one place hosts deliberately disagree.

Then set up your editor: [Zed](/editors/zed/), [VS Code](/editors/vscode/), and the [TypeScript](/editors/typescript/) integration that type-checks MX files.

## Reference

- [Language](/language/structural-tags/) — the structural tags, attribute tags, interpolation, and what a host is free to define itself.
- [Custom tags](/custom-tags/reference/) — template and sidecar authoring, discovery, API types, and diagnostics.
- [Architecture](/architecture/core-and-hosts/) — how the core and hosts fit together.
- [Editors](/editors/zed/) — Zed, VS Code, and the diagnostics language server.
- [Contributing](/contributing/) — repo layout, the verification chain, and how to add a host.
- [Divergences & MX 2](/divergences-and-mx-2/) — what MX deliberately does not do yet, and why.

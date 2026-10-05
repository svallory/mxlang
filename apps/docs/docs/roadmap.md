---
title: "Roadmap"
description: "Phase 5 items and the MX 2 investigations."
---

# Roadmap

## Phase 5

The final pieces of the MX 1.0 baseline:

- **Hono host:** A lightweight host for Hono targeting string emission, similar to HTML.
- **Whole-file `.mx` components:** Expanding Solid and other reactive frameworks to support whole-file `.mx` rather than just `.solid.mx` regions. First question: why, versus "just use Marko"? Write the case for and against before any code.
- **Custom tags:** L1 templates, L2 TypeScript sidecars, discovery, validation, IR transforms, and the `analyze`/`finalize` collecting pair are shipped. See [Custom tags](/custom-tags/).
- **Editor tooling:** Prettier support by aliasing (with `prettier-plugin-marko`); ESLint plugin deferred. VS Code extension with TextMate grammars, LS client, and TS plugin contribution.
- **Marketing:** Researching what made JSX, Astro and comparable cases popular. "Markup eXtended" name, site, the translator as the Pug successor, the Solid host as the JSX replacement; the Marko-team conversation with working hosts to show.

## MX 2 Investigations

Once MX 1.0 is stable and the documentation is complete, we will begin exploring MX 2. This includes tackling the items currently on the [Deferred to MX 2](/divergences-and-mx-2/) list (e.g., tag params on `<if>`, tag params on native HTML elements, etc.). Any syntax change in MX 2 will land in lockstep with its corresponding grammar and language server tooling so editors never break.

Custom-tag L3 raw parser hooks remain later work. The tag-resolution `resolve` hook is reserved for MX 2; neither is part of the current L1/L2 contract.

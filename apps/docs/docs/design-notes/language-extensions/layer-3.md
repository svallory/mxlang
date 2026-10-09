---
title: "Layer 3: languages built on MX"
description: "An idea, not scheduled: shipping a language whose compiler is MX, with its own extension, name, manifest key and editor language, as packaging over layers 1 and 2."
---

# Layer 3: languages built on MX

**Status:** idea. Not on the roadmap. Written down so layers 1 and 2 are built
in a way that leaves this reachable at packaging cost, with the parser never
opened again for it.

A layer-3 package is a language whose compiler is MX. It keeps the parser
states, the IR, the emitters, the projection and the manifests, and changes
the surface through the same syntax table and hooks a layer-2 project uses.
What distinguishes it is that its user never sees MX:

- its own extension (`.disl`), never `.<segment>.mx`
- its own name in every diagnostic, CLI and editor title
- its own manifest key (`package.json#disl`)
- its own editor language id and grammar
- a pinned `@mxlang/core` as an implementation detail

A user installs `disl`, writes `src/**/*.disl`, runs `disl build`, installs
the disl editor extension. Mesh is the intended first case.

## Package anatomy

```
disl/
  package.json        dependencies: @mxlang/core (exact), the target package it emits through
  dialect.ts          default export: LanguageDescriptor
  syntax.ts           full SyntaxTable (its default row) + lowerTrigger/lowerBlockTag/lowerFilter/afterLower
  declarations.ts     HostDeclarations: dispositions (which core tags exist, renamed, forbidden)
  tags/               the language's own tags
  contracts.ts        optional
  bin/disl.ts         CLI wrapping mx-tsc, the Vite plugin and the Bun loader with the descriptor preloaded
  editor/vscode/      extension from the MX template: language id, grammar, LS launched with the descriptor
  test/oracle/        fixtures through packages/oracle's harness
```

```ts
interface LanguageDescriptor extends TargetDescriptor {
  descriptorVersion: 1;
  productName: "disl";
  extensions: [".disl"];
  manifestKey: "disl";
  syntax: "./syntax.ts";
  declarations: "./declarations.ts";
  tags?: "./tags";
  contracts?: "./contracts.ts";
  target: "html" | "tree" | "preact-jsx" | ...;   // or its own emitter via load()
  allowProjectSyntax?: boolean;                   // default false
  editor?: { languageId: "disl"; grammar: "./editor/disl.tmLanguage.json" };
}
```

## How it embeds MX

The compile path is the existing one with the descriptor supplied once:
`compileWithDescriptor(source, file, descriptor, options)` resolves the table
(the language's full default row, overlaid by the consumer's manifest only if
`allowProjectSyntax`), loads the syntax module, merges the language's tags
with the consumer's, picks the target, compiles. Tools take the descriptor
from `package.json#mx.target` (an MX project) or from the language's CLI and
editor extension (a layer-3 project). A file whose extension is in a loaded
descriptor's `extensions` routes to it; `.<segment>.mx` lookup is the
fallback.

Core tags are hidden or renamed through `declarations.dispositions`; the
language's own `{% if %}` or `<when>` is a block form or a tag lowering to the
same IR. Expressions stay TypeScript until the expression-language axis
exists.

## Consumer project

```
my-app/
  package.json     "disl": { "target": "html", "tags": "./tags" }   (no "mx" key)
  src/pages/home.disl
  tags/card.disl   discovered like tags/*.mx, by the language's extension
```

`manifestKey` makes the scan and host-policy readers read `package.json#disl`
with the shape they read `package.json#mx` today; the shared manifest reader
is keyed once more by the key.

## Build, test, publish

1. `create-dialect` scaffold writes the anatomy with the `.mx` default row copied.
2. `mx dialect check` validates the descriptor, compiles the syntax module,
   validates the resolved table, loads tags and contracts, runs the oracle
   fixtures with the descriptor as the host row.
3. `mx dialect editor` builds the VS Code extension from the template; the
   language server and the TypeScript plugin are MX's, configured with the
   descriptor.
4. `npm publish`; `vsce publish`. The language pins core exactly, as the tools
   pin TypeScript's peer: two core instances break `instanceof` across the
   language-server boundary.

## What layer 3 does not allow

- A new IR kind: every emitter implements one method per kind; a kind the
  hosts do not know is a silent drop. A language composes kinds through
  `ctx.build`; a needed kind is a core decision.
- A different tag-open character or attribute grammar.
- A different expression language, until the axis is designed.
- A state-level hook.
- Project-level syntax overlays unless the language opts in.

## Effort after layer 2

| Item | Size |
|---|---|
| `extensions`, `manifestKey`, `productName` on the descriptor; routing by extension | S |
| `compileWithDescriptor` | S |
| `manifestKey` in the scan and host-policy readers | S |
| `mx dialect check` over the oracle harness | M |
| VS Code extension template and `mx dialect editor` | M |
| `descriptorVersion` 1 freeze, decision entry | S |
| `create-dialect` scaffold | S |

All packaging over the layer-2 seams.

## Open questions

1. Does a language's extension also name its tag files (`tags/card.disl`)? Proposed: yes.
2. May a language expose several targets under one manifest key? Proposed: yes, a list with a default, as `host.default` is today.
3. Is the Marko compatibility ADR a constraint on languages? Proposed: no; parity is a property of the `.mx` default row.

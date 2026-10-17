---
title: "Roadmap"
description: "What the MX 1 beta is, and what MX 2 adds."
---

# Roadmap

## MX 1 beta

The MX 1 beta is the language and its hosts: `@mxlang/core`, which also exports the IR entry point for dialects and non-rendering consumers, and the host packages (`@mxlang/host-*`) with their editor and type-checking tooling. The html target (`@mxlang/target-html`) is a public package beside them.

Releases are `0.1.0-alpha.N` prereleases on the project's own registry until the first public publish. That publish is a plain `0.1.0` on npm, and it ships once MX 2 and the framework targets have landed. Every package's README notes that the API may change until 1.0.0.

## MX 2

MX 2 adds native-component targets: a framework's components compiled from MX directly, rather than MX regions lowered to the framework's JSX. It also takes up the items on the [Deferred to MX 2](/divergences-and-mx-2/) list (tag params on `<if>`, tag params on native HTML elements, and the rest). Any syntax change lands together with its grammar and language-server support, so editors never break.

Custom tags have two layers, L1 templates and L2 sidecar hooks, and no third: no hook ever sees a parser AST. The tag-resolution `resolve` hook name is reserved for MX 2.

`.marko` files are not an MX input. A Marko-to-MX converter may come later, as a separate tool.

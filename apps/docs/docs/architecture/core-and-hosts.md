---
title: "Core and hosts"
description: "How @mxlang/core, targets and hosts divide responsibility."
---

# Core and hosts

`@mxlang/core` is the half of MX that is the same for every output. It parses a file with MX's own front end (`@mxlang/parser`, producing the MX AST in `@mxlang/babel`'s vocabulary), validates it against the active target's declarations, and lowers it into a small target-independent [IR](/architecture/ir/). Everything after that is a target's job.

## Resolve, then emit

The pipeline has three stages, with lowering and emission kept as separate interfaces:

1. **Parse.** The MX front end produces the MX AST for a whole file or a region.
2. **Lower.** `lower()` validates structure and expands [custom tags](/custom-tags/) recursively, until only ordinary IR remains: if-chains, normalized loops, grouped attribute tags, `define`/`const`/`static` hoists, component invocations, text and interpolations, binding scopes, and a position on every node. It asks the target's `HostDeclarations` the questions it cannot answer itself: is this name an element or a component, is this tag inert, unsupported or an error here, how should this modifier be refused in your words.
3. **Emit.** The target's `Emitter<Out>` walks that IR, one method per kind, driven by core's `drive()`. An emitter never sees an AST node or a custom-tag call; a lower-time decision reaches it through `DelegatedTag.data`.

Keeping the two apart stops a target from re-deriving structure while it prints, and makes the IR the only thing an emitter needs to understand. The IR is public (`@unstable`): core's [IR entry point](/architecture/ir-entry/) returns it to programs that do not render, and a [dialect](/custom-tags/dialects/) may register node types whose lowering produces IR of registered kinds.

Control flow lowers at compile time to each target's own idiomatic shapes. Tag params on any tag make its children a function (`<For|item, i| each=xs()>` is `<For each={xs()}>{(item, i) => …}</For>`), so every framework component that takes a render prop is usable from MX. An attribute tag `<@name>` becomes the callee's named prop `name`, carrying Marko's attribute-tag record. Capitalized tags pass through as components; lowercase core tags lower to the target's shapes.

## Targets and hosts

A **target** is an output format a file compiles to: an HTML string, JSX, an Angular template, an Astro template. A **host** is a framework MX lives inside: Solid, React, Preact, Hono, Astro, Angular. Targets are what gets registered; a host is built on one target.

| Target | Hosts built on it |
| --- | --- |
| `html` | none (hostless) |
| `jsx` | `preact`, `react`, `hono`, `solid` |
| `astro-html` | `astro` |
| `angular-template` | `angular` |

A target owns general hook points with defaults: control-flow lowering for `If`, `For`, `Try` and `Await`, binding reads and writes through the binding registry, and output flavour (import source, `class` or `className`, event casing, escaping). A host descriptor is a bag of handlers for its target's hooks plus tag resolution and file kinds (`.solid.mx`, for instance). The same mechanism serves in-tree and [third-party](/targets/third-party-targets/) hosts.

> Not released yet: the four JSX hosts still register their own targets (`preact-jsx`, `react-jsx`, `hono-jsx`, `solid-jsx`) until they move onto the shared `jsx` target.

Each target exports one **descriptor**: plain data (its name, declarations, required `defaultTag`, an optional `host` part with host-level facts) plus a lazy synchronous `load(core)` that receives the tool's own core and returns the compile entry. Tooling looks targets up in a table instead of branching on a name. Core holds no list of host or target names: wherever it would otherwise skip validation it takes the lookup as an explicit parameter, and the built-in descriptors and the default target live in the registry package `@mxlang/targets`. Core contains nothing specific to one host; when a host needs something from core, core offers a generic opt-in hook. How a project picks its target is in [Host and target selection](/specification/#the-mx-language-13-host-semantics-table-135-host-and-target-selection); a project with a dialect and no target is check-only.

The name `data` is reserved for a future evaluated target that compiles a file to `(input) => value` with control flow and `${}` evaluated, an emitter over the IR like any other. There is no tree target: a program that reads markup as a tree calls core's IR entry point.

## What belongs where

| Belongs to core | Belongs to a target or host |
| --- | --- |
| Parsing, and the structural tag lowerings (`<if>`, `<for>`, `<define>`, `<const>`, statement tags) | The disposition table: which tags are inert, unsupported (with a hint to the host's own equivalent) or errors here |
| The reactive tags as language: parsing them, and the errors every target shares | Lowering the reactive tags to the framework's own state, or refusing what the target cannot express |
| Guards against unsupported fields and node shapes | Component-versus-element resolution |
| Resolving the MX AST into the IR | Emitting each IR kind into the target's own syntax |
| Expanding custom tags into ordinary IR | Defining the primitive a custom tag may request by name |
| The front doors (`compileSource`, `parseFragment`, the IR entry point) | Structured attribute values (`class`, `style`), attribute order, modifiers |
| The `escape` helper and positions on every IR node | Its own integrations: a Vite plugin, a Bun loader, a TypeScript plugin |
| Language-level spelling hints for names authors bring from React or Angular, whose identifiers and messages name no framework | Hints that name the host's own framework and its equivalents |

A construct is refused only because the target cannot express it, never because the implementation cannot yet ([the capability test](/specification/#the-mx-language-11-stateful-tags-the-capability-test)). See [Declarations and hooks](/architecture/policy-and-hooks/) for the contract a target implements.

## Two front doors

**`compileSource(source, filename, policy, host?)`** compiles a whole file. This is what a target uses when the entire file is MX: the html target's `.mx` files, for example.

**`parseFragment(source, { filename, baseOffset, baseLine, baseColumn })`** parses an MX *substring* embedded inside a larger file, with every position shifted so error locations and source maps point at the right place in the outer file. Astro's `.astro.mx` templates (MX after a frontmatter fence) and the region files (`.solid.mx`, `.react.mx` and the others: MX in JSX's position inside a TSX module) use this door.

## Statement-shaped and expression-shaped targets

Every target emits from the same IR, but targets fall into two shapes, and the difference shows up in the emitter rather than in core.

**Statement-shaped.** The html target writes into a sink, one statement at a time: `__mxOut.write("...")`, one block per function, in a conventional module (a runtime import with `escape` aliased to `__mxEscape`, the author's hoisted statements, a `render(input, out)` sink entry, and one branded default export that renders into a fresh sink and returns the string; see [the render entry](/specification/#the-mx-language-13-host-semantics-table-138-the-html-target-render-entry-and-sink)). An `<if>` becomes a real `if` statement.

**Expression-shaped.** JSX has no equivalent of `__mxOut.write("...")`, so the JSX and `.astro.mx` emitters produce a single expression instead. An `<if>` becomes a ternary, a `<Show>` or a `<Switch>`: whatever that framework's own author would have written.

## What a target emits, and what it does not

A target emits its framework's **ordinary public input language**: plain JSX source text plus a source map, or an ordinary function body that writes strings into a sink, exactly the shape a human would have written by hand. It never hands over a Babel AST, so it works with toolchains that accept only source text (Solid's native `@solidjs/compiler`, for one). The framework's own toolchain then runs over that text unmodified.

This keeps a target from becoming a second compiler for its framework. MX prints; Solid's compiler, Babel or the bundler compiles. A target that emitted optimized or pre-compiled output would have to track its framework's internals forever.

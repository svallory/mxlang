---
title: "Spans and mappings"
description: "How MX maps emitted output back to the original source."
---

# Spans and mappings

When the core lowers structural tags (e.g. `<if>`, `<for>`) to a host's representation (like ternary chains or `.map` calls), the emitted code must still map back to the original source positions in the `.mx` or `.solid.mx` file. This is crucial for TypeScript type checking (the TS plugin) and editor diagnostics.

## Position Mapping

The core parses the source with MX's front end (`@mxlang/parser`), whose nodes carry file offsets, and records source spans for elements, tags, attributes, and expressions. Lowering that AST into the IR and emitting through a host emitter keeps those spans and turns them into mappings.

- **Expressions:** an expression is **sliced from the original source text** rather than printed back from a parsed node. That is deliberate, and it is what keeps TypeScript syntax intact: for a build, the core strips TypeScript from every parsed expression before lowering (the `stripTypes` option), so a node printed back would be missing its type arguments, while the source text keeps exactly what the author wrote. `${pick<string>("lo")}` emits `pick<string>("lo")`, type argument and all.
- **Component tags and attributes:** the spans for a component's tag name, each attribute name, and each `<@name>` attribute tag are recorded, so passing a wrong prop to an imported `.mx` component reports the error *at that attribute* rather than at the opening tag or the whole call.
- **Hoisted blocks:** `static` blocks, `import`s, `export`s and `export interface Input` map as one span covering the statement's own source range, so a diagnostic inside one lands within the author's own line.

A mapping is emitted only when the code is found in both texts — the source span must contain it, and the generated text must still contain it. When either lookup fails, **no mapping is emitted at all**, deliberately: mapping to a plausible-but-wrong column is worse than not mapping. A diagnostic falling outside every mapping is not surfaced against the MX file.

## Known gaps

Two, both narrow:

1. **A bare generic call in tag or attribute position.** Inside `${}` a generic call is fine. Written bare — directly as an attribute value, outside any `${}` — the `<` is read as the start of a tag, so `title=pick<string>("lo")` misparses rather than losing its types in the map. Wrap it in `${}`.
2. **Attribute-method bodies.** A method written directly on an attribute (`onClick() { … }`) reaches the emitter with a synthetic body, so column mapping inside that body can drift.

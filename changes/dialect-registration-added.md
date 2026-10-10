---
packages: [core, parser]
kind: Added
---

**Dialect discovery (decision 212, `@unstable`).** New exports from `@mxlang/core`:

- `DIALECT_MANIFEST_KEY` (`"mx.dialect"`) and the `DialectManifest` type.
- `discoverDialects(projectFile)`: the dialects a project's direct dependencies declare, read statically from their `package.json` files without loading any dialect's code. Tools use it to learn a dialect's extensions.
- `routeDialect(filename)`: the dialect that claims a file's extension, or `undefined`.
- `MX_DIALECT`: MX's own dialect identity, `{ id: "mx", name: "MX" }`.
- `DialectModule`: the type of a dialect module's default export. It is a `Dialect` whose `id` and `name` may be left to the manifest.

**The node-type registry (decision 202 item 3, `@unstable`).** One key space, `id:Type`, covers every node the MX AST holds. Core is dialect zero (`mx`), and its MX AST types are registered with their child keys. Core still lowers its own types directly.

- `Dialect.id` and `Dialect.name` are required. The `id` is the registry namespace.
- `Dialect.nodeTypes`: `{ Type: { keys, parse(text, span, kit), print(node), lower(node, ctx) } }`.
  - A syntax table row names one with `node: { type, dialect }`, in an attribute or line list only. The row's `match` ends the node.
  - Core calls `parse` once per trigger, sets `type` and `span` on the fields it returns, freezes the node, and hands it to `lower`. `lower` gets the same `ctx` constructors as `lowerTrigger`.
  - A whole attribute value keeps the node: `ctx.attribute(name, { kind: "node", node, value })` becomes a static `Attr` with a new `node?: DialectNode` field beside its `value`. `IR_VERSION` goes from `1` to `2` for it.
  - `kit.fail(message, { at?, code? })` raises a positioned error.
  - A malformed node type, or a row naming an unregistered type, another dialect's type or core's `mx:` types, is an error in the dialect's module at 1:0. A node-type row in an expression list is refused by the parser.
- New exports from `@mxlang/core`: `CORE_DIALECT`, `nodeTypeRegistry`, and the types `Dialect`, `DialectNode`, `DialectNodes` (augmentable), `NodeKit`, `NodeType` and `RegisteredNodeType`.
- `Dialect.tagRules?: "html" | "markup" | "none"`: the core tag-rule preset a dialect's files parse with (decision 204, ruling 211; decision 212 item 8). A dialect that states none gets `html`. The field is validated today; the preset wiring lands with core's tag-preset tables.
- `@mxlang/parser`'s table validation accepts `node: { type, dialect }`.

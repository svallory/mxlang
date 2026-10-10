---
packages: [core, parser, babel]
kind: Changed
---

A syntax-table row in attribute or line position now goes through one claim process. At a match, the parser asks the row's node type to claim the text: the type's `parse(text, span, ctx)` returns the node's fields, or `undefined` to decline. A claimed node stays in the MX AST at its position, typed by its registry key (`ref:Ref`), and lowering calls the `lower` of that type. A declined text parses as if no row had matched: an attribute name, or a tag on its line.

- `NodeType.parse` takes a `ClaimContext` (`position`, `tag`, `attribute`, `fail`) in place of `NodeKit`, and may return `undefined`. `NodeKit` is no longer exported; `ClaimContext` and `ClaimPosition` are.
- `{ call }` rows and the `"attribute"` spelling are core's `mx:Trigger` node type. A row may also name `mx:Trigger` (the same as `{ call }`) or `mx:Expression` (declines every text in these positions).
- The one error the claim owns is a row naming a type that is not registered: ``the `ref` trigger names `ref:Path`, which is not a registered node type (a row can name `mx:Trigger`, `mx:Expression`, `ref:Ref`)``. A row naming another dialect's types gets a note that this is not supported yet. This replaces the earlier per-case texts ("which the dialect does not register", "core's own node types are not trigger targets", "no dialect registers node types here").
- A claimed node's `=value` and arguments are stripped of TypeScript like a `{ call }` row's, and a dialect type's registry `keys` end with `value` and `args`.
- Line and attribute hooks (a node type's `lower`, a `{ call }` row's `lowerTrigger`) run once each, in source order; a body's line trigger is lowered when the walk reaches it, no longer after the rest of the body it sits in. The first failing trigger in the source is the file's error.
- A node type's `parse` errors are raised while the file parses, at the trigger, and stop the parse: such an error is the file's error even when an earlier line holds a parse error. Their texts now say `ctx.fail`; a non-object result says "…, or `undefined` to decline the text"; a result holding core's fields names only the fields it holds.
- `@mxlang/parser`: `createParser` and the front end's `parse` take a `claim` option (`TriggerClaim`). With the default table it is never called.
- `@mxlang/babel`: the MX AST gains `MxRegisteredNode`, a dialect's node in an attribute list or body.

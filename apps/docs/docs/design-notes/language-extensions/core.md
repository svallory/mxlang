---
title: "Language extensions: the core"
description: "What stays fixed under every extension layer: Marko's grammar on the default row, the syntax table's shape, the parser's event boundary, the IR, and the shared attribute-tag runtime shape."
---

# The core

**Status:** accepted design (decisions 183 and 184, 2026-10-07), not released. Marko behavior below
was probed on marko 6.4.0, `@marko/compiler` 5.42.10, htmljs-parser 5.18.0.

The core is what every layer builds on and none may change: the parser and
its default row, the IR, the lowering driver, and the runtime shapes the
hosts share.

## The default row is Marko's grammar

A `.mx` file in a project that declares no syntax parses exactly as Marko
parses a `.marko` file. The Marko parity oracle holds on this row and only
here. Consequences, each checked against Marko:

| Form | Marko 6.4.0 | MX core |
|---|---|---|
| `<a#x=1>` | `<a value=1 id=x>` | same |
| `<a :>` | `<a value:>` (attribute `value:`, empty) | same; upstream proposal: report `Invalid attribute name.` |
| `<a :b(x)>` | error: ``Unsupported arguments on the `value:b` attribute.`` | same message |
| `<input :email>` | attribute `value:email` | same; the name sugar is a layer-2 trigger in Mesh |
| `<div #id>`, `<div .c>`, `<div=x #id>` | error: `Invalid attribute name.` | same; spaced sugars are layer-2 triggers in Mesh, and an upstream proposal (error space, non-breaking) |
| `<a #x=1>`, `kind #name(p) { b }` | `Invalid attribute name.` / "The value attribute cannot be a function." | same; the former MX readings are withdrawn |
| `<if(x)>` | error: "Tag does not support arguments. Write the condition as a value attribute instead: `<if=condition>`." | same message |
| `x=:draft`, `{ k: :a }` (atoms) | syntax error | same; atoms are a layer-2 trigger in Mesh |
| `<div class="a" id="x" class="b">` | last wins, `<div id=x class=b>` | same |

What remains different from Marko lives in the hosts, not the core: how a
JSX emitter binds `this` in an event handler, how `<define>` fills params
from attribute tags, calling a plain function as a dynamic tag, React's
`<try>` mapping, one text node per placeholder on JSX hosts. Each is a target's
choice because the target is not Marko's runtime, and each is documented on
its host page.

## The syntax table

The parser takes one plain-data object per parse. The default row is a
constant equal to today's grammar.

```ts
interface SyntaxTable {
  placeholder: { open: string; close: string } | null;   // "${" and "}"; "$!{" is derived
  inlineScript: { trigger: string } | null;              // "$ " at line start
  blockTag: { open: string; close: string } | null;      // null on the default row
  filter: { open: string; close: string } | null;        // null on the default row
  concise: boolean;                                      // true on the default row
  expressionTriggers: Trigger[];                         // empty on the default row
  attributeTriggers: Trigger[];                          // empty on the default row
  textTriggers: Trigger[];                               // empty on the default row, always
  tagTypes: Record<string, TagType>;                     // from the taglib and discovered parseOptions
  expressionLanguage: "ts";                              // reserved
}

interface Trigger {
  id: string;
  chars: string;                     // first characters that arm it: ":" or "A-Z"
  match: string;                     // anchored regex source, RE2 subset
  standIn: "number" | "identifier" | "keep";
  node: "string" | "identifier" | "attribute" | { call: string };
  terminatesValue?: boolean;         // attribute triggers: a space then this ends the preceding value
}
```

**Not in the table, on purpose:** the tag-open character, the tag-name
grammar, attribute syntax beyond the first character of a name, string and
comment forms. Each is wired into every parser state, both tree-sitter
grammars, the TextMate grammar and the parity; changing one is a different
parser.

**Resolution.** `defaultRow(fileKind)` overlaid by the nearest
`package.json#mx.syntax`, validated, frozen, hashed; compiled tables are
cached by hash. A dependency's files use the dependency's manifest.

**Validation**, positioned at the manifest or descriptor that contributed the
entry: two triggers on one first character with overlapping matchers; a
trigger starting on an expression token (`$`, `_`, a letter, a digit, a quote,
a bracket) without `standIn: "identifier"` or `"keep"`; `placeholder.open`,
`blockTag.open`, `filter.open` not pairwise distinct, or starting with `<`; a
text trigger on `<`, `$`, `/`, `\` or a newline; a matcher outside the RE2
subset.

## The event boundary

The parser reports through handlers (`onText`, `onPlaceholder`,
`onOpenTagName`, ...). That set is the parser's contract and the shape a
native lexer would emit. Every handler is fire-and-forget. The one handler
that returns a decision today, `onOpenTagName` returning a `TagType`, is
replaced by the `tagTypes` field, computed before the parse from the same
information. Three events are added: `onTrigger(id, start, end, standIn)`,
`onBlockTag(start, end, openEnd, closeStart)`, `onFilter(name, bodyStart,
bodyEnd)`.

## Hooks

Post-parse only, plain functions, declared by a syntax module (layer 2) or a
descriptor (layer 3):

- `lowerTrigger(id, text, span, ctx)` builds the node a trigger produced;
  default implementations cover the `node` kinds of the table.
- `lowerBlockTag(text, span, ctx)` turns a block form into IR through `ctx.build`.
- `lowerFilter(name, body, span, ctx)` returns IR for a filter block.
- `afterLower(ir, ctx)` runs once per unit after lowering, before emit.
- `productName` names the language in every diagnostic.

## Attribute tags: one runtime shape

Every host emits Marko's attribute-tag record: the first occurrence's
attributes are the record's own properties, later occurrences live in a
hidden `rest` list, and `Symbol.iterator` yields them in order. MX adds a
prototype with `map`, `filter`, `length`, `at` and `toArray` over that
iterator. Own-property semantics are unchanged, so code written for Marko
(spread, `for of`, `[...x || []]`, `x.title`) behaves identically; prototype
members are neither spread nor serialized. The type `AttrTag<T>` is a
supertype of `Marko.AttrTag<T>`. An absent tag is `undefined`.

Cardinality is **not** read from a callee's `Input` type. The emitted code of
a template never depends on a type: types are erasable, and output that
depends on which file module resolution finds for a callee differs between
tools. A contract may later declare `attributeTags.x.repeat` to receive a real
array, which is declaration-driven and local to the tag, the mechanism Marko's
own `marko-tag.json` uses.

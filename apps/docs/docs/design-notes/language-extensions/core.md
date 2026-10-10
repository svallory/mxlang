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
  lineTriggers: Trigger[];                               // empty on the default row; start of a tagless concise line
  valueTriggers?: Trigger[];                             // absent on the default row; a whole attribute value
  textTriggers: Trigger[];                               // empty on the default row, always
  tagTypes: Record<string, TagType>;                     // from the taglib and discovered parseOptions
  expressionLanguage: "ts";                              // reserved
}

interface Trigger {
  id: string;
  chars: string;                     // first characters that arm it: ":" or "A-Z"
  match: string;                     // anchored regex source, RE2 subset
  standIn: "number" | "identifier" | "keep";
  node: "string" | "identifier" | "attribute" | { call: string } | { type: string; dialect: string };
  terminatesValue?: boolean;         // attribute triggers: a space then this ends the preceding value
  value?: "refuse";                  // attribute triggers: `=`, `:=` or `(` after it is a parser error
}
```

In attribute, line and value position every row goes through one claim
process. The row's node type is asked to claim the matched text: its `parse`
gets the text, the span and the context (`ctx.position` is `"line"`,
`"attribute"` or `"value"`), and returns the node's fields or `undefined`.
Fields put a registered node in the MX AST at that position, and lowering
later calls that type's `lower`. `undefined` declines: parsing continues as
if no row matched. A `{ call }` row and `"attribute"` are core's
`mx:Trigger` type, which always claims; `{ type, dialect }` names a type of
the row's own dialect, or one of core's three: `mx:Trigger` (attribute and
line), `mx:Expression` (every position; it always declines) and `mx:String`
(value only). The one error the claim owns is a row naming a type that is
not registered, in that position. A row naming another dialect's types is
not supported yet.

`valueTriggers` arm on the first character of an attribute's `=value`, a
tag's default value included. The parser already knows where the value
ends, so the row's `match` must cover the whole value and only decides
whether the row is asked; a `:=` value, a spread, a trigger's own `=value`
and a statement's words are never asked. A value row names a node type
(`{ type, dialect }`) and nothing else. The claimed node is the
`MxAttribute`'s `value`; its `lower` returns the string every target emits
(the static `Attr` keeps the node as `node`) or `ctx.expression(node)`.
`mx:String` claims a quoted value as its contents (one-character escapes
resolved; any other escape declines) and other text as itself, so only a
value a row claims becomes an `MxString`. A claimed default value also ends
where a space and a `terminatesValue` attribute row follow it:
`belongs-to=:List :list` is the default `:List` and the attribute `:list`.

`lineTriggers` (decision 182, addendum 1) arm at the start of a tagless
concise line, with or without an `=value` after the matched text, and lower
through `lowerTrigger` to a `{ call }` node: a child tag of the enclosing
block. They generalise `inlineScript` (the `$ ` line). Validation refuses a
line trigger armed on `<`, `-`, `/`, `@` or `$`, because those start a tag, a
delimited block, a comment, an attribute tag and an inline script.

**Not in the table, on purpose:** the tag-open character, the tag-name
grammar, attribute syntax beyond the first character of a name, string and
comment forms. Each is wired into every parser state, both tree-sitter
grammars, the TextMate grammar and the parity; changing one is a different
parser.

**Resolution.** `defaultRow(fileKind)` overlaid by the nearest
`package.json#mx.syntax`, validated, frozen, hashed; compiled tables are
cached by hash. A dependency's files use the dependency's manifest.

**Validation**, positioned at the manifest or descriptor that contributed the
entry: two triggers of one list on one first character (any shared first
character is refused, since overlap of two matchers is not decidable cheaply); a
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
descriptor (layer 3).

A **syntax module** is what `package.json#mx.syntax` names when its value is a
string (a package name, or a path relative to the manifest, resolved like
`mx.contracts`); its default export is
`{ table, lowerTrigger?, lowerBlockTag?, lowerFilter?, afterLower?, contractFields?, checkContract?, describeAttribute?, productName? }`.
`table` overlays the `.mx` default row with the fields an inline `mx.syntax`
may set. An inline object stays a table only. A trigger whose `node` is
`{ call }` needs the module's `lowerTrigger`: a `{ call }` in an inline
`mx.syntax`, or in a module without `lowerTrigger`, is an error at the
`mx.syntax` key. A tool that builds its own table passes the module as the
`syntax` option of `compileSource`, `parseFragment` or `lowerSource`.

- `lowerTrigger(id, text, span, ctx)` builds what a `{ call }` trigger
  produces. `ctx.position` says where the trigger sits (`"expression"`,
  `"attribute"`, `"line"`) and `ctx.value` is its lowered `=value` (or
  `null`). Three constructors, one per position, are the only way to build
  anything:
  - `ctx.expression(node)`: a Babel node that replaces the trigger's stand-in
    in the expression's payload. The expression's emitted code carries the
    node printed (`&status` becomes `self.status`), as it carries an atom's
    string literal; offsets still slice the authored text.
  - `ctx.attribute(name, value)`: a named attribute. `value` is `true`, a
    string, a `ctx.expression` result, or a whole-value
    `{ kind: "atom" | "member", name }`.
  - `ctx.child(tagName, attrs)`: a child tag of the enclosing body, built
    from `ctx.attribute` results. It goes through the normal tag path, so
    contracts apply to it.
  - `ctx.shorthand("id" | "class", name)`: in an attribute list, exactly
    what Marko's tag-adjacent `#name` / `.name` sets, with Marko's rules
    (one id; a class merged with the tag's other classes in written order).

  An attribute-list hook may return a non-empty list of attributes and
  shorthands (`:x() { … }` is a `name` and the default value; `#main.big` an
  id and a class). `ctx.attribute(null, value)` sets the tag's default value
  (`<tag=value>`). `ctx.attribute`'s third argument takes `authored` (the
  attribute is spelled by the trigger's text: diagnostics name the text, and
  a whole-value atom so placed also satisfies a `string` or `enum` slot as
  its name) and `once` (a second attribute of that name on the tag is an
  error with this message). An attribute trigger written right before
  `(params) { body }` takes it as its value: `ctx.value` is then an opaque
  method value that `ctx.attribute` places. In an expression, `ctx.use` says
  how the operand is used (`"member-object"`, `"callee"`, `"unary"` with
  `ctx.operator`, `"spread"`, `"key"`, or `null`), so a module can refuse a
  use in its own words with `ctx.fail(message)`, a positioned error at the
  trigger. Core still refuses a property name after the hook returns.
  A replacement marked `extra.mxAtom` is spliced and mapped as an atom.

  Core positions the result from the trigger. A result that does not fit
  the position, a `=value` the hook leaves out, a trigger written where a
  name is declared (`(&a) => 1`), and a trigger used as a property name
  (`{ &a }`, `{ &a: 1 }`) are positioned errors. The built-in
  `node` kinds lower in core with no hook: in an expression, `"string"` (a
  string literal of the text) and `"identifier"`; in an attribute list,
  `"attribute"` (an attribute named by the text after its sigil, bare or
  with its `=value`).
- `lowerBlockTag(text, span, ctx)` turns a block form into IR through
  `ctx.build`, the builders a custom tag's `transform` gets.
- `lowerFilter(name, body, span, ctx)` returns IR for a filter block, through
  `ctx.build`. A block tag or filter whose module has no hook for it stays a
  "has no lowering yet" error.
- `afterLower(unit)` runs once per unit after lowering, before `finalize` and
  emit, after core's own checks. `unit` is a frozen, read-only view
  (`LoweredUnit`), never core's internal context:
  - `file` and `source`; every span is a UTF-16 offset into `source`.
  - `calls`: every custom tag call that has a declaration, in the order core
    lowered them. A call (`ContractCall`) has `tag` (the canonical name),
    `span`, `nameSpan`, `contract` (deep-frozen copies of the declaration's
    `attributes`, `attributeTags`, `children` and `declares`, plus the
    module's claimed tag keys),
    `attrs`, `attributeTags` and `ancestors`.
  - An attribute (`ContractAttr`) is its `name` and its `value` node,
    read by `type`: `mx:String` (`value`, `span`), `mx:Expression` (the
    lowered `node`, `code`, `span`, `bound`), the node a value row claimed
    when its type lowered it to a string (its registry key, as parsed,
    frozen; a claimed `mx:String` also has `raw`, `start` and `end`), or
    `null` for a bare attribute. A claimed node whose type lowered it to
    `ctx.expression` is the value that expression makes, as if written
    there: `mx:Expression`, or `mx:String` for a string literal (`mx:Atom`
    when the literal is atom-marked). Each carries `nameSpan`,
    `label` (how core's diagnostics name it) and `authored` (the sugar that
    wrote it). A spread is `{ spread: true, span }`.
  - Removal work, not part of what `ContractAttr` offers: a value typed
    `mx:Atom` or `mx:Member` (`name`, `span`) is a leftover mark of the atom
    and member sugars, kept only until the atoms-and-members dialect carries
    them as its own value nodes. Do not build on it.
  - `attributeTags` nest to any depth. Each carries the declaration its
    parent's contract has for it, wildcards resolved, as `contract`.
  - `ancestors` are the authored tags around the call, outermost first,
    ending with the call itself: `{ tag, span, scope }`. `scope` is an
    opaque, frozen identity, one per tag instance, so it can key a map of
    what that instance owns.
  - `declared`: what `analyze` hooks declared with `ctx.declare(kind, name,
    { span, scope })`, in call order.
  - `fail(message, { at?, code?, also? })` throws the positioned error
    lowering reports. `at` is a span inside the document; without it the
    error is file-level (no position, as a registration error). `code` is
    carried as `diagnosticCode`, and `also` as the error's `spans` (a
    duplicate's first site). It is fatal, as core's own checks are.
  - `warn(message, at?)` records a warning.
- `contractFields: { attribute?, tag? }` lists the contract keys the module
  owns. A key core does not know is a registration error unless the file's
  module lists it. A listed key passes registration untouched, in
  `customTags`, `mx.contracts` and sidecars alike, and reaches
  `afterLower` on `ContractCall.contract`. Core never checks a listed key:
  - Of core's own keys only the atom contract's can be listed: `values`,
    `pattern`, `ref` (attribute) and `declares` (tag).
  - Listing one turns core's registration check and its file-level check
    of that key off.
  - Core keeps the whole-value shape check (`type: "atom"`, `"member"`,
    decision 156 addendum 6; decision 183 addendum 2) and `ctx.declare`.
    Core never reads a claimed key to word that check: the module's
    `describeAttribute` does. A plain string against a declaration with a
    claimed `ref` is left to the module's `afterLower` (which can list the
    names). Core's own shape error for it is queued behind that hook, so it
    is raised if the module reports nothing, and never before the module's
    own diagnostics.
  - Claims are per key and independent. With `declares` claimed and `ref`
    not, core still reads the declared names (raising nothing about them)
    to resolve its own `ref` check. A contract's `declares` reaches the
    module whether it claims it or not.
  - A dialect that owns atoms (Mesh's) claims all four. It checks their
    shape in `checkContract` and their use in `afterLower`. Core ships no
    such module.
  - The claim follows the file's syntax. A discovery scan (`tags/`,
    `mx.tags`, `mx.contracts`) reads it from the file's nearest
    `package.json#mx.syntax`: an explicit `syntax` option is invisible to
    the scan. A scanned contract with a key only that option's module claims
    is refused at the scan, positioned like any registration error (the
    sidecar's file, or the contracts module at 1:0). Contracts passed as
    `customTags` follow the explicit option.
  - Completion facts (`CompileResult.atomFacts`, `atomCandidates`) stay on
    core's built-in path. A unit whose module claims the atom keys has none.
- `checkContract(tag, contract, ctx)` checks, at registration, every
  contract that uses a key the module claims, at any depth (attribute tags
  and inline `children["*"]` contracts included), whether the file calls the
  tag or not. `contract` is the same plain data `ContractCall.contract`
  carries. `ctx.fail(message, { code? })` raises a registration error where
  core's own lands: the sidecar's file, an `mx.contracts` module at 1:0, no
  position for the `customTags` option. It runs where core checks
  `declares`, before core's walk of the attribute declarations. When the
  file's `mx.syntax` module itself fails to load, a scan reports that
  failure instead of refusing a key the module might have claimed.
- `describeAttribute(declaration)` words what an attribute declaration that
  uses a claimed key accepts, for core's whole-value shape error: the text
  appended to it (`" (one of :a, :b)"`), or `""`. Without it, core's
  message names only what it knows.
- The contract data a module gets (`ContractCall.contract`, the
  `checkContract` and `describeAttribute` arguments) is a deep-frozen copy
  of the registered plain data; an expression's `node` is core's live node,
  to be read, never written.
- `productName` names the language in every diagnostic, unless the host
  names one.

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

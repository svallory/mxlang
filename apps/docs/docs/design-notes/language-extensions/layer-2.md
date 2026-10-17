---
title: "Layer 2: syntax"
description: "Project-scoped syntax extensions through the data-only syntax table: delimiters, triggers, block forms, filters, and the lowering hooks for the forms they add, and the hook that explains an unknown tag. In MX as dialects (specification §13.9)."
---

# Layer 2: syntax

**Status:** in MX: layer 2 is dialects and their syntax tables, specified in
[specification §13.9](/specification/). This page is the design argument.

> **Names in these pages.** A "syntax module" is now a **dialect**, found by
> file extension (`mx.dialect`, [specification §13.9.2](/specification/));
> `package.json#mx.syntax` is removed. The specification §13.9 states what
> shipped; these pages keep the design argument.

Layer 2 lets a project, or a package it depends on, change what the parser
recognises, through the [syntax table](/design-notes/language-extensions/core/#the-core-the-syntax-table)
and nothing else. A syntax module is a sidecar-shaped file (default export,
no top-level `await`, explicit extensions on relative imports) exporting a
partial table and the dialect's hooks (the lowering hooks, `afterLower`, the
contract hooks and `explainUnknownTag`). It is listed in
`package.json#mx.syntax`.

```json
{ "mx": { "syntax": ["@mesh/syntax"] } }
```

## Scope

Project-scoped. The nearest `package.json` upward from a file decides, for
every MX file under it of any file kind (`.mx`, `.solid.mx`, `.ng.mx`). The
file kind supplies only the default row. A dependency's own files parse with
the dependency's manifest, exactly as `mx.tags` resolves today. A package
that uses layer 2 ships its syntax module in its own manifest and therefore
needs nothing from its consumers.

Consequences a project accepts by declaring a syntax module:

- its `.mx` files are outside the Marko parity claim
- highlighting does not follow: TextMate and tree-sitter grammars are static,
  so project-level syntax gets semantic tokens from the language server or
  nothing; diagnostics and the type projection do follow, because they
  resolve per file already
- two modules claiming one trigger character with overlapping matchers is a
  registration error at the manifest

## What the table can express

| Field | Example | Lowering |
|---|---|---|
| `placeholder` | `{{ expr }}` instead of `${ expr }` | existing `Interpolation` |
| `inlineScript` | disable `$ ` lines | none |
| `blockTag` | `{% for x in xs %} … {% endfor %}` | `lowerBlockTag` builds `For`, `IfChain` through `ctx.build` |
| `filter` | `::markdown:: … ::` | `lowerFilter` returns IR |
| `expressionTriggers` | `:draft` (atoms), `%ui.save`, `Order Total` as one identifier | `lowerTrigger`; stand-in keeps the projection one-to-one |
| `attributeTriggers` | `:email` sets `name`, spaced `#id` and `.class` | `lowerTrigger` with `node: "attribute"` |
| `lineTriggers` | `&title`, `&amount=qty * price` at the start of a tagless line | `lowerTrigger` with `{ call }`; the result is a child tag of the enclosing block |
| `valueTriggers` | `to=~user.name`, `title="Hi"` as a whole attribute value | the named node type's `parse` claims the value (or declines it); its `lower` returns the string or expression the attribute holds |
| `textTriggers` | `%ui.save` in text | `lowerTrigger`; empty on `.mx`, for languages |
| `concise` | off | none |

A trigger is a first-character class plus an anchored matcher. The matcher
decides extent; the stand-in is the same-length text the expression parser
sees (`:a` is `0.` today for atoms); `node` says what core builds. Semantic
checks ("is this name declared") happen in `lowerTrigger` or `afterLower`,
never during lexing. A matcher may capture a terminator and close on it
(`closeFrom`), or declare `balance` for nested delimiters; both are data.

An attribute or line row may instead name a node type the dialect registers
(`node: { type, dialect }`). At a match, the type's `parse` claims the text
by returning the node's fields, and the node stays in the AST where the text
was; or it returns `undefined` to decline, and the text parses as if the row
had not matched (an attribute name, or a tag on its line). The type's `lower`
turns the node into core's shapes.

## The Mesh syntax set

Mesh is the first layer-2 user and the acceptance test. Its module carries
what used to be MX core:

- **Members** (`&name`) in all three trigger lists, one row
  (`{ id: "member", chars: "&", standIn: "identifier", node: { call: "member" } }`):
  in an expression `&status` lowers to `self.status` marked
  `extra.mxMember = { span, name }` (`[&a, &b]` is an array of marked
  members); after a kind (`sort asc &dueOn`) it is a static value
  `{ kind: "member", name: "dueOn" }`, one per name slot, checked by the
  contract type `type: "member"` (which also takes a value that is one
  member, `load=&visible`); on a tagless line (`&title`, `&amount=qty * price`) it is
  a `member` child tag with a static `name` and a dynamic `value`. `&&`,
  `a &b` and `&=` stay operators.

- **Atoms** (`:name` in expression position, nested atoms, `::name` reserved),
  with the contract vocabulary (`type: "atom"`, `values`, `pattern`, `ref`,
  `declares`) checked from `afterLower`.
- **Name sugar** `:name` as an attribute trigger: `<input :email>` sets
  `name="email"` in a Mesh project; in a plain MX project it is Marko's
  attribute `value:email`.
- **Spaced `#id` and `.class`** as attribute triggers whose matcher refuses
  `=`: `tag #id .class` and `tag=value #id .class` work, `tag #id=123` is the
  trigger's error. Tag-adjacent `tag#id=123` is Marko already. The trigger
  sets `terminatesValue`, so ` .class` after an attribute value ends the value
  rather than continuing a member expression.

**Unknown tags.** A tag with no contract can mean something in the dialect's
language. The dialect's `explainUnknownTag` hook says what, as the one error
for that tag, with its own message, code and position (specification §13.9.3).
It only explains: a dialect still cannot claim a tag it has no contract for, and
the answer is always an error, so no IR comes of it. Core calls it for the same
tag whether the file lowered or lowering failed elsewhere.

Mesh's syntax needs no "`:name` after a value" form (`belongs-to=:List :list`):
the member sigil `&` covers the reference in all three positions, so that
parser rule has no layer-2 user.

The rows Mesh's dialect owns (core ships none of them):

| Row | List | `chars` | `match` | Other fields |
|---|---|---|---|---|
| `atom` | expression | `:` | `::(?:NAME)?\|:NAME` | `standIn: "number"`, `{ call }` |
| `name` | attribute | `:` | `:` then a token | `terminatesValue` |
| `id` | attribute | `#` | `#` then a token (a chain) | `terminatesValue`, `value: "refuse"` |
| `class` | attribute | `.` | `.` then a token (a chain) | `terminatesValue`, `value: "refuse"` |
| `atom-value` | value | `:` | `:NAME` | `standIn: "keep"`, `{ type: "Atom", dialect: "mesh" }` |

`NAME` is `[A-Za-z_$][\w$]*(?:-[\w$]+)*`. `atom-value` claims a whole
attribute value `:NAME` as a `mesh:Atom` node, which lowers to the
atom-marked string literal the `atom` row builds, so the atom contracts read
it unchanged. Because a claimed default value ends at a spaced `name` row,
`belongs-to=:List :list` is the default `:List` and the name `:list`, refused
as the unknown attribute `value`. A token runs to whitespace, `=`,
`(`, `,` or the end of the tag or group. While both exist, a loaded row on a
character replaces core's built-in handling of that character in that
position (lexing, after-value rule, lowering).

`atom`, `name` and `member` are Mesh's forms. Mesh writes neither `id` nor
`class`, so its copy may drop both rows.

**Ownership.** Core exports no syntax module. Mesh's atoms, name sugars and
`&` members, and the corpus of Mesh files that pins them, live in Mesh; core's
own tests of the claim process use fixture dialects.

**`async` before a method value.** `kind async :name(p) { b }` reaches the
`name` hook as an async method (`ctx.valueForm` is `"async-method"`,
specification §13.9.5). A `:name` method has no async meaning, so a
dialect that owns the sugar refuses it at the `:name`, naming the form.
Without such a dialect, core reads the line as Marko does.

What a Mesh file reads differently from a plain `.mx` file once the move
lands: `#x=1`, `.x=1` and `#x(p) { b }` are refused; a bare
`:` after a value no longer ends it, and
`belongs-to=:X :x` splits only because the module's value row `atom-value`
claims `:X` and a claimed default value ends at the spaced `:x`; `a::b` after a word is TypeScript's error rather
than the reserved-token one; `::` inside a tag or attribute name is Marko's
reading; tag-adjacent `kind:name`, `<:name>` and `#id:name.class` are
Marko's readings (no trigger reaches a tag name).

Order of work: the table lands, MX's own atoms and sugars move onto it with no
behavior change, then the entries move to the Mesh package. The parser's
atom corpus becomes Mesh's table tests, run against the MX parser with the
Mesh table loaded.

## Performance

One array lookup per character in the content and expression states, the
same cost as today's `switch` on a character code. Matchers run only on a
trigger hit, anchored, bounded by the RE2 subset. Tables are resolved per
manifest (cached by mtime) and compiled per hash (cached per process).

## Not in layer 2

- A trigger on the tag-open character, or any change to attribute syntax
  beyond the first character of a name.
- A `scan(cursor)` callback: the one thing a native lexer cannot run. Extent
  comes from the matcher, `closeFrom` or `balance`.
- A text trigger on the `.mx` default row.
- Generated highlighting grammars.

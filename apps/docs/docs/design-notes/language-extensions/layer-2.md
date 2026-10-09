---
title: "Layer 2: syntax"
description: "Project-scoped syntax extensions through the data-only syntax table: delimiters, triggers, block forms, filters, and the lowering hooks for the forms they add. Planned."
---

# Layer 2: syntax

**Status:** planned (decision 182). Lands on the parser port before it freezes
(size M; L after).

Layer 2 lets a project, or a package it depends on, change what the parser
recognises, through the [syntax table](/design-notes/language-extensions/core/#the-core-the-syntax-table)
and nothing else. A syntax module is a sidecar-shaped file (default export,
no top-level `await`, explicit extensions on relative imports) exporting a
partial table and the four lowering hooks. It is listed in
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
| `textTriggers` | `%ui.save` in text | `lowerTrigger`; empty on `.mx`, for languages |
| `concise` | off | none |

A trigger is a first-character class plus an anchored matcher. The matcher
decides extent; the stand-in is the same-length text the expression parser
sees (`:a` is `0.` today for atoms); `node` says what core builds. Semantic
checks ("is this name declared") happen in `lowerTrigger` or `afterLower`,
never during lexing. A matcher may capture a terminator and close on it
(`closeFrom`), or declare `balance` for nested delimiters; both are data.

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

Mesh's syntax needs no "`:name` after a value" form (`belongs-to=:List :list`):
the member sigil `&` covers the reference in all three positions, so that
parser rule has no layer-2 user (decision 182, addendum 1).

The rows (`packages/core/src/syntax/atoms-sugars.ts`, `@mxlang/core/syntax/atoms-sugars`, combined
with the member row in `syntax/mesh.ts`, `@mxlang/core/syntax/mesh`, the module Mesh copies):

| Row | List | `chars` | `match` | Other fields |
|---|---|---|---|---|
| `atom` | expression | `:` | `::(?:NAME)?\|:NAME` | `standIn: "number"`, `{ call }` |
| `name` | attribute | `:` | `:` then a token | `terminatesValue` |
| `id` | attribute | `#` | `#` then a token (a chain) | `terminatesValue`, `value: "refuse"` |
| `class` | attribute | `.` | `.` then a token (a chain) | `terminatesValue`, `value: "refuse"` |

`NAME` is `[A-Za-z_$][\w$]*(?:-[\w$]+)*`. A token runs to whitespace, `=`,
`(`, `,` or the end of the tag or group. While both exist, a loaded row on a
character replaces core's built-in handling of that character in that
position (lexing, after-value rule, lowering).

What a Mesh file reads differently from a plain `.mx` file once the move
lands: `#x=1`, `.x=1` and `#x(p) { b }` are refused (decision 183); a bare
`:` after a value no longer ends it, and `belongs-to=:X :x` no longer splits
(decision 182 addendum 1); `a::b` after a word is TypeScript's error rather
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

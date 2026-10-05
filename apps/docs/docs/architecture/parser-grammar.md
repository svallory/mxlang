---
title: "The parser grammar"
description: "How MX source text is split into tokens, expressions and nodes, in every mode, for the MX-owned parser."
---

# The parser grammar

This document is the parser-level specification of MX: how source text is split
into tags, attributes, values, bodies, placeholders, scriptlets and text, in
HTML mode, concise mode, and the delimited HTML blocks. It is written to be
implementable and testable, not to be read as a tutorial.

It is **a draft for review by mx-lead**, who owns language design. Where the
language spec, the decision log and `divergences.md` disagree or are silent, the
disagreement is recorded in [Open questions for mx-lead](#open-questions-for-mx-lead)
rather than resolved here. Nothing in this document decides syntax.

## Status, scope and sources of truth

Decision 157 (2026-10-05) makes the MX parser and compiler MX-owned, written in
TypeScript, starting from the source of `htmljs-parser` 5.18.0 and
`@marko/compiler` 5.42.10 copied into workspace packages in this repo, with no
obligation to follow upstream (157, addendum 2). Marko byte parity is no longer a
requirement; **Marko's behaviour stays the default answer wherever MX has no
ruling of its own**, and a divergence needs a decision number and a row in
`divergences.md` (157.3).

Sources of truth, in this order:

1. the language spec, `apps/docs/docs/specification.md` (cited below as *spec
   §N*);
2. the decision log, `notes/decisions-2026-09-10.md` (cited as *decision N*);
3. `divergences.md` at the repository root and `fixtures/divergences.md` (cited
   as *divergence row "…"*).

The htmljs-parser fixtures and the Marko fixtures are **evidence of the default
behaviour, not a gate**.

Two changes are described here as they **will be**, not as the patch is today:

- decision 146 PR 4 — a sugar immediately followed by `=value` or
  `(params) { body }` sets the tag's default attribute (146, addendum 4);
- atoms, phase B — `:name` lexed in expression position, `::` reserved
  (decision 156).

### The central design change

The parser stops guessing where an embedded TypeScript expression ends. At every
position listed in [Expression boundaries](#expression-boundaries) it calls a
real TypeScript expression parser **at the value's start offset**, supplies a set
of stop conditions, and takes the **end offset** back from it. The vendored
`@babel/parser` 7.29.8 is the expression parser; `parseExpression` is the entry
point and `getExpression` the internal reader. `startLine`, `startColumn` and
`startIndex` exist and must be supplied with the value's real base offsets, so
that a diagnostic column is the column in the MX file and not in a slice.

Consequences that this document treats as normative:

- A value's text is **never** cut by a character-class heuristic before it
  reaches the expression parser. The dialect stop conditions in this document are
  the only characters that may end a value early, and each is a *rule with a
  citation*, not a guess.
- Where this document says "the value ends at `X`", `X` is the first character
  the expression parser was allowed to stop at; the value is the source range
  from the value's start to that offset, exclusive.

### Conventions

Normative statements use **must**, **must not** and **may**. Everything in a
fenced block marked *Example* is an example and carries no normative weight.
Where a construct has a host-dependent meaning (attributes, events,
placeholders), this document specifies only **where it may appear and how its
text is split**; what it means is the spec's business, cited inline.

### Document structure and modes

An MX template file is a sequence of nodes. At the top level a node is text, a
comment, a doctype, a statement tag (`static`, `import`, `export`,
`server`/`client`), an HTML-mode tag, or a concise-mode tag (spec §1, §2).

There are three ways to be inside a tag body, and they are mutually exclusive
within one body:

| Mode | Entered by | Ends by |
| --- | --- | --- |
| **HTML mode** | `>` of an open tag, or any content after a tag ends | the matching close tag `</name>`, `/>` on a void element, or EOF |
| **Concise mode** | a tag name written at the start of a line without angle brackets | the first line at column 0 that is not a tag line, or EOF |
| **Delimited HTML block** | the `--` line form, and raw-text element bodies | the delimiter or the close of the raw-text element |

Concise and HTML mode coexist in one file (spec §3 "Concise mode"). A region
that needs an explicit closing tag does not end the region before it, and a
concise block may sit before or after one.

## Tags

### Tag names

A tag name begins with a letter, `_` or `$`, and continues with letters,
digits, `-`, `_` or `$`. The name is read until one of the characters that end a
tag head: whitespace, `/`, `>`, `(`, `|`, `<`, `.`, `#`, `:` — the set the
parser's `TAG_NAME` state recognises.

Four name forms exist:

| Form | Example | Grammar |
| --- | --- | --- |
| Static | `<div>`, `my-widget` | identifier-like, may contain `-` |
| Interpolated (dynamic) | `<${expr}>`, `<${a}.b>` | `${` … `}` at the name's first character; the name is not split further (decision 146, addendum 3) |
| Interpolated member | `<${Foo}.bar>` | a dynamic name followed by a static suffix |
| Unnamed (shorthand) | `<#main>`, `<.card>`, `<:email>` | a shorthand with no written name; the parser writes its own placeholder name and leaves the **name span empty** (decision 145) |

The empty-name span is the parser's own signal: no authored name has one, so core
resolves the tag through the `defaultTag` ladder (see
[defaultTag](#defaulttag-where-it-affects-parsing)).

**A static tag name must not contain `:`.** `tag:rest` is the tag `tag` plus
`name="rest"`; `<:rest>` is the unnamed tag with `name="rest"`
(divergence row "A static tag name may not contain `:`"). The split happens
**after** parsing, so the parser must still see the whole written head as the
name. Three consequences are normative:

- in HTML mode a void element written with a `:name` still needs its `/>`
  (`<input:email type="email"/>`; without it Marko reports
  `Missing ending "input:email" tag`);
- a closing tag repeats the **written** name (`</div:x>`) or is the shorthand
  `</>`;
- concise mode is unaffected.

A **second** `:` in a tag head is a positioned error: a tag takes one name
(divergence row 3; 31-form table row "one name only").

### Shorthand `#id` and `.class` in a tag head

A shorthand is read from the character after the name (or at the name's first
character, for the unnamed tag) until whitespace, `=`, `(`, `/`, `|`, `<`, `,` or
`>`; `.` and `#` start the next part (spec §4 "Name sugar"). `.` and `#` accept
exactly what the parser's shorthand accepts: `<div #1a>` is `<div#1a>`, and
`.2xl` and `.é` are valid in both the tag-adjacent and the attribute position.

Shorthands compose in **any order** (decision 146, 23:23 addendum):
`<a.c:b#d>` is class `c`, name `b`, id `d`; `<:b.c>` is the unnamed tag with name
`b` and class `c`. Because the parser puts a `:b` that follows `.c` or `#d`
inside that shorthand's value, the **static part of a shorthand `class`/`id`
value splits at its first `:`** (divergence row "A shorthand class or id cannot
contain `:`"). A dynamic shorthand splits only its static tail: `<a.${x}:b>` is a
dynamic class plus name `b`, and a `:` before a `${…}` (`<a.c:b${x}>`) is a
positioned error.

## Attributes

An attribute in HTML mode is read from after the tag name to the end of the tag,
and in concise mode from after the tag name to the end of the line or of a
grouped `[…]`.

| Form | Syntax | Parser note |
| --- | --- | --- |
| Static | `class="card"`, `class='card'` | quotes are read by the string state; an unquoted value runs to the tag terminator |
| Dynamic | `value=expr` | see [Expression boundaries](#expression-boundaries) |
| Boolean | `disabled` | name only, no `=`; the value is the empty string (spec §4 "`:modifier`") |
| Spread | `...expr` | `...` followed by an expression, terminated by the ordinary value terminators (see OQ 6) |
| Bound | `value:=count` | `:=` — the space **before** `=` matters: `x:=expr` is a binding, `x: = expr` is an attribute named `x:` (spec §4, decision 65) |
| Modifier | `class:active=on`, `value:fn:=x`, `x:foo:bar` | the parser splits an attribute name at its **last** `:`; an empty head is filled with `value`, so `:foo` parses as the complete name `value:foo` |
| Method | `onClick() { … }` | `()` is attribute arguments, `{ … }` is a method body; the body is a TypeScript statement block, not an expression |
| Shorthand sugars | `#x`, `.x`, `:x` | see [Dialect rules](#dialect-rules) |

Attribute **names** terminate on `,`, `=`, `(`, `>`, `<`, on `:` when the next
character is `=`, and on `/` when the next character is `>`. In concise mode they
additionally terminate on `;`, on `]` (inside a grouped list) and on a `--` at a
space boundary.

The default attribute — an attribute with no written name, written `=expr` — has
a **zero-width name span**. It is the only attribute the after-value dialect rule
exempts (see below).

Attribute order is source order and must be preserved (spec §4 "Attribute order").

## Tag arguments, tag parameters, type arguments and type parameters

**Tag arguments** `<Tag(expr)>`: a parenthesised, comma-separated argument list
after the tag name and before the tag's attributes. The value ends at the
matching `)`. Tag arguments may combine with a body and with attribute tags
(decision 109). An argument list may itself contain a spread (`<Tag(...rest)>`).

**Tag parameters** `<Tag|a, b|>`: patterns between pipes, separated by commas,
parsed with the same TypeScript pattern grammar as `<for>`'s, including
destructuring and type annotations (spec §8). They turn the tag's children into a
function. Empty pipes (`||`) are a no-argument function. Parameters come **before**
`=value` (spec §8).

The parser must treat the parameter list as a **pattern list**, not an expression
list: `|{ a, b }|`, `|[a, b]|` and `|x: Foo|` are patterns. A list that parses as
patterns and, re-read as an expression list, would differ is a TypeScript
diagnostic, not an MX one.

**Type arguments and type parameters** do not have MX syntax of their own. They
are TypeScript's, and the parser must let the TypeScript parser consume them
wherever TypeScript allows: in tag arguments (`f<T>(y)`), in tag parameters
(`|x: Foo|`), in method bodies, in statement tags, and in placeholders. In MX
source, `<` inside an attribute value is **not** a tag terminator (see
[Ambiguous inputs](#ambiguous-inputs)), so `x=f<T>(y)` is one value.

**Tag variables** (`<div/x=1>`, and the concise `div/x=1`) are a name followed by
`/`, then the attribute list of that name. In concise mode a `/` is also a line
form; `//` and `/*` are comments (see [Concise mode](#concise-mode)).

## Attribute tags

`<@name>`, `<@name attrs>`, `<@name|p|>`: a child written with a leading `@` is
an attribute tag, not an element. Its name is a **property key**, not a tag name,
so:

- the `:` split does **not** apply — `<@svg:rect>` is one name (decision 146,
  addendum 3; spec §4 "Attribute tags");
- attribute-position sugar **does** apply: `<@z .b>` gives `class="b"`;
- `<@children>` is reserved as the body's name (spec §8 "Collisions and
  placement").

Attribute tags are legal only directly inside a component call; anywhere else
they are a positioned error (spec §8).

## Placeholders

`${expr}` interpolates escaped; `$!{expr}` interpolates raw (spec §3
"Interpolation"). The value ends at the `}` that closes it, and nested braces,
strings, template literals, regex literals and comments are skipped by the
expression parser rather than by the lexer. `$!{…}` must not be accepted inside
an attribute value — Marko rejects it there and MX keeps that (spec §3).

A bare `${expr}` on its own line in a concise region is **not** a placeholder: it
parses as a dynamic tag (spec §3 "A bare `${expr}` line"). A `${expr}` inside an
HTML-syntax body is always an ordinary placeholder.

## Scriptlets and statement tags

**Scriptlets** `$ statement` and `$ { … }` parse, and are rejected in lowering on
every host with decision 54's message (spec §3 "Scriptlets"). The parser must
still produce the node: the rejection is semantic.

**Statement tags** `static`, `import`, `export`, `server`, `client` take a
TypeScript module-level body — statement lists, not expressions (spec §2). The
body ends at the end of the tag (`/>`, `>` plus close tag) or, for `static`, at
the end of the file region it occupies. `server` and `client` are blocks
(spec §2).

Atoms must not be lexed in a statement tag: `static const s = :a` is a
TypeScript error, not an atom (decision 156.1).

## Text, comments, CDATA, doctype, declarations and parsed-text tags

| Construct | Parser behaviour |
| --- | --- |
| Text | Everything that is not a tag, comment, placeholder, doctype, CDATA, declaration or scriptlet start; whitespace is normalised per [Whitespace](#whitespace-at-the-parser-level) |
| HTML comment | `<!-- … -->`; the delimiters are stripped from the node's value, and the node keeps its span so a consumer can tell an HTML comment from a `//` line comment (spec §3 "HTML comments") |
| Line / block JS comment | `//` to end of line, `/* … */`; never content (spec §3 "Whitespace") |
| Doctype | `<!doctype …>` → a node whose value is the text with delimiters stripped; `<html-comment>` is the tag form of a comment |
| CDATA | `<![CDATA[ … ]]>` parses to a node and is rejected in lowering (spec §3 "CDATA sections") |
| Declaration | `<? … ?>` parses to a node and is rejected in lowering (spec §3) |

**Parsed-text (raw-text) elements** — `script`, `style`, `textarea`, `title`, and
every other element the parser lists as raw-text — have their body read as a
single text run, with no tags, no placeholders and no interpolation (spec §3,
last paragraph). Inside such a body, `<![CDATA[…]]>` is literal text, not a CDATA
section. This is the parser's behaviour, not a lowering decision, and it is the
one exception to the CDATA rejection.

## Concise mode

A tag written on its own line without angle brackets is a concise tag. Its
children are the lines indented under it. A block ends at the first line back at
column 0 that is not a tag line; **a column-0 tag line is a sibling inside the
same block, not a terminator** (spec §3 "Concise mode").

- A closing tag is a parse error in a concise region
  (`The closing "div" tag was not expected`).
- A line must not start with a single hyphen; `--` is the delimited text form.
- A line must not start with `/` unless it starts `//` or `/*`.
- Grouped attributes `[a=1, b=2]` end on `]`.
- Attribute values terminate on `,`, `;` and a `--` at a space boundary — the
  same shapes the HTML-mode terminator list uses, minus the tag terminators.

Every rule in this subsection is inherited from the parser and has no MX decision
of its own (decisions 71, 72).

## Whitespace at the parser level

The parser owns whitespace; core and hosts must not re-normalize it (spec §3
"Whitespace", decisions 33 and 141). The rules:

1. At a body's beginning and end, leading and trailing CR/LF plus indentation are
   removed.
2. A whitespace-only run that **begins** with CR/LF is dropped and produces no
   node. `" \n "` therefore retains one space — "contains a newline" is not the
   test.
3. Remaining whitespace runs collapse to one space (`value.replace(/\s+/g, " ")`).
4. Comments are not content and do not count when trimming.
5. `${" "}` is the only escape hatch for a space the newline rule drops.

`preserveWhitespace` bypasses rules 1–4.

## Error conditions

Every diagnostic below is a **positioned** error (spec §12), raised at the
construct's own offset, and the parser must not consume input past it silently.

| Condition | Message or source |
| --- | --- |
| Second `:` in a tag head | a tag takes one name (divergence row 3) |
| Bare `:` in attribute position | `` `:` is name sugar and needs a name (`:email`) `` (divergence row "Bare `:x` is `name=`…") |
| A `:name` that is not an identifier | positioned error (spec §4) |
| After-value sugar on the **default** attribute | `` sugar right after a default value is not supported (decision 151, ruling 2) `` |
| `::name` | `::` is reserved for a future `Symbol.for` sugar (decision 156.5) |
| `$!{…}` inside an attribute value | rejected by the parser, before any host |
| Closing tag in a concise region | `The closing "div" tag was not expected` |
| Concise line starting with `-` | `A line in concise mode cannot start with a single hyphen. Use "--" instead.` |
| Concise line starting with `/` | `A line in concise mode cannot start with "/" unless it starts a "//" or "/*" comment` |
| Scriptlet | decision 54's message, in lowering |
| CDATA / declaration | in lowering (spec §3) |
| A value with no expression after `=` | `Invalid placeholder, the expression cannot be missing` and the tag's "expected a single expression" wording |
| After-value sugar on a **stock** parser | the positioned core diagnostic of decision 151 ruling 1 |

## Expression boundaries

This section is the interface between the MX parser and the TypeScript expression
parser. It lists **every position where a TypeScript expression, statement list,
type, type-parameter list or parameter list can appear in MX source**. For each
position: what starts it, what stops it, and which rule overrides TypeScript's
own grammar.

Notation:

- **base** — the value's start offset, passed to the expression parser as
  `startIndex`/`startColumn`/`startLine`;
- **stop set** — the characters the expression parser is permitted to stop at,
  checked *before* it consumes them;
- **override** — a rule that changes what TypeScript's own grammar would do, with
  its citation;
- **skip rules** — the exceptions that keep a character inside the value when it
  would otherwise stop it (decision 146, divergence row 3, and the patch).

Rules that apply to **every** expression position below:

- **R1 — grouping.** `(`, `[`, `{` open a group; `)`, `]`, `}` close it. A stop
  character inside an open group never ends the value. *(default)*
- **R2 — strings, templates, regex and comments.** Inside a string or template
  literal, or a line/block comment, no stop character is significant. A `/` that
  can follow a division is an operator; otherwise it starts a regex literal. The
  decision is made from the previous significant token, which is the expression
  parser's own, not the lexer's guess. *(default)*
- **R3 — atoms.** `:name` is lexed as one token wherever an expression is
  expected, and never after an expression end, after `.` or `?.`, or after `as`
  or `satisfies`. `::` is one reserved token and is an error. Not active in
  statement tags, scriptlets or method bodies. *(decision 156.1, 156.5)*
- **R4 — line and whitespace termination** is per position, below.

### E1 — Attribute value, HTML mode

- **Start:** the first non-whitespace character after `=`, or after `:=` for a
  bound value. `x= :b` starts at `:b` — the whitespace after `=` is consumed by
  the parser, not part of the value (atoms report §3; see OQ 5).
- **Stop set:** `,` · `/>` · `>` · end of tag.
  `>` does not stop the value when it is the `>` of `=>`, or when it is preceded
  by whitespace and followed by `=` (that is `>=`, because a closed tag would put
  the `=` in body content: `<if=count >= 10>`). *(default)*
- **Overrides:**
  - **after-value sugar.** With at least one attribute before the value (that is,
    the attribute has a name or is a spread) and a whitespace immediately before
    the character: a `:` followed by an identifier start, with **no open `?`** in
    the value, and a `.` followed by an identifier start, each **end the value
    and begin a new attribute**. *(decision 146, divergence row 3, decision 151
    ruling 2.)*
  - **`?` depth.** `?` increments a ternary depth counter; `:` at depth 0 starts a
    type annotation, at depth > 0 it closes a ternary. The after-value `:` rule
    applies only at depth 0. *(default, extended by the patch)*
  - **`??` and `?.` exceptions.** In an attribute value, `?` immediately followed
    by `?`, or by `.` not followed by a digit, is consumed as a two-character
    operator and does **not** open a ternary. `x=a ?? b` and `x=a?.b` are one
    value. *(divergence row 3; the `?` branch of the patch — see OQ 3)*
  - **digits after `.`.** `.` followed by a digit does **not** end the value, so
    `x=a .2xl` stays member access while `x=a .c` splits (see OQ 4).
  - **a bare `:`** before `/>`, `>` or the end of the line also ends the value, so
    the sugar error can name it (divergence row 3).
  - **default attribute exemption.** When the attribute has **no** name (the
    default attribute, `<if=a\n  .b>`, `<const/x=items\n  .filter()/>`), none of
    the after-value rules apply: the value keeps Marko's meaning. *(decision 151
    ruling 2)*
- **Must:** the whitespace that ends the value belongs to neither the value nor
  the next attribute's span.

### E2 — Attribute value, concise mode

- **Start:** as E1, after `=` on a concise line.
- **Stop set:** `,` · `;` · `--` at a space boundary · end of line · `]` when
  inside a grouped attribute list.
- **Overrides:** identical to E1, including the default-attribute exemption.
  *(default + decision 146, decision 151 ruling 2)*

### E3 — Spread attribute

- **Start:** the first non-whitespace character after `...`.
- **Stop set:** as E1 (HTML) or E2 (concise).
- **Overrides:** the after-value sugar rules apply to a spread **as the patch
  writes them** (`attrValue` is true for a named attribute or a spread), so
  `...props .b` is `...props` plus a class sugar. The spec text says "after
  whitespace inside an attribute value" without distinguishing a spread — see
  **OQ 6**.

### E4 — Attribute method arguments

`onClick(a, b)`:

- **Start:** the first non-whitespace character after `(`.
- **Stop set:** the matching `)`.
- **Overrides:** none. The contents are an ordinary TypeScript argument list.
  Inside the parentheses, an after-value `.` or `:` must **not** end anything
  (grouping rule R1). *(default)*

### E5 — Attribute method body

`onClick() { … }`:

- **Start:** the `{`.
- **Stop set:** the matching `}`.
- **Overrides:** the body is a **statement list**, not an expression. Atoms are
  not lexed here (decision 156.1's exclusion); `return :a` is a TypeScript error.

### E6 — Tag arguments

`<Tag(expr)>`:

- **Start:** the first non-whitespace character after `(`.
- **Stop set:** the matching `)`.
- **Overrides:** none beyond R1–R3. Type arguments inside are TypeScript's
  (`<Tag(f<T>(x))>`).

### E7 — Tag parameters and attribute-tag parameters

`<Tag|a, b|>`, `<@name|x|>`:

- **Start:** the first non-whitespace character after `|`.
- **Stop set:** the next `|` at group depth 0.
- **Overrides:** each item is a **binding pattern**, optionally followed by
  `: Type` and optionally initialised (`|x = 1|`). The parser must hand the whole
  span to a pattern parser, not an expression parser. Atoms are not lexed here.
  Type annotations inside the pattern list are the type-parser's business.

### E8 — Placeholder

`${expr}`, `$!{expr}`:

- **Start:** the first non-whitespace character after `${` or `$!{`.
- **Stop set:** the matching `}`.
- **Overrides:** atoms **are** lexed here (decision 156.1 lists `${}` explicitly);
  `$!{…}` is rejected in attribute position before the parser runs (spec §3).

### E9 — Concise default attribute and tag variable value

`if=a`, `div/x=a`:

- **Start / stop:** as E2.
- **Overrides:** the default attribute is exempt from the after-value rules; a
  tag variable's value is an ordinary named attribute value.

### E10 — Statement tags

`static`, `import`, `export`, `server`, `client`:

- **Start:** the first non-whitespace character after the statement keyword.
- **Stop set:** the end of the tag: `/>`, or the matching `</…>` close tag, or (for
  a file-level `static`) end of file. `static` bodies run to the end of the
  enclosing region, not to the next tag.
- **Overrides:** none. This is TypeScript's own module-level grammar, including
  generics, `as`, `satisfies` and `import type`. Atoms must not be lexed
  (decision 156.1).

### E11 — Scriptlet

`$ statement`, `$ { … }`:

- **Start:** after the `$` and the whitespace; the block form starts at `{`.
- **Stop set:** end of line for the statement form; `}` for the block form,
  followed by an optional `;`.
- **Overrides:** none. Rejected in lowering by decision 54; the parser still
  produces the node.

### E12 — Concise delimited text line (`--`)

- **Start:** after `--`.
- **Stop set:** end of line.
- **Overrides:** the entire line is text. No expression, no atoms, no
  placeholders — `${…}` on such a line is literal text unless escaped
  (spec §3 "Text lines").

### E13 — Dynamic tag name

`<${expr}>`:

- **Start / stop:** as E8. The `${…}` is a placeholder; the surrounding name may
  carry a static suffix (`<${Foo}.bar>`) which is not split at `:` (decision 146,
  addendum 3).

### E14 — Types, type arguments and type parameters

There is no MX type syntax. Wherever TypeScript allows a type, a type-parameter
list or a type-argument list, the parser must pass the span to the TypeScript
parser and take the end offset back. The positions that exist in MX source are
exactly: inside every expression position above (E1–E13), inside a binding
pattern (E7), inside a statement list (E10), and in a method body (E5). No MX
rule may truncate a type at a `>` that appears inside it — in particular `x=a > b`
inside a tag is handled by the value stop set of E1, not by the type parser.

## Dialect rules

These are the decisions that change the default grammar, stated as rules.

### `:name`, `#id` and `.class` in any position

1. **Tag-adjacent:** `#x` sets `id="x"`, `.x` joins `class`, `:x` sets
   `name="x"`, in **any order**, on a named tag or the unnamed tag.
   *(decision 146, 23:23 addendum)*
2. **Attribute position, first:** the same three sugars, before any other
   attribute, are rewritten to `id`, `class` and `name` before the shorthand
   merge, so `<div.a #m .b>` is exactly `<div.a.b#m>`. *(spec §4)*
3. **Attribute position, after a value:** see [E1](#e1--attribute-value-html-mode).
   The default attribute is exempt. *(decision 146, divergence row 3, decision 151
   ruling 2)*
4. **`:name` names:** `[A-Za-z_$][\w$-]*`. A static tag name splits at its first
   `:`; the static part of a shorthand `class`/`id` splits the same way; a second
   `:` in a tag head is an error. *(decision 146 addendum, divergence rows)*
5. **A sugar immediately followed by `=value` or `(params) { body }`** sets the
   tag's **default attribute** (`value`): `#name=expr` is id `name` plus
   `value=expr`; `#name(params) { body }` is id `name` plus
   `value=function`. The same for `:name` and `.class`. The error is only "the tag
   already has a default value". `(` and `=` can never be part of a sugar, so the
   space after a sugar is optional. *(decision 146, addendum 4 — PR 4)*
6. **Left alone:** the named forms `class:x`, `style:x`, `value:fn:=x` and the
   explicit `value:x`; a dynamic tag name; a bound attribute; the default
   attribute; an attribute tag's own name (`<@svg:rect>` is one key).
   *(decision 146, addendum 3)*
7. **Wildcard children (decision 147).** The child keeps its **authored** name:
   `<att>` is the tag `att` in the tree and is checked against the matched entry's
   contract; only `<:att>` yields a child whose name attribute is `att`. There is
   no `as` renaming form. The wildcard is a contract feature, so it affects
   parsing only in that the authored name survives to resolution.
8. **defaultTag, where it affects parsing (decision 145).** The unnamed tag keeps
   an **empty name span**; the parser must not write a host name into it. The
   name is then resolved by the ladder: parent contract `defaultTag` → user
   `package.json#mx.<target>.defaultTag` → host override → target built-in. A
   `defaultTag` value whose parse shape is not a plain tag (void, text or
   whitespace-preserving built-ins such as `input`, `script`, `textarea`, `pre`) is
   an error **at the declaration**, never at the use site. After resolution the
   tag is an ordinary tag and every other rule applies. Because the split is
   post-parse, `<#x=1>` must still parse as a tag named `div` by the parser's own
   default with an id sugar and a default value.
9. **Atoms (decision 156).** `:name` in an MX **expression** position is an atom:
   a value representing itself, with runtime value the name as a string literal.
   Names may contain `-` (`:rename-all`). The lexer must treat `::` as one token,
   reserved for a future `Symbol.for` sugar, and must raise the reserved error
   at the `::` column. An atom must not be lexed in a statement tag, a scriptlet
   or a method body.

### Ternary `?` and `:` depth, and the `??` / `?.` exceptions

- `?` opens a ternary and increments a depth counter; the matching `:` closes it.
- A `:` at depth 0 in an attribute value starts a type annotation — unless the
  after-value rule applies, which it does only when the attribute has a name (or
  is a spread), the `:` follows whitespace, the next character is an identifier
  start, and depth is 0.
- `??` and `?.` (with `.` not followed by a digit) are consumed as two-character
  operators inside an attribute value and never open a ternary. Outside an
  attribute value they are ordinary operators.

## Ambiguous inputs

Each row is a concrete input and the parse the grammar requires. **NOT SETTLED**
means no source of truth fixes the answer; the row points at an open question
below, and this document does not choose.

| Input | Required parse | Settled by |
| --- | --- | --- |
| `x=a ? b : c` | one value, a ternary | default |
| `x=a :b` | value `a`; then `name="b"` | decision 146, divergence row 3 |
| `x=a.b .c` | value `a.b`; then `class="c"` | decision 146, divergence row 3 (breaking) |
| `x=(a) :T => a` | **error** — the value splits at ` :T` | decision 151 ruling 3, 31-form row "151.3 split" |
| `x=(a): T => a` | one value, an arrow with a return type | default |
| `x=a ?? b` | one value (`??` is not a ternary `?`) | divergence row 3 / patch — see OQ 3 |
| `x=a?.b` | one value (optional member) | divergence row 3 / patch — see OQ 3 |
| `x=a?.b :c` | value `a?.b`; then `name="c"` | default + divergence row 3 |
| `x=a < b` | one value (`<` is not a tag terminator in an attribute value) | default |
| `x=f<T>(y)` | one value, a call with a type argument | default |
| `x=a > b` (inside a tag) | value `a`; `>` closes the tag; ` b` is body content | default (`shouldTerminateHtmlAttrValue`) |
| `x=a as T` | one value | default |
| `x=a satisfies T` | one value | default |
| `x=a! .c` | value `a!`; then `class="c"` | default + divergence row 3 |
| `x=/re/ .c` | value `/re/`; then `class="c"` | default + divergence row 3 |
| `<input type="email" :email>` | `type="email"` then `name="email"` | decision 146; on a stock parser, the positioned core diagnostic of decision 151 ruling 1 |
| `<:atom>` | unnamed tag, `name="atom"` | 31-form row 1; decision 145 |
| `<input:email/>` | tag `input`, `name="email"` | 31-form row 2; divergence row 1 |
| `<input :email/>` | `name="email"` first | 31-form row 3 |
| `<input#main:email.big/>` | id `main`, name `email`, class `big` | 31-form row 4; decision 146 addendum |
| every order of the tag-adjacent sugars (`:#.`, `:.#`, `.:#`, `.#:`, `#.:`, `<:email.big/>`) | each sugar keeps its meaning in any order | 31-form row 5; decision 146, 23:23 addendum |
| `<input #main/>` | `id="main"` | 31-form row 6 |
| `<input .big/>` | `class="big"` | 31-form row 7 |
| `<input :email type="email"/>` | `name="email"` first | 31-form row 8 |
| `<input x=1 #main .big :email/>` | four attributes in written order | 31-form row 9 |
| `<input x=a.b .c/>` | as `x=a.b .c` above | 31-form row 10 |
| `<input:email=1/>` | id-less tag `input`, `name="email"`, **default value** `1` | decision 146, addendum 4 (PR 4) |
| `<input :email=1/>` | `name="email"`, default value `1` | decision 146, addendum 4 (PR 4) |
| `<input:email(a) { return a; }/>` | `name="email"`, default value a function | decision 146, addendum 4 (PR 4) |
| `<input #main(a) {…}/>` | `id="main"`, default value a function | decision 146, addendum 4 (PR 4) |
| `<input x=1 :/>` | positioned error, bare `:` | 31-form row 14 |
| `<input :/>` | positioned error, bare `:` | 31-form row 14 |
| `<a:b:c/>` | positioned error, one name per tag | 31-form row 15 |
| `<if=a\n .b>x</if>` | one value `a\n .b`; default attribute exempt | 31-form row 16, decision 151 ruling 2 |
| `<const/x=items\n .filter(Boolean)/>` | one value | 31-form row 16 |
| `<div class:x=1/>` | Marko's own refusal (`class:x` is reserved on native elements) | 31-form row 17; spec §4 |
| `<input value:fn:=x/>` | `value:fn` bound to `x` | 31-form row 18 |
| `<div><@svg:rect/></div>` | attribute tag named `svg:rect`, one key | 31-form row 19, decision 146 addendum 3 |
| `<input x=a ? b :c/>` | one value, a ternary | 31-form row 20 |
| `<div x=::a/>` | positioned error, `::` reserved | decision 156.5 |
| `<div x= :b/>` | value `:b` is the atom `"b"` | atoms report §3 — **NOT SETTLED**, OQ 5 |
| `<div x=a ? :b :c/>` | one value `a ? :b :c`, atoms `b` and `c` | atoms report §1a/p6 — **NOT SETTLED**, OQ 1 |
| `<div x=:a :b/>` | atom value `"a"`, then `name="b"` | atoms report §4 row 12 — **NOT SETTLED**, OQ 1 |
| `<div x=a .2xl/>` | **NOT SETTLED** — the patch does not split (digit after `.`) | OQ 4 |
| `<div x=a :b :c/>` | **NOT SETTLED** — two after-value sugars | OQ 2 |
| `<div x=a ?:b/>` | **NOT SETTLED** — the `?`-exception consumes `?:` | OQ 3 |
| `...props .b` | **NOT SETTLED** — spread vs after-value sugar | OQ 6 |

## Open questions for mx-lead

One line each: the input, what each source says, the recommendation. None of
these is resolved in the normative text above.

1. **`x=a ? :b :c`** — the current patch counts an atom's `:` as the ternary's
   `:` and mis-splits into `value(a ? :b) name(:c)` (atoms report §1a, p4b); the
   atoms lexer fixes it; decision 156.5 makes `::` a single token but says
   nothing about ternary counting. *Recommendation:* the ternary counter must skip
   an atom's `:`; the value is one expression.
2. **`x=a :b :c`** — no source covers two after-value sugars in attribute
   position. Presumably `name="c"` wins over `name="b"` under decision 135, but
   nothing says so. *Recommendation:* rule it explicitly, with the
   duplicate-attribute warning.
3. **`x=a ?? b`, `x=a?.b`, `x=a ?:b`** — the `??`/`?.` skip exists in the patch
   but in no spec paragraph or decision; a `?` immediately followed by `:` is
   consumed by the same branch and is neither documented nor tested.
   *Recommendation:* state all three in the spec, and decide whether `?:` is an
   error or a mis-typed ternary.
4. **`x=a .2xl`** — the patch's identifier-start test excludes digits, so
   `.2xl` does not split after a value, while `.2xl` **is** a class shorthand in
   the tag-adjacent and first-attribute positions (spec §4). *Recommendation:*
   keep the digit exclusion and say so in the spec, or align the two positions.
5. **`x= :b`** — the atoms report rules it an atom (`x="b"`), because the parser
   consumes whitespace after `=`; no decision or spec paragraph says so, and
   reading it as sugar would leave `x=` without a value. *Recommendation:* record
   the ruling in decision 156.
6. **`...props .b`** — the patch applies the after-value rules to a spread
   (`attrValue = !!(name || spread)`), which the spec text does not distinguish.
   *Recommendation:* rule spreads in or out explicitly.
7. **`x=(a) :T => a`** — decision 151 ruling 3 accepts the split, but no source
   fixes the **error message** a user sees. *Recommendation:* fix the wording.
8. **Bare `:` before `/>`** — the patch ends the value so the sugar error can be
   raised; the message is only partly fixed (`:` is name sugar and needs a
   name). *Recommendation:* pin the full wording.
9. **`x=a => b` in a tag** — `>` is skipped when preceded by `=`, but
   `x=a\n => b` (arrow on the next line) is not covered by any source.
   *Recommendation:* an E1 addendum that `=>` skips a newline.
10. **Method shorthand and sugar** — `<input #main(a) {…}/>` errors today and is
    legal under addendum 4; the parser must therefore let `(` follow a sugar in
    attribute position. Nothing says whether `onClick()` after a value behaves the
    same way.
11. **Statement tags and type parameters** — decision 156.1 excludes atoms from
    `static`/`import`, but no source says whether a *type parameter list* is
    allowed on a statement tag (`static` is a statement, not a declaration
    header, so there is nothing to attach one to).
12. **Wildcard children and the parser** — decision 147 keeps the authored name
    and adds no syntax, but says nothing about `<*>`-shaped or `<:att>` shorthand
    children inside a wildcard parent's body.
13. **`defaultTag` and the parser's own placeholder name** — decision 145 requires
    an empty name span; it does not say which name the parser records
    internally before resolution (Marko writes `div`). *Recommendation:* pin it,
    so a diagnostic inside an unresolved unnamed tag has something to name.

## Conformance

Which existing assets exercise which section of this document. Counts are the
number of directories/assets as they stand.

| Section | Exercised by |
| --- | --- |
| Tags, tag names, `:` split | `packages/core/src/name-sugar.test.ts`; oracle fixture `packages/targets/html/fixtures-marko/attr-value-modifier`; htmljs-parser fixtures (418 directories) |
| Shorthands and sugars, all 31 forms | `packages/core/src/name-sugar.test.ts`; `patches/htmljs-parser.test.ts` (both dist builds); `packages/core/src/stock-parser.test.ts`; `packages/targets/html/src/stock-parser.test.ts` |
| Attributes (static, dynamic, boolean, spread, bound, modifier, method) | `packages/targets/html/fixtures-marko/{attributes,attrs,attr-dynamic-escape,attr-quoting,duplicate-attrs*}`; `packages/core/src/lower.test.ts` |
| Tag arguments, tag parameters | spec §8 fixtures in `packages/targets/html/fixtures-marko/attribute-tags`, `…/attribute-tags-repeated`; `fixtures/render-props` |
| Attribute tags | `packages/targets/html/fixtures-marko/attribute-tags*`; `packages/core/src/resolve.test.ts` |
| Placeholders | `fixtures/{counter,todos,lists}`; `packages/targets/html/fixtures-marko/comments-and-html-comment` |
| Scriptlets and statement tags | `packages/targets/html/fixtures-marko/{static-const,import-component}`; no dedicated parser fixture for scriptlets (the rejection is a lowering test) |
| Text, comments, CDATA, doctype, declarations, parsed text | `packages/targets/html/fixtures-marko/{doctype-page,comments-and-html-comment,html-comment-placeholder,html-comment-falsy,elements-text,piped-text}` |
| Concise mode | `apps/docs/example/home-example.mx` (compiled on every docs build); `packages/tooling/tsc/src/fixtures/host-dispatch/data-check/violation.mx`; angular oracle `text-*` fixtures |
| Whitespace | `test-fixtures/body-whitespace/cases.json` (rendered matrix) |
| Expression boundaries | `packages/core/src/parse-error-position.test.ts`, `parse-error-hints.test.ts`; `packages/editors/tree-sitter-mx/__tests__` (`fixtures.bun-test.mts`, `mx-shorthand.bun-test.mts`); oracle fixtures in `fixtures/` (6 directories) |
| Dialect rules, atoms | **none yet** — the atoms test table is written but not implemented |

### Rules no existing test covers

- The `??` / `?.` skip rules, and `?:` specifically.
- A bare `:` immediately before `/>` or the end of a line (message and position).
- `x= :b` (whitespace after `=` followed by an atom) as a pinned case.
- The sugar-then-`=`/sugar-then-`(` forms of decision 146 addendum 4 — PR 4.
- `:name` with a dash in an atom (`:rename-all`) end to end, and the core splice
  that keeps the atom out of the authored source slice.
- `x=a > b` inside a tag, as an explicit assertion rather than an incidental
  oracle row.
- Attribute arguments and method bodies as distinct stop sets (only covered
  incidentally).
- Statement-tag stop conditions, including a file-level `static` running to the
  end of the region.
- `--` text lines (already flagged as an untested inherited rule in spec §3).
---
title: "The parser grammar"
description: "How MX source text is split into tokens, expressions and nodes, in every mode, for the MX-owned parser."
---

# The parser grammar

This document is the parser-level specification of MX: how source text is split
into tags, attributes, values, bodies, placeholders, scriptlets and text, in
HTML mode, concise mode, and the delimited blocks. It is written to be
implementable and testable, not to be read as a tutorial.

It is **a draft for review by mx-lead**, who owns language design. Where the
language spec, the decision log and `divergences.md` disagree or are silent, the
disagreement is recorded in [Open questions for mx-lead](#open-questions-for-mx-lead)
rather than resolved here. Nothing in this document decides syntax.

## Status, sources of truth and method

Decision 157 (2026-10-05) makes the MX parser MX-owned, written in TypeScript,
with no obligation to follow upstream (157.1, 157.2). **Marko's behaviour is the
default answer wherever MX has no ruling of its own**, and Marko byte parity is
no longer a requirement (157.3). A divergence needs a decision and a
`divergences.md` row (157.3).

Decision 158 (2026-10-05) fixes the delivery plan:

- MX2 defines **its own AST with its own node types** in `@mxlang/babel`. The
  design removes every accommodation made to fit Marko; decision 158.1 names
  "no `markoTag` family inside a patched `@babel/types`" and "**no `value:`
  modifier split**", and makes sugars, atoms, attribute tags, wildcard children,
  `defaultTag` and `<return>` first-class nodes with native positions.
- The Marko compiler front end is **not copied** (158.2, superseding 157
  addenda 2 and 4 on that point). `@marko/compiler` stays an npm dependency
  only until the MX AST and the ported lowering land. 158.2 kept "decision 151
  §1" (the stock-parser diagnostic) for that interim, but decision 159 then
  made core's build bundle `@marko/compiler`'s parse layer with
  `htmljs-parser` aliased to the in-repo template parser, so "a registry
  install of core parses with MX's rules". A published core therefore never
  reaches the stock-parser diagnostic either (OQ 15).
- Packages (158.3): `@mxlang/parser` is the template parser (`src/template/`,
  derived from htmljs-parser) and, when it exists, the front end from parser
  events to the MX AST; `@mxlang/babel` is the vendored Babel fork with the MX
  node types; `@mxlang/tsx-bridge` is the MX-region bridge. There is no
  `@mxlang/compiler` package: `@mxlang/core` plus the host emitters are the
  compiler.

Two rules that this document mentions are implemented today in
`@marko/compiler`, not in the template parser, and their fate differs:

| Rule | Today | Under decision 158 |
| --- | --- | --- |
| the split of an attribute name at its last `:` with an empty head filled by `value` | `@marko/compiler`'s `onAttrName` (as spec §4 "`:modifier`" describes it) | **removed**: 158.1 says the MX AST has no `value:` modifier split. This document therefore specifies none; an attribute name is the text the parser reports |
| arguments together with plain attributes are an error (`assertAttributesOrArgs`, decision 109) | `@marko/compiler` | a rule of the layer that builds the call, which is core (158.3); it is not a parser rule either way |

Sources of truth, in this order:

1. the language spec, `apps/docs/docs/specification.md` (cited as *spec §N* with
   the subsection heading);
2. the decision log, `notes/decisions-2026-09-10.md` (cited as *decision N* and
   its addenda);
3. `divergences.md` at the repository root, cited by its **row heading**, because
   its rows carry no numbers (for example *divergence row "The parser
   after-value rule"*), plus `fixtures/divergences.md`.

The htmljs-parser fixtures and the Marko fixtures are **evidence of the default
behaviour, not a gate**.

Decision 146 addenda 4 to 6 and atoms (decision 156 with its addenda 1 to 4
and 8) are implemented on `main` and are described here as they are, not as planned.
Addendum 4 lives in core; addenda 5 and 6 and atoms live in the template
parser.

### Method: every behavioural rule is read out of the parser source

The subject of this document is **MX's template parser**: the source on `main`
at `packages/parser/src/template/` (decision 158.3; read for this revision at
`origin/main` `5f4661534`). It began as a copy of `htmljs-parser` 5.18.0 and is
now MX's own code; its `PROVENANCE.md` records every departure from 5.18.0.
Every statement below about what the parser does is derived from that source
and names the file and symbol it comes from. Where a rule has more than one
branch, it is written as a table or an ordered list **in the code's own branch
order**, so that every branch of the cited symbol is either a row or explicitly
excluded. Citations are **by file and symbol**, never by line number.

**Stock** means htmljs-parser 5.18.0 unchanged (`/Users/svallory/work/htmljs-parser/src`,
identical to the `v5.18.0` tag). It appears only as a comparison: where a row
or an example says "Stock: …", the stock parser does something else. These
files on `main` differ from stock, and nothing else does:

| Departure | Files and symbols | Source of the rule |
| --- | --- | --- |
| the after-value rule | `states/ATTRIBUTE.ts` (`attrValue`); `states/EXPRESSION.ts`: the `??`/`?.` branch of `EXPRESSION.parse`, the `:` and `.` rows of `lookAheadForOperator`, `isIdentStartCode`, `isBareColonEnd` | decision 146, divergence 3 and addendum 6 ([E1](#e1--attribute-value-html-mode)) |
| a single-atom default value | `states/ATTRIBUTE.ts` (`defaultAtom`); `states/EXPRESSION.ts` (`isSingleAtomDefault`) | decision 146, addendum 5 ([E1](#e1--attribute-value-html-mode)) |
| atoms and the reserved `::` | `states/EXPRESSION.ts` (`lexAtom`, `expectsExpression`, `isOperatorWord`, `closesTypeArguments`, `atomNameEnd`, `rejectReservedName`, the atom guard in `lookBehindForKeyword`); the `atoms = true` sites in `states/ATTRIBUTE.ts`, `OPEN_TAG.ts`, `PLACEHOLDER.ts`, `TAG_NAME.ts`, `TEMPLATE_STRING.ts`; `rejectReservedName` calls in `TAG_NAME.exit` and `ATTRIBUTE.return`; `core/Parser.ts` (`atoms`, `read`, `rawOpenTags`); `util/constants.ts` (`onAtom`); `OPEN_TAG.exit` (`rawOpenTags`) | decision 156 and its addenda 2 to 4 and 8 ([Atoms](#atoms)) |
| the base position | `core/Parser.ts` (`ParseOptions`, `parse`, `positionAt`, `offsetAt`); `index.ts` | the parser's API ([Base position](#base-position-for-fragment-parses)) |

The bun patch `patches/htmljs-parser@5.18.0.patch`, which `@marko/compiler`'s
npm copy still runs under in this repository, carries the same after-value,
addendum-5 and atom rules (`PROVENANCE.md`; the
`corpus-equivalence.test.ts` test pins identical event streams). This document
describes the source, not the patch.

Every rule was then attacked by probe: inputs chosen to exercise each branch,
including inputs the wording might be read to exclude, run through **main's
template parser source** (`packages/parser/src/template/index.ts`) and through
the **stock** source with the same callbacks (`onOpenTagName` returning
`TagType.statement` for `static`/`import`/`export`/`server`/`client`/`class`,
`TagType.text` for `script`/`style`/`textarea`, `TagType.void` for
`input`/`br`; `onAtom` recorded). "Observed" below means the output of those
runs. **Stock and main agree on every observed input unless the text says they
differ**, and they differ only where one of the departures above applies.

Where the parser's behaviour differs from what a source of truth says, or the
parser accepts input that is not valid TypeScript, or rejects input that is,
this document records it and raises an open question. It does not smooth it
over.

### The central design change

The parser stops guessing where an embedded TypeScript expression ends. At the
positions in [Expression boundaries](#expression-boundaries) it will call a real
TypeScript expression parser **at the value's start offset**, supply stop
conditions, and take the **end offset** back. The vendored `@babel/parser`
7.29.8 is that parser. Its `startLine`, `startColumn` and `startIndex` options
exist and **must** be supplied with the value's real base offsets, so a
diagnostic column is the column in the MX file. No entry point of the vendored
parser returns where an expression stopped yet (OQ 1).

#### The ruling governing that boundary

mx-lead, who owns language design, ruled on 2026-10-05. The ruling has no
decision number yet (OQ 22). Verbatim:

> the language rule is the spec's whitespace rule (146 and its addenda); a
> TS-aware boundary may only make an ambiguous case exact, never accept
> something the spec rejects.

This document applies it as written and no more strongly:

- Where **the spec's** rule (decision 146 and its addenda, as spec §4 "Name
  sugar" and divergence row "The parser after-value rule" state it) splits or
  rejects an input, that result stands, and a TypeScript-aware boundary **must
  not** continue the value past it.
- Where the spec's rule applies but its outcome turns on a fact only
  TypeScript's grammar supplies, the boundary **may** supply that fact.
- Where the spec says nothing, the ruling does not decide. The default stands
  under decision 157.3 until mx-lead rules, and the case is listed as not
  settled.

The table in [Where a real TypeScript parser would end the value
differently](#where-a-real-typescript-parser-would-end-the-value-differently)
classifies every known difference in those three classes.

### Vocabulary

- **Position.** A place where the parser reads an expression, statement list,
  type list or pattern. Every position is one run of the `EXPRESSION` state,
  configured by flags and one stop function
  ([How a position is scanned](#how-a-position-is-scanned)).
- **Depth.** The number of open groups in the position (`groupStack.length`).
  A group is opened by `(`, `[` or `{`, and by `<` in a type context.
- **Hard stop.** A character for which the position's stop function
  (`shouldTerminate`) returns true. At depth 0 it ends the value, **except**
  under the operator exemption (step 4 of the scan), which exists only in
  positions that have the `operators` flag. Inside a group it is not examined.
- **Soft stop.** Whitespace other than a newline, in a position that has the
  `terminatedByWhitespace` flag; a newline, in a position that has
  `terminatedByWhitespace` or `terminatedByEOL`. At depth 0 it ends the value
  only when the continuation test fails.
- **Whitespace** is any character with code 32 or lower, which includes tab,
  newline and carriage return (`isWhitespaceCode`, `util/util.ts`). **Indent
  characters** are space and tab only (`isIndentCode`). A **word character** is
  `A`–`Z`, `a`–`z`, `0`–`9`, `$` or `_` (`isWordCode`); no non-ASCII character is
  one. (The atom look-behind is ruled otherwise, decision 156, addendum 9; the
  same ASCII-only reading in the division and keyword look-behinds is TODO
  `template-parser-ascii-only-lookbehinds` there.)
- **The default** is what the template parser does where no MX departure
  applies, which is what stock does, as confirmed by probe. Decision 157.3
  makes it the normative answer wherever MX has no ruling.
- **Supplied sets.** The parser has no list of tag names. Which names are
  statement tags, text tags and void tags is answered by the consumer's
  `onOpenTagName` handler, which returns a `TagType` (`TAG_NAME.exit`). The
  AST catalogue makes the statement set and the tag shapes inputs supplied
  per target (decision 163 addenda 1 and 3; [the AST catalogue](/architecture/ast/)
  §3.10 "Statement keywords per target" and §3.12). This document says "the
  supplied statement set" and "a text tag" for them.

### Ranges, and the names the AST catalogue gives them

The parser reports ranges; it builds no nodes. The node types, their fields
and their spans belong to the AST catalogue
([`apps/docs/docs/architecture/ast.md`](/architecture/ast/), decision 163), and this document uses
its names and does not redefine them. Decision 163, ruling Q10: field names
follow the AST, and for every expression container the catalogue's span is the
parser's **`value`** range (the text between the position's delimiters, inner
whitespace included, a tag variable's `/` excluded) and its **`outer`** is the
parser's **event range** (delimiters included). A position's text as written
here ("the value", "the arguments") is that `value` range.

| Event (`util/constants.ts`) | Range the parser reports | Catalogue field (ast.md section) |
| --- | --- | --- |
| `onOpenTagName` | the written name, sugar included; an empty range for the unnamed tag | `MxTag.name` (§3.3), after core's `:` split |
| `onTagShorthandId`, `onTagShorthandClass` | the part from its `#` or `.`, which may hold a `:name` | `MxShorthand` with `position: "tag"` (§3.6), after core's split |
| `onTagTypeArgs`, `onTagVar`, `onTagArgs`, `onTagTypeParams`, `onTagParams` | `value`: inside `<…>`, after `/`, inside `(…)`, inside `\|…\|`; event range: with the delimiters | `MxTag.typeArgs`, `var`, `args`, `typeParams`, `params` (§3.4): span = `value`, `outer` = event range |
| `onAttrName` | the name; empty for the default attribute | `MxAttribute.nameSpan`, or an `MxShorthand` with `position: "attribute"` for `#x`, `.x`, `:x` (§3.5, §3.6) |
| `onAttrValue` | `value`: from the first character after `=`/`:=` and the whitespace after it | `MxAttribute.value` or `MxShorthand.default` (§3.5) |
| `onAttrSpread` | `value`: from the character after `...`, whitespace included | `MxSpreadAttribute.value` (§3.5b) |
| `onAttrArgs` | `value`: inside `(…)` | `MxAttribute.args` (§3.5) |
| `onAttrMethod` | `params`, `body`, `typeParams`, each with a `value` inside its delimiters | `MxMethod.params`, `body`, `typeParams` (§3.5a) |
| `onPlaceholder` | `value`: inside `${…}` | `MxPlaceholder.expression` (§3.9) |
| `onScriptlet` | `value`: the statement, or inside `{…}` for the block form | `MxScriptlet.code` (§3.10) |
| `onAtom` | the whole atom, `:` included; `value` is the name | `MxAtom` in the enclosing container's `atoms` (§4.3) |

A statement tag's code is reported by no event of its own
([E10](#e10--statement-tags)): the parser reports the name and then
`onOpenTagEnd` where the statement ends, and the catalogue's
`MxModuleStatement` (§3.10) takes the statement from that range.

### Conventions

Normative statements use **must**, **must not** and **may**. A statement of the
default in the indicative ("the value ends", "the parser reports") is normative
for the MX parser unless the text marks it as a defect, as not settled, or as
planned. An input marked *observed* is an example of the rule stated beside it
and adds nothing to that rule. Other inline snippets inside a rule are part of
the rule. This document has no fenced examples.

## Document structure and modes

The parser starts every file in concise mode at indentation zero
(`Parser.parse` enters `CONCISE_HTML_CONTENT` with `isConcise = true`). There
are three content states:

| State | Entered by | Left by |
| --- | --- | --- |
| **Concise content** (`CONCISE_HTML_CONTENT`) | the start of the file; the end of an HTML region or delimited block | never; it is the root state |
| **HTML content** (`HTML_CONTENT`) | a concise line whose first character is `<` (mixed mode); a delimited block; the `>` that ends an HTML-mode open tag continues in the enclosing HTML content | the newline rules below; end of input |
| **Text content** (`PARSED_TEXT_CONTENT`) | the end of the open tag of a tag the consumer typed `TagType.text`, in HTML mode; a delimited block whose enclosing tag is such a tag | its close tag; the end of its delimited block |

**Concise mode is a parser flag, `isConcise`**, and the content states set it:
`CONCISE_HTML_CONTENT` sets it, `HTML_CONTENT.enter` clears it, and
`PARSED_TEXT_CONTENT` leaves it as it was. So a delimited block under a concise
text tag (`script -- …`, `textarea\n  -- …`) is still **concise mode**, while a
delimited block under any other concise tag is HTML mode. Every rule below that
says "in concise mode" means this flag, and it matters at end of input
([End of input](#end-of-input), rule 1).

**Mixed mode** (`CONCISE_HTML_CONTENT.parse`, the `<` case; `HTML_CONTENT.parse`,
the newline branch; `OPEN_TAG.enter`/`OPEN_TAG.exit`; `Parser.closeTagEnd`). A
concise line that starts with `<` begins an HTML region. The region ends at the
first newline reached when one of these holds:

1. no open tag has been read since the `<` (for example the line was an HTML
   comment), or
2. the last tag opened at the region's top level has been closed: by its close
   tag, by `/>`, or because the consumer typed it `TagType.void` or
   `TagType.statement`.

Text after that tag on the same line is still HTML content, and a new top-level
tag opened on that line keeps the region open until it closes in turn.
Observed: `div\n  <span>a</span> b\n  p` gives the tag `span`, the text ` b`, then
the concise child `p`; `<a></a><b>\n</b>\ndiv` keeps HTML mode across the newline
inside `<b>`.

`/>` self-closes **any** tag in HTML mode (`OPEN_TAG.parse`), not only a void
element.

At end of input (`htmlEOF`, `util/util.ts`) every open concise tag is closed
silently; an open HTML-mode tag is the error `Missing ending "<name>" tag`.

**Close tags** (`CLOSE_TAG.parse`, `ensureExpectedCloseTag`). `</` in HTML
content reads to the next `>`. The text between is compared, in this order:

1. empty (`</>`): closes the open tag, whatever its name;
2. equal to the open tag's name range, or to the literal `div` when that range
   is empty (the unnamed tag): closes it;
3. equal to the source from the start of the name to the end of its shorthands
   (`<div.a>` … `</div.a>`): closes it;
4. otherwise `The closing "x" tag does not match the corresponding opening "y"
   tag`.

With no open tag at all the error is `The closing "x" tag was not expected`. The
comparison in rule 2 is with the **written** name, so `<div:x>` is closed by
`</div:x>` or `</>` and not by `</div>` (observed). The literal `div` in rule 2
is the only place the parser itself names a host tag (OQ 25). Rules 1–3 do not
test whether the open tag is a concise one: `div\n  </div>` closes the concise
`div` without error (observed), which spec §3 "Concise mode" describes as a
parse error (OQ 26).

## Tags

### The open tag

`OPEN_TAG.parse` reads one character at a time. For each character the first
matching row applies:

| # | Character | Mode | Result |
| --- | --- | --- | --- |
| 1 | newline | concise, outside `[ … ]` | look ahead over whitespace (newlines included), `//` comments and `/* */` comments; if the next character is `,` the open tag continues, otherwise the open tag ends at this newline |
| 2 | newline | HTML, or inside `[ … ]` | skipped |
| 3 | `;` | concise | the open tag ends. Only whitespace, a `//` or `/* */` comment or an HTML comment may follow on the line, otherwise `A semicolon indicates the end of a line. Only comments may follow it.` This applies inside `[ … ]` too |
| 4 | `-` | concise | first, if the next character is not `-`, in or out of `[ … ]`: `"-" not allowed as first character of attribute name` (`div [a -b]`, observed). Otherwise, inside `[ … ]`: `Attribute group was not properly ended`. Otherwise the open tag ends and a delimited block begins ([E12](#e12--delimited-html-blocks)) |
| 5 | `[` | concise | begins an attribute group; a second `[` inside one is `Unexpected "[" character within open tag.` |
| 6 | `]` | concise | ends the attribute group; outside one it is `Unexpected "]" character within open tag.` |
| 7 | `>` | HTML | ends the open tag |
| 8 | `/>` | HTML | ends the open tag, self-closed |
| 9 | `//`, `/*` | both | a JavaScript comment, reported as an open-tag comment |
| 10 | `<!--` | both | `An html comment cannot be used within an open tag. Use a JavaScript comment (// or /* */) instead.` |
| 11 | whitespace | both | skipped |
| 12 | `,` | both | skipped together with **all** whitespace after it, newlines included, in concise mode too |
| 13 | any other, and the tag already has an attribute | both | an attribute begins here ([Attributes](#attributes)) |
| 14 | any other, the tag has a name and no attribute yet | both | `/` begins the tag variable (E9); `(` begins tag arguments (E6); `\|` begins tag parameters (E7); `<` begins a type list (E14, E15); anything else begins the first attribute |
| 15 | any other, the tag has no name yet | both | the tag name begins here |

Consequences of the row order, all observed:

- Row 14 applies only **before the first attribute**. After one, `/`, `(`, `|`
  and `<` belong to an attribute: `<foo x |a|/>` is an attribute named `|a|`,
  and `<foo x=1 /y/>` is the single value `1 /y`.
- Row 14 does not fix an order among the four forms: `<div/x(a)/>`,
  `<div|a|/x/>`, `<foo|a|(b)/>` and `<foo(a)|b|/>` all parse. A second `(` is
  `A tag can only have one argument`; a second `|…|` is `A tag can only specify
  parameters once`.
- Whitespace before the form is allowed by row 11: `<foo (a)/>` is tag
  arguments and `<foo /x/>` is a tag variable.
- Row 4 is reached only where an attribute could begin. `div a--b` is the
  attribute name `a--b`; `div a -- text` is the name `a` and a text block.
- Row 1's look-ahead crosses blank lines and comment lines: `div a\n  // c\n  ,b`
  is the attributes `a` and `b`.

At end of input inside an open tag: in HTML mode `EOF reached while parsing open
tag`; in concise mode the tag ends, except inside `[ … ]`, which is `EOF reached
while within an attribute group (e.g. "[ ... ]").`

### Tag names

`TAG_NAME.parse` reads a name, and each shorthand part, with the same loop. For
each character the first matching row applies:

| # | Character | Result |
| --- | --- | --- |
| 1 | newline | the part ends |
| 2 | `${` | an interpolation (E13) inside the part; the part continues after its `}` |
| 3 | whitespace, `=`, `:` when the next character is `=`, `(`, `/`, `\|`, `<`, `,`; in concise mode also `;` and `[`; in HTML mode also `>` | the part ends, and the open tag continues at this character |
| 4 | `.` or `#` | the part ends and a shorthand part begins after this character |
| 5 | any other | part of the name |

So `:` alone is a name character, and of the `:` forms only `:=` ends a name: `<a:b=1/>` is the
tag `a:b` with a default value, `<div:=x/>` is the tag `div` with a bound
default value (both observed; decision 146: "tag-adjacent `:` is a tag-name
character"). `>` is a name character in concise mode (`div>a` is one tag name,
observed). The loop has no leading-character rule: `<1abc/>` is the tag `1abc`
(observed), and no source of truth states one (OQ 16).

**`::` is reserved in a name** (decision 156, addenda 2 and 3). When a name or
shorthand part ends, `TAG_NAME.exit` checks each of its static pieces (the text
outside every `${…}`) with `rejectReservedName`, **before** it reports the part.
The first `::` found is the error `` `::b` is reserved (decision 156): `::`
will be the Symbol.for sugar; write `:b` for an atom `` (`INVALID_EXPRESSION`),
ranged from the `::` to the end of the atom name after it, and the parse stops
there, so the part is never reported. The name after `::` is read from the
source, not from the static piece, so a `${` right after it lends its `$`:
`<a::b${x}/>` reports `` `::b$` `` at 2–6 and `<a::${x}/>` `` `::$` `` at 2–5
(observed; behaviour today, see defect, [Recorded defects](#recorded-defects-in-the-default)). Observed: `<a::b/>`, `<div.a::b/>` and
`<div#a::b/>` are the error (stock: the tag `a::b`, the parts `.a::b`, `#a::b`);
`<${"a::b"}/>` is the tag `${"a::b"}`, because the `::` is inside the
interpolation.

Four name forms result:

| Form | Example | Grammar |
| --- | --- | --- |
| Static | `div`, `my-widget` | a run of row-5 characters |
| Interpolated | `<${expr}>`, `<${foo}-bar>`, `<${a}${b}>` | any mix of row-5 characters and `${…}` |
| Unnamed | `<.card>`, `<#main>` | the name part is empty and a shorthand follows; the name event has an **empty** range (decision 145) |
| Statement tag | `static`, `import`, … | a name in the supplied statement set, for which the consumer returns `TagType.statement` ([E10](#e10--statement-tags)) |

The empty name range is the parser's signal that the tag is unnamed (the
catalogue's `MxTagName` `kind: "unnamed"`, [ast.md §3.3](/architecture/ast/)); core resolves it
through the `defaultTag` ladder ([dialect rule 9](#dialect-rules)).
`<:email/>` is **not** unnamed at this level: the parser reports the name
`:email` (observed), and the split below produces the unnamed tag afterwards.

**A static tag name must not contain `:`.** `tag:rest` is the tag `tag` plus
`name="rest"`, and `<:rest>` is the unnamed tag with `name="rest"` (divergence
row "A static tag name may not contain `:`"; decision 146, divergence 1). The
split is **post-parse** (same row), so the parser reports the whole written
head as the name. That row states three consequences: in HTML mode a void
element written with a `:name` still needs its `/>`; a closing tag repeats the
written name or is `</>`; concise mode is unaffected. A second `:` in a tag head
is a positioned error raised by core, not by the parser (same row; spec §4 "Name
sugar"): the parser reports `<a:b:c/>` as the tag `a:b:c` (observed).

A dynamic name is not split at `:` (same row; spec §4 "Name sugar", "Left
alone").

### Shorthand `#id` and `.class`

A shorthand part is read by the tag-name loop above, so it ends on a newline
(row 1), on the row-3 characters and on the next `.` or `#`, and continues
across a `${…}` (row 2): `div.a\n  span` is the part `.a` and a child (observed). A part may contain `${…}`
(`<div.${x}-y/>` is one class part, observed). A second `#` part on one tag is
`Multiple shorthand ID parts are not allowed on the same tag`
(`TAG_NAME.exit`).

Because `:` is a name character, a `:name` written after a shorthand is inside
that shorthand's part: the parser reports `<input#main:email.big/>` as the id
part `main:email` and the class part `big` (observed). Core splits the static
part of a shorthand `class`/`id` value at its first `:` (divergence row "A
shorthand class or id cannot contain `:`"; decision 146, addendum of 23:23), and
so shorthands compose in any order. A dynamic shorthand splits only its static
tail, and a `:` before a `${…}` is a positioned error (same row).

## Attributes

An attribute is read by `ATTRIBUTE.parse`, which the open tag enters at rows 13
and 14. For each character the first matching row applies. "Stage" is how far
the attribute has got: nothing read yet, name read, arguments read, type
parameters read.

| # | Character | Condition | Result |
| --- | --- | --- | --- |
| 1 | newline | concise mode (also inside `[ … ]`) | the attribute ends |
| 2 | newline | HTML mode | skipped |
| 3 | whitespace | — | skipped |
| 4 | `<!--` | — | the attribute ends; the open tag reports the HTML-comment error |
| 5 | `=` | — | the value begins after the `=` and after **all** whitespace that follows it, newlines included ([E1](#e1--attribute-value-html-mode), [E2](#e2--attribute-value-concise-mode)) |
| 6 | `:=` | — | as row 5; the value is bound |
| 7 | `...` | — | a spread value begins immediately after the third dot, with **no** whitespace skipped ([E3](#e3--spread-attribute)) |
| 8 | `(` | — | attribute arguments (E4) |
| 9 | `<` | a name has just been read, or an `async` is pending | method type parameters (E16) |
| 10 | `{` | arguments have been read | the method body (E5) |
| 11 | `</` | nothing read yet | `A close tag was found before the "<tag>" open tag was closed. …` |
| 12 | `<` | nothing read yet | `Invalid attribute name. Attribute name cannot begin with the "<" character.` |
| 13 | any other | nothing read yet | the name begins at this character ([Attribute names](#attribute-names)) |
| 14 | any other | something read | the attribute ends; the open tag continues at this character |

What the row order means, all observed:

- **The name's range ends at whitespace, but the attribute does not.** After a
  name, rows 2–3 skip whitespace, in HTML mode across newlines, and rows 5–9
  still attach to that name: `<div x = 1/>` and `<div x\n  =1/>` are `x` with
  the value `1`; `<foo x (a)/>` is `x` with arguments; `<foo x <T>(a) {b}/>` is a
  method named `x`. In concise mode row 1 ends the attribute at a newline, so
  `div x\n  =1` is the attribute `x` and then a child: an unnamed tag with the
  default value `1`. Spaces and tabs are skipped in concise mode as in HTML
  mode: `div x =1` is `x` with the value `1`. A comment is not skipped: it is
  row 14, so it ends the attribute, the open tag reports it as an open-tag
  comment, and an `=` after it begins a new, default attribute:
  `<div x /*d*/ = :a/>` is the name `x`, the comment, then the default value
  `:a` (observed).
- Rows 5–7 do not test the stage. `<div a ...b/>` reports the name `a` and then
  a spread `b`; `<div a(b)=c/>` reports the name, the arguments and the value
  `c`.
- An `=`, `:=`, `(` or `{` (after tag arguments) with no name read is the
  **default attribute**: the parser reports a zero-width name range at the
  attribute's start and then the value or method.
- After arguments without a body the attribute continues, so a second `(` is
  `An attribute can only have one set of arguments`.

After each part is read (`ATTRIBUTE.return`):

| Part | Result |
| --- | --- |
| name | first, a name that is exactly `async`, read first in its attribute, may be held back (below). Otherwise a `::` anywhere in the name's range is the reserved-token error and the parse stops (`rejectReservedName`; `<div ::b/>` and `<div a::b/>` are the error, observed; stock reports the names). Otherwise the name is reported, unless an `async` is pending, and in HTML mode the ambiguous-`>` check runs ([below](#the-ambiguous--check)) |
| arguments | if the attribute already has arguments: `An attribute can only have one set of arguments`. Otherwise, if `{` follows, after any whitespace **including newlines in both modes**, the attribute is a method and the arguments are its parameters. Otherwise, if type parameters were read: `An attribute cannot have both type parameters and arguments`. Otherwise the arguments are reported as attribute arguments |
| method body | the method is reported; the attribute ends |
| type parameters | `(` **must** follow, after any whitespace; otherwise `Attribute cannot contain type parameters unless it is a shorthand method` |
| value | an empty value is `Missing value for attribute`. In HTML mode the ambiguous-`>` check runs. The value (or spread) is reported; the attribute ends |

**`async` methods** (`isAsyncMethodPrefix`, `flushPendingAsync`). A name that is
exactly `async`, read first in its attribute, is held back when the next
character after whitespace (spaces and tabs only in concise mode) is a word
character, `(`, or `<` not followed by `/`. If the attribute then turns out to
be a method, `async` is its modifier and only the method name is reported:
`<div async onClick(a) {x}/>` is the method `onClick`. With no method name
after it, the method is the default attribute's, reported with an empty name:
`<div async(a) {b}/>` and `<div async <T>(a) {b}/>` are default methods
(observed). In every other case it is
replayed as an ordinary attribute name: `<div async x/>` is the names `async`
and `x`, and `<div async(1)/>` is the attribute `async` with arguments (all
observed).

| Form | Syntax | Parser note |
| --- | --- | --- |
| Boolean | `disabled` | a name with no value; **no value event** |
| Value | `value=expr`, `class="card"` | a quoted string is not a separate form: it is an expression whose first token is a string (`<div a="1"b="2"/>` is one value, observed) |
| Bound | `value:=count` | row 6. The space decides: `x:=1` is a bound `x`; `x: =1` is the name `x:` with the value `1` (observed; spec §4 "`:modifier`") |
| Spread | `...expr` | row 7 |
| Arguments | `onClick(a)` | row 8 |
| Method | `onClick(a) { … }`, `onClick<T>(a) { … }`, `async onClick(a) { … }` | rows 8–10 |
| Default | `=expr`, `(a) { … }` after tag arguments | zero-width name |
| Sugar | `#x`, `.x`, `:x` | at this level an attribute whose **name** is `#x`, `.x` or `:x` ([Dialect rules](#dialect-rules)) |

A name containing `:` is one name to the parser (`class:x`, `value:fn` in
`value:fn:=x`, both observed); see the table in
[Status](#status-sources-of-truth-and-method) for the modifier split. A name
containing `::` is the reserved-token error (row "name" above).

### Attribute names

A name is an `EXPRESSION` position with the single flag `terminatedByWhitespace`
(`ATTRIBUTE.parse`, row 13). It therefore follows
[How a position is scanned](#how-a-position-is-scanned) with `operators` off,
which gives these rules and no others:

1. At depth 0 the name ends at a hard stop:

   | Mode | Hard stops | Source |
   | --- | --- | --- |
   | HTML | `,` `=` `(` `>` `<`; `:` when the next character is `=`; `/` when the next character is `>` | `shouldTerminateHtmlAttrName` |
   | Concise | `,` `=` `(` `;` `<`; `:` when the next character is `=`; `-` when the next character is `-` **and** the previous character is whitespace | `shouldTerminateConciseAttrName` |
   | Concise, inside `[ … ]` | `,` `=` `(` `]` `<`; `:` when the next character is `=` | `shouldTerminateConciseGroupedAttrName` |

2. At depth 0 the name ends at any whitespace character or newline. No
   continuation test applies, because `checkForOperators` returns false at once
   when `operators` is off.
3. Rules 1 and 2 are **not** examined inside a group, a string, a template
   literal, a regular expression or a comment, and the character table of the
   scan still applies to a name. So these are each **one** name (all observed):
   `a[b c]` and `{a b}` (a group), `a"b c"` (a string), and `a/ b` (the `/`
   follows a word character, so it is read as a division, and a division
   consumes the whitespace after it).
4. A closing `)`, `]` or `}` with no open group is `Mismatched group. …`
   (`<div a)/>`, observed).

Consequences: a concise name does not end on `[`, `>` or `/` (`div a[b]=1` is
the name `a[b]`); an HTML name ends on `>` and on `/>` but not on a lone `/`;
inside `[ … ]` a name does not end on `;` or `--`.

### The ambiguous `>` check

`detectAmbiguousCloseAngleBracket` runs in HTML mode after every attribute name
and every attribute value. It reports `Ambiguous ">" in attribute. …` only when
all of the following hold:

1. the name or value ended at a space or tab, and the next character after
   spaces and tabs, on the same line, is `>`;
2. scanning on from that `>` by the table below reaches a top-level `>` that is
   not followed by `=`, or a top-level `/>`, without first stopping at a **no
   error** row;
3. at least one word character was seen before it, and the character before it
   (ignoring spaces and tabs) is a word character, `)` or `]`.

The scan in step 2 treats characters as follows (code order):

| # | Character | Effect |
| --- | --- | --- |
| 1 | `>=` anywhere; `>` inside `(…)` or `[…]` | a comparison; scanning continues |
| 2 | word character | an operand; but if an operand already ended at a space or tab and no operator has been seen since, **no error** |
| 3 | space, tab | marks the previous operand as ended |
| 4 | `=>`; `/` preceded (ignoring spaces and tabs) by a word character, `)` or `]`; `(` `[`; a matched `)` `]`; `&` `*` `^` `:` `!` `-` `%` `.` `\|` `+` `?` `~` | connects operands; scanning continues |
| 5 | end of input | **no error** |
| 6 | anything else: a newline, `<`, a quote, a backtick, `{`, `}`, `,`, `;`, a bare `=`, an unmatched `)` or `]`, a `/` not preceded by an operand | **no error** |

Otherwise there is no error and the `>` ends the tag as usual. Observed:
`<div x=a > b/>`, `<div x=a > b>`, `<div x=a >b/>` and `<div a > b>` are the
error; `<div x=a > b</div>` is the value `a`, the end of the open tag, and the
body text ` b`. Whether the TypeScript-aware boundary keeps this check is OQ 8.

## Tag arguments, tag variables, tag parameters and types

Each of these begins at row 14 of [The open tag](#the-open-tag), before the
first attribute.

**Tag arguments** `<Tag(expr)>` ([E6](#e6--tag-arguments)). The parser accepts
arguments followed by attributes (`<foo(a) b=1/>`); the rule that a tag must not
have both is not a parser rule (see [Status](#status-sources-of-truth-and-method)).
Decision 109's exception for a dynamic tag or a `<define>` call allows arguments
with "a body and/or attribute tags", and says "Arguments plus plain attributes
remain an error".

**Tag-level default method** `<Tag(a) { … }>` ([E17](#e17--tag-level-default-method)):
tag arguments followed by `{` are the parameters of the default attribute's
method.

**Tag variable** `<Tag/x>` ([E9](#e9--tag-variable)). A value written after it
with `=` is the tag's **default attribute**, not a value of the variable:
`<let/x = 1/>` is the variable `x` and the default value `1` (observed).

**Tag parameters** `<Tag|a, b|>` ([E7](#e7--tag-parameters)). Spec §8 "Tag
params" says they parse like `<for>`'s, destructuring and type annotations
included, that empty pipes are a no-argument function, and that parameters come
before `=value`.

**Tag type arguments** `<Tag<A, B>>` and **tag type parameters**
`<Tag <A, B>|x|>` ([E14](#e14--tag-type-arguments),
[E15](#e15--tag-type-parameters)); **attribute-method type parameters**
`<div onClick<T>(a) { … }>` ([E16](#e16--attribute-method-type-parameters)).

## Attribute tags

`<@name>` is an ordinary tag to the parser: `<@svg:rect/>` is reported as the
tag name `@svg:rect` (observed). Everything about it is decided after the
parse:

- its name is a property key, so the `:` split does not apply (decision 146,
  addendum 3; spec §4 "Name sugar", "Attribute tags");
- attribute-position sugar on it does apply: `<@z .b>` gives a class (same
  sources);
- its placement and collision rules, including `<@children>` and the reserved
  `content`, are in spec §8 "Collisions and placement";
- an attribute tag on a native element is rejected (spec §8 "Deferred to MX 2").

## Placeholders

`${expr}` interpolates escaped and `$!{expr}` interpolates raw (spec §3
"Interpolation"). `checkForPlaceholder` recognises them in HTML content, in text
content, and inside the quoted strings of text content. It is not consulted in
concise content, in an open tag, or inside an expression. A placeholder is an
atom position wherever it is recognised, a text body's included
([Atoms](#atoms); decision 156, addendum 2): `<script>${:a}</script>` reports
the atom `a` (observed). A template literal in a text body is text, not an
expression, so its `${…}` is no placeholder and lexes no atom:
``<script>`${:a}`</script>`` reports only the text (observed).

A run of backslashes immediately before the `$` escapes it
(`checkForPlaceholder`): with an **odd** count the `${…}` is literal text and
half of the backslashes, rounded down, are kept as text; with an **even** count
half are kept as text and the placeholder is parsed. Observed: `\${a}` is the
text `${a}`; `\\${a}` is the text `\` and the placeholder `a`.

The value is position [E8](#e8--placeholder). An empty value, `${}`, is `Invalid
placeholder, the expression cannot be missing`; `${ }` is not empty (its value
is the space, observed).

Inside an attribute value `${…}` and `$!{…}` are not placeholders: `$` is a word
character and `{…}` is a group, so `<div x=$!{a}/>` is the value text `$!{a}`
(observed). Spec §3 "Interpolation" says `$!{…}` is not accepted inside an
attribute value and attributes the refusal to "Marko's parser"; the template
parser does not refuse it, so the refusal comes from the expression parse of the
layer above (OQ 12).

In concise content a line that begins with `${` is a tag whose name is the
interpolation: `${x} a=1` is the tag `${x}` with an attribute (observed; spec §3
"A bare `${expr}` line").

## Scriptlets and statement tags

**Scriptlets** `$ statement` and `$ { … }` parse as position
[E11](#e11--scriptlets) and are rejected on every host (spec §3 "Scriptlets").

**Statement tags** are position [E10](#e10--statement-tags). A tag is a
statement tag when its name is in **the supplied statement set**, that is, when
the consumer's `onOpenTagName` returns `TagType.statement` (`TAG_NAME.exit`);
the parser has no list of its own. The grammar is the same whatever the set
holds; a name outside the set is an ordinary tag name, so on a target whose set
lacks `static`, `static const a = 1` is the tag `static` with the attributes
`const` and `a`, the second with the value `1` (observed). The
sets are the AST catalogue's ([ast.md §3.10](/architecture/ast/), "Statement keywords per target";
decision 163, addendum 3): the language's six, `import`, `export`, `static`,
`server`, `client` and `class`; on the data target the documented exception
`import`, `static`, `export`; and today, on five hosts and every
`parseFragment` caller, none at all, which MX1 TODO
`statement-tags-not-declared-on-five-hosts` removes. Spec §2 "Syntax", spec §2
"`server` and `client` blocks" and spec §4 "Name sugar" (which lists `class`
among the core taglib's statement tags) together name the six.

## Text, comments, CDATA, doctype, declarations and text bodies

### HTML content

`HTML_CONTENT.parse`, first matching row:

| # | At | Result |
| --- | --- | --- |
| 1 | newline | ends a mixed-mode region or a delimited block when their rules say so; otherwise text |
| 2 | `<![CDATA[` | a CDATA section, to the next `]]>` |
| 3 | `<!--` | an HTML comment, to the next `->` (`HTML_COMMENT.parse` looks for a `-` directly followed by `>`, so `<!-- a -> b -->` ends after `a ->`, observed) |
| 4 | `<!` | a doctype, to the next `>` |
| 5 | `<?` | a declaration, to the next `>`; a `?` directly before that `>` is part of the closer |
| 6 | `</` | a close tag |
| 7 | `<` followed by `>`, `<` or whitespace | text |
| 8 | `<` followed by anything else | an open tag |
| 9 | `$` followed by whitespace, with only whitespace between it and the previous newline | a scriptlet (E11) |
| 10 | `//` or `/*`, when the character before it is whitespace | a JavaScript comment: `//` to the end of the line, `/* */` to its end |
| 11 | `${`, `$!{`, or backslashes before one | a placeholder or escaped placeholder |
| 12 | anything else | text |

Row 10 needs the whitespace: `a // b` is the text `a ` and a comment, while
`http://x` is text (observed). CDATA sections and declarations parse to events
and are rejected in lowering (spec §3 "CDATA sections and XML declarations").

### Text bodies

A **text body** is the body of a tag the consumer typed `TagType.text`. In this
repository the consumer's set is `html-comment`, `html-script`, `html-style`,
`script`, `style`, `textarea` (`TEXT` in
`packages/core/src/close-tag-opener.ts`). The parser has no list of its own, and
spec §9.3 says a tag declaration's `parseOptions` forwards only `text` and
`preserveWhitespace`.

`PARSED_TEXT_CONTENT.parse`, first matching row:

| # | At | Result |
| --- | --- | --- |
| 1 | newline | ends a delimited block when its rules say so; otherwise text |
| 2 | `<` | in HTML mode, `</>` or `</name>` with exactly the open tag's written name ends the body (`checkForClosingTag`); any other `<` is text |
| 3 | `//` | text, to the end of the line or to the body's close tag |
| 4 | `/*` | text, to `*/`; unterminated is `EOF reached while parsing multi-line JavaScript comment` |
| 5 | a backtick | a template literal, lexed as in an expression, `${…}` included |
| 6 | `"` or `'` | a string to the **next** same quote, within which placeholders are recognised; unterminated is `EOF reached while parsing string expression`. A backslash does **not** escape the quote: `PARSED_STRING.parse` treats `\` only as a possible placeholder escape, so `"a\"b"` ends after `a\"` |
| 7 | `${`, `$!{`, or backslashes before one | a placeholder or escaped placeholder |
| 8 | anything else | text |

So a text body is text **and placeholders**, and a quote in it must be balanced:
`<script>a ${x} <b></script>` gives the placeholder `x` and the text ` <b>`;
`<textarea>don't</textarea>` is the string EOF error, and so are the valid
JavaScript bodies `<script>var s = "a\"b";</script>` and
`<script>var s = 'it\'s';</script>` (all observed; OQ 13). Spec §3
"CDATA sections and XML declarations" describes a raw-text body as "a single
`MarkoText`" and lists `<title>` among them; both differ from the above (OQ 13).

## Concise mode: indentation and line rules

`CONCISE_HTML_CONTENT.parse` accumulates a line's leading whitespace as its
indentation and acts on the first other character. In order:

1. Every open tag whose indentation is **as long as or longer than** this
   line's is closed. The comparison is by length.
2. If no tag remains open and the line is indented, the line is `Line has extra
   indentation at the beginning`, unless its first character is `/`.
3. If the enclosing tag is `TagType.text` and the first character is not `-`:
   `A line within a tag that only allows text content must begin with a "-"
   character`.
4. The first child line of a tag fixes that tag's child indentation. A later
   child line whose indentation **string** differs is `Line indentation does
   match indentation of previous line`.
5. The first character then selects:

   | First character | Result |
   | --- | --- |
   | `<` | an HTML region (mixed mode) |
   | `$` followed by whitespace | a scriptlet (E11) |
   | `--` | a delimited block (E12) |
   | `-` not followed by `-` | `A line in concise mode cannot start with a single hyphen. Use "--" instead. …` |
   | `//`, `/*` | a JavaScript comment. After a `/* */` comment only whitespace may follow on the line, otherwise `In concise mode a javascript comment block can only be followed by whitespace characters and a newline.` |
   | `/` followed by anything else | `A line in concise mode cannot start with "/" unless it starts a "//" or "/*" comment` |
   | anything else | an open tag; `$foo` is therefore a tag |

Step 3 together with the `-` rows means a line inside a text tag must start with
`--` in practice: `script\n  - foo` is the single-hyphen error and
`script\n  -- foo` is the text `foo` (both observed).

Rules of the open tag that are specific to concise mode are rows 1, 3, 4, 5 and
6 of [The open tag](#the-open-tag), and the newline behaviour of row 12. The rule for a value that reaches the
end of a line is in [E2](#e2--attribute-value-concise-mode).

Spec §3 "Concise mode" says these rules are inherited from Marko and fixed by
no MX decision.

## Whitespace at the parser level

The template parser reports text as **raw source ranges**; it trims and
collapses nothing. Observed: `<p>\n  $ x\n</p>` reports the texts `"\n  "` and
`"\n"`. The only adjustments it makes are at boundaries it owns: at end of input
in concise content the final text range stops before trailing newlines
(`htmlEOF`), and in a delimited block the block's indentation and the newline
before the closing delimiter are outside the text ranges
(`handleDelimitedBlockEOL`), and a single-line block's text starts after its
hyphens and the character after them and stops before the newline
([E12](#e12--delimited-html-blocks); `div -- a\nb` is the text `a`, observed).

The whitespace rules of spec §3 "Whitespace" (boundary trimming, dropping a
whitespace-only run that begins with a newline, collapsing runs to one space,
ignoring comments, the `preserveWhitespace` bypass) are applied by the consumer
of the parser's events. Today that is `@marko/compiler`'s `onText`, which the
spec calls "Marko's parser". When `@marko/compiler` is dropped (decision 158.2),
the MX layer that takes its place **must** apply them exactly once; decision
158.3 puts the front end from parser events to the MX AST in `@mxlang/parser`,
and no decision says more. Core and hosts **must not** re-normalize (spec §3
"Whitespace").

## Base position for fragment parses

`parse(code, options?)` (`index.ts`, `Parser.parse`) takes an optional base
position for the case where `code` is a substring of a larger file:
`startOffset`, `startLine` (zero-based) and `startColumn` (zero-based), each
defaulting to 0 (`ParseOptions`, `core/Parser.ts`). The options change no
grammar rule and no range:

- Every range passed to a handler, error ranges included, and every range read
  back through `read(range)`, stays relative to `code`, exactly as without the
  options. The parser still scans `code` from index 0.
- `positionAt(offset)` and `locationAt(range)` take a `code`-relative offset or
  range and return positions in the enclosing file: `startLine` is added to
  every line, and `startColumn` to the column on `code`'s first line only.
- `offsetAt(offset)` returns `offset + startOffset`; `startOffset` affects
  nothing else.
- Positions are UTF-16 code units, as all ranges are.

Observed: with `{ startOffset: 100, startLine: 4, startColumn: 7 }`, the value
of `<a x=1/>` is the range `[5, 6)`, `positionAt(5)` is line 4, character 12,
and `offsetAt(5)` is 105; a tag name on the second line of `code` is at its
plain column. This is the base the AST catalogue's fragment rule
([ast.md §5.3](/architecture/ast/)) builds on: the catalogue adds `base.offset` to every reported
range when it builds a node.

## Error conditions

Every diagnostic is a positioned error. The template parser's own messages, each
observed unless a symbol is cited instead:

| Condition | Message |
| --- | --- |
| `=`, `:=` or `...` with no value | `Missing value for attribute` |
| empty `${}` in content, in a tag name or in a template literal | `Invalid placeholder, the expression cannot be missing` |
| `::` where atoms are lexed, or in the static text of a tag name, shorthand part or attribute name | `` `::name` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:name` for an atom `` with the written name ([Atoms](#atoms)) |

End of input inside a **position** is an error only when rule 1 of
[End of input](#end-of-input) does not apply, that is, when a group is open in
the position itself, or when the parser is in HTML mode and the position has no
`terminatedByEOL` flag. Where rule 1 applies the position ends silently and no
row below is raised: in concise mode at depth 0 (`div(a`, `div|a`, `div<A`,
`div (a`, `div onClick(a) {b`, `script -- ${b`), and in either mode for a
line scriptlet or statement at depth 0 (`<div>\n$ a +` reports the scriptlet
`a +` and only `Missing ending "div" tag`; all observed).
For those positions, the message depends on the state that owns the position:

| Condition | Message |
| --- | --- |
| end of input in a position owned by an attribute with no name that is not a spread: an attribute name, a default value or default arguments, and the arguments after a pending `async` (`<div async(a`, observed) | `EOF reached while parsing attribute name for the "<tag>" tag` |
| end of input in a position owned by a named attribute: its value, arguments, method type parameters or method body | `EOF reached while parsing attribute value for the "<name>" attribute` |
| end of input in a spread | `EOF reached while parsing attribute value for the ... attribute` |
| end of input in a tag name's or shorthand's `${…}` | `EOF reached while parsing tag name` |
| end of input in a placeholder | `EOF reached while parsing placeholder` |
| end of input in any other position | `EOF reached while parsing expression` |

A template literal's `${…}` is a position owned by the template literal, so it
falls in the last row (`` <div x=`${a ``, observed). End of input inside the
opaque spans and outside any position is an error in **both** modes, and so is
every other condition below:

| Condition | Message |
| --- | --- |
| end of input after an attribute name and whitespace, HTML mode | `EOF reached while parsing attribute "<name>" for the "<tag>" tag` |
| end of input in a string | `EOF reached while parsing string expression` |
| end of input in a template literal's text | `EOF reached while parsing template string expression` |
| end of input in a regular expression | `EOF reached while parsing regular expression` |
| a newline in a regular expression | `EOL reached while parsing regular expression` (`REGULAR_EXPRESSION.parse`) |
| end of input in a `/* */` comment | `EOF reached while parsing multi-line JavaScript comment` (`JS_COMMENT_BLOCK.parse`) |
| end of input in a CDATA section, an HTML comment, a doctype, a declaration, a close tag | `EOF reached while parsing CDATA`, `… comment`, `… document type`, `… declaration`, `… closing tag` |
| end of input in an HTML-mode open tag | `EOF reached while parsing open tag` |
| end of input in a `[ … ]` group | `EOF reached while within an attribute group (e.g. "[ ... ]").` |
| end of input with an HTML-mode tag open | `Missing ending "<tag>" tag` |
| a closing bracket with no open group, or the wrong one | `Mismatched group. …` |
| the ambiguous `>` | `Ambiguous ">" in attribute. …` |
| `</` where an attribute name would begin | `A close tag was found before the "<tag>" open tag was closed. …` |
| `<` where an attribute name would begin | `Invalid attribute name. Attribute name cannot begin with the "<" character.` |
| a second argument list on an attribute | `An attribute can only have one set of arguments` |
| type parameters on an attribute not followed by `(` | `Attribute cannot contain type parameters unless it is a shorthand method` |
| type parameters and arguments with no method body | `An attribute cannot have both type parameters and arguments` |
| a second argument list on a tag | `A tag can only have one argument` |
| a second parameter list on a tag | `A tag can only specify parameters once` |
| a type list that is not directly after the tag name and is not followed by `\|` or `(` under the conditions of [E15](#e15--tag-type-parameters); type parameters whose `(…)` is not followed by `{` | `Unexpected types. Type arguments must directly follow a tag name and type paremeters must precede a method or tag parameters.` |
| `/` after a tag name followed by whitespace or by an immediate hard stop | `A slash was found that was not followed by a variable name or lhs expression` |
| a second `#id` shorthand | `Multiple shorthand ID parts are not allowed on the same tag` |
| a statement tag in HTML mode | `The "<name>" tag is reserved and cannot be used as an HTML tag.` |
| a statement tag under another tag | `"<name>" can only be used at the root of the template.` |
| an HTML comment in an open tag | `An html comment cannot be used within an open tag. Use a JavaScript comment (// or /* */) instead.` |
| code after `;` on a concise line | `A semicolon indicates the end of a line. Only comments may follow it.` |
| a lone `-` where a concise attribute would begin | `"-" not allowed as first character of attribute name` |
| `--` inside `[ … ]` at an attribute start | `Attribute group was not properly ended` |
| `[` inside `[ … ]`; `]` outside one | `Unexpected "[" character within open tag.`; `Unexpected "]" character within open tag.` |
| a close tag with no open tag | `The closing "<name>" tag was not expected` |
| a close tag naming another tag | `The closing "<x>" tag does not match the corresponding opening "<y>" tag` |
| the concise line errors | the five messages in [Concise mode](#concise-mode-indentation-and-line-rules) |
| text after a closing block delimiter | `A concise mode closing block delimiter can only be followed by whitespace.` |

Rejections raised **outside** the template parser, by core: scriptlets, CDATA
and declarations (spec §3); a second `:` in a tag head, a bare `:` in attribute
position, a `:name` that is not an identifier (divergence rows; spec §4 "Name
sugar"); sugar after a default value (decision 151, ruling 2; spec §4 "Name
sugar", "Left alone"), except after a single-atom default value (decision 146,
addendum 5); duplicate attributes, which are a warning with the last
occurrence winning (decision 135); the atom misuses of spec §4 "Atoms" (member
access, a call, a unary operator, a spread, a non-computed key, an atom where a
binding or target must stand). `::name` is the template parser's own error
(row above). The catalogue's list of front-end codes is [ast.md §3.13](/architecture/ast/).

## Expression boundaries

Every place where a TypeScript expression, statement list, type list or pattern
appears in MX source is one run of the parser's `EXPRESSION` state. This section
first gives the scan that all of them share, then the inventory of positions,
then each position's start, stops and overrides.

### How a position is scanned

A position is created with a start offset, a stop function `shouldTerminate`,
and these flags, all false unless set (`EXPRESSION.enter`):

| Flag | Meaning |
| --- | --- |
| `operators` | the continuation test, the ternary counter, the type context and the operator exemption are active |
| `terminatedByWhitespace` | whitespace and newlines are soft stops |
| `terminatedByEOL` | newlines are soft stops |
| `consumeIndentedContent` | a newline followed by a space or tab never ends the value |
| `inType`, `forceType` | the position starts in a type context; `forceType` keeps it there |
| `atoms` | `:name` is lexed as an atom where an expression is expected ([Atoms](#atoms)) |
| `attrValue` | the position is a named attribute's or a spread's value: the after-value rule applies ([E1](#e1--attribute-value-html-mode)) |
| `defaultAtom` | the position is a default attribute's value: the after-value `:` rule applies while the value is one single atom ([E1](#e1--attribute-value-html-mode)) |

The position also tracks: the group stack (depth); `ternaryDepth`; `inType` and
`forceType` as they change; `wasComment`, set when a `//` comment has just
been read and cleared only when a newline is passed; and, when `atoms` is set,
`atomEnd` (where the last atom lexed in it ends), the comments read so far and
where the last regular expression ended.

`EXPRESSION.parse` examines one character at a time. **The first step that
applies decides**:

1. **Newline** (`\n`, `\r` or `\r\n`). The value **ends before the newline**
   when all four of these hold; otherwise the newline is consumed and
   `wasComment` is cleared:
   1. depth is 0;
   2. the position has `terminatedByEOL` or `terminatedByWhitespace`;
   3. `wasComment` is set, **or** the continuation test (below) fails for this
      newline;
   4. it is **not** the case that the position has `consumeIndentedContent` and
      the character after the newline is a space or tab.
2. **Word character.** Consumed. No stop is examined.
3. **Whitespace at depth 0**, in a position with `terminatedByWhitespace`. The
   value ends before it unless the continuation test succeeds.
4. **Hard stop at depth 0.** If `shouldTerminate` returns true for the
   character, the value ends before it, with one exemption: in a position with
   `operators`, if the value so far contains a non-whitespace character and the
   look-behind table (below) says the last one is an operator, the stop is
   **ignored** and the character falls through to step 5.
5. **The character table.**

   | Character | Effect |
   | --- | --- |
   | `"`, `'` | a string, to the same quote; `\` escapes one character |
   | backtick | a template literal, to the closing backtick; `\` escapes one character; each `${` opens a nested position with the hard stop `}`, no flags but `atoms`, which it copies from the position the template literal is in (`TEMPLATE_STRING.parse`) |
   | `?` | first, with `operators` and `attrValue` at depth 0: when the next character is `?`, or is `.` not followed by a digit, both characters are consumed and nothing else happens ([E1 overrides](#e1--attribute-value-html-mode)). Otherwise, with `operators` at depth 0: `ternaryDepth` + 1, then **all whitespace after it is consumed, newlines included**. Otherwise a plain character |
   | `:` | first, with `atoms`, at any depth: `lexAtom` may consume it as `::` (the reserved-token error, which stops the parse) or as the start of an atom, in which case the atom is consumed and nothing else happens ([Atoms](#atoms)). Otherwise, with `operators` at depth 0: if `ternaryDepth` > 0 it is decremented, otherwise the type context is entered (`inType`); then all whitespace after it is consumed. Otherwise a plain character |
   | `=` | with `operators`, at any depth: if the next character is `>` (an arrow), the type context is left when `inType` is set, `forceType` is not, and the previous non-whitespace character is not `)`; both characters are consumed. If the next character is not `>`, the type context is left unless `forceType` is set or a group is open. Then all whitespace after it is consumed. Without `operators` a plain character |
   | `/` | `//` is a comment to the end of the line; `/*` is a comment to `*/`. Otherwise it is a **division** when the previous non-whitespace character is a word character or one of backtick, `'`, `"`, `%`, `)`, `.`, `<`, `]`, `}`: it is consumed with all whitespace after it. Otherwise it starts a **regular expression**, which runs to the next `/` that is not escaped and not inside `[…]`. This row does not depend on `operators` or on depth |
   | `(`, `[` | opens a group |
   | `{` | opens a group. Before that, when `inType` is set and `forceType` is not, the type context is left unless the previous non-whitespace character is an operator by the look-behind table |
   | `<` | in a type context: opens a group that closes with `>`. Otherwise, with `operators` at depth 0, it is consumed with all whitespace after it. Otherwise a plain character |
   | `>` | a plain character when the position is not in a type context, or when the previous character is `=`. Otherwise it is a closing bracket |
   | `)`, `]`, `}`, and `>` as a closing bracket | closes the innermost group. With no open group, or when the innermost group expects a different closer, the error `Mismatched group. …` |
   | any other | consumed |

Source: `EXPRESSION.parse`; `canFollowDivision` for the division test.

Four properties of the scan matter in every position:

- **A type context exists only where `operators` is on or the position starts
  in one.** In a position with no flags, `?`, `:`, `=`, `<` and `>` are plain
  characters, so only `(`, `[`, `{`, strings, template literals, regular
  expressions and comments shield its hard stop.
- **Inside a group nothing ends the value.** Steps 1, 3 and 4 require depth 0.
  Inside a group, `?` and `:` are plain characters for the ternary counter and
  the type context, so a ternary inside a group does not touch `ternaryDepth`,
  and an `as` or `:` inside a group never enters the type context
  (`<div x=(a as number > b)/>` is one value, observed). Atom lexing is the
  one exception: it runs at every depth.
- **In a position with `operators`, `?`, `:` and a non-type `<` at depth 0,
  and `=` at any depth, consume the whitespace after them themselves**,
  newlines included, in every mode; **a division `/` does so in every
  position**, `operators` or not. After one of them the scan never reaches
  step 1 or step 3 for that whitespace. Of the positions with a soft stop
  ([Inventory](#inventory-of-positions)), E1 to E3, E9, E10 and E11's line
  form have `operators`; the attribute name has not, so there only the
  division does: `<div a: b/>`, `<div a? b/>` and concise `div a: b` are the
  names `a:`/`a?` and `b` (observed). An atom's `:` consumes nothing after it.
- **The opaque spans**: nothing inside a string, a template literal's text, a
  regular expression or a comment is examined. A template literal's `${…}` is
  its own position.

#### The continuation test

`checkForOperators` is called at a newline (step 1) and at whitespace (step 3),
always at depth 0. In order:

1. Without `operators`: **fail**.
2. **Look behind.** If the character immediately before the whitespace or
   newline is an operator by the table below: **succeed**, and all whitespace
   from here on is consumed, newlines included.
3. If this is a newline, and the position has `terminatedByEOL` or the parser
   is in concise mode: **fail**. Nothing after a newline is examined in those
   cases.
4. **Find the next character.** In a position with `terminatedByEOL`, or in
   concise mode, skip spaces and tabs only; otherwise skip all whitespace,
   newlines included.
5. If that character is `<` followed by `/` in HTML mode, or `<!--` in either
   mode: **fail**.
6. If the position's `shouldTerminate` returns true for that character:
   **fail**.
7. **Look ahead.** If that character is an operator by the second table below:
   **succeed**, and scanning resumes where the table says. Otherwise **fail**.

**Look-behind table** (`lookBehindForOperator`). `c` is the character
immediately before the whitespace:

| `c` | Operator? |
| --- | --- |
| `&` `*` `^` `:` `=` `<` `%` `\|` `?` `~` | yes |
| `!` | Skip back over the whole run of `!`. Let `o` be the character before the run. **No** when `o` is `)`, `]`, `"`, `'` or a backtick. **No** when `o` is a word character and the word ending at `o` is neither a unary keyword (last row) nor `in` or `instanceof` as a whole word. **Yes** in every other case, which includes `o` = `}` and `typeof!` |
| `>` | yes when the character before it is `=` (an arrow). Otherwise yes outside a type context and no inside one |
| `.` | yes when the first non-whitespace character after the whitespace is a word character |
| `+`, `-` | when the character before it is the same character (`++`, `--`): the answer is this table applied to the nearest non-whitespace character before the pair. Otherwise yes |
| a lowercase letter | **no** when `c` is the last character of an atom (the position's `atomEnd`): `:new` and `:delete` are names, not keywords. Otherwise yes when a unary keyword ends at `c` as a whole word. Outside a type context the keywords are `async` `await` `class` `function` `new` `typeof` `delete` `void`; inside one they are `async` `await` `class` `function` `new` `typeof` `asserts` `infer` `is` `keyof` `readonly` `unique`. "Whole word" means the keyword starts at the first character of the value, or the character before it is neither a word character nor `.` |
| anything else | no |

The atom check is in `lookBehindForKeyword`, so it also covers the `!` row's
keyword test. Observed: concise `div x=:new\n  span` is the value `:new` and a
child tag `span` (stock: the single value `:new\n  span`, because `new` is a
unary keyword there), and since the operator exemption of step 4 uses the same
table, `<div x=:typeof />` is the value `:typeof` and a self-closed tag (stock:
the value `:typeof /`, then `Missing ending "div" tag`).

`return`, `throw` and `yield` are in neither keyword list. A `/` is not in this
table: a division continues a value by the character table, a `*/` does not
continue it.

**Look-ahead table** (`lookAheadForOperator`). `n` is the next character found
in step 4:

| `n` | Operator? | Scanning resumes |
| --- | --- | --- |
| `&` `*` `^` `!` `<` `%` `\|` `~` `+` `-` | yes | after `n` |
| `/` `{` `(` `>` `?` `:` `=` | yes | at `n`, which the character table then handles |
| `.` | yes when the first non-whitespace character after the `.` is a word character | at that word character |
| a lowercase letter | yes when one of `as` `extends` `instanceof` `in` `satisfies` starts at `n`, is followed by a whitespace character, and the first non-whitespace character after that exists and is not `:` `,` `=` `/` `>` or `;` | at that character |
| anything else | no | — |

When the keyword is `as` or `satisfies` and the position is not already in a
type context, the look-ahead **enters the type context** and sets `forceType`
when `ternaryDepth` is 0.

The look-ahead table above is stock's. MX changes its `:` row for a named or
spread attribute's value and for a single-atom default value, and its `.` row
for a named or spread attribute's value; see
[E1 overrides](#e1--attribute-value-html-mode). `[`, a backtick, a quote and a
word character other than the first letter of `as`, `extends`, `instanceof`,
`in` or `satisfies` (the keyword row) are in neither row, so they never
continue a value across whitespace.

**Two look-ahead rows cross a newline whatever the mode.** Step 4 finds `n` on
the same line in concise mode, but once `n` is found, the keyword row skips
**all** whitespace after the keyword, newlines included, to the operand, and
the `.` row (where it applies) skips all whitespace after the `.` to the word
character. Scanning resumes there, on the later line, and step 1 never sees the
newline. Neither row depends on `terminatedByEOL` or on the mode. So in concise
mode `div x=a in\n  b` is one value, and so is `div x=a instanceof\nB`, whose
operand is at column 0 ([E2](#e2--attribute-value-concise-mode)).

Source: `checkForOperators`, `lookBehindForOperator`, `lookAheadForOperator`,
`lookBehindForKeyword`, and the keyword tables at the top of
`states/EXPRESSION.ts` (`unaryKeywords`, `jsUnaryKeywords`, `tsUnaryKeywords`,
`binaryKeywords`, `relationalKeywords`).

#### The type context

The type context (`inType`) changes how four things are read: `<` opens a group,
`>` closes one, a `>` before whitespace is not a look-behind operator, and the
unary keyword list is the type list. It is **entered** by:

- a `:` at depth 0 with `ternaryDepth` 0, in a position with `operators`;
- an `as` or `satisfies` found by the look-ahead, which also sets `forceType`
  when `ternaryDepth` is 0;
- the position's own flags (the type lists E14–E16, and a statement or scriptlet
  that begins with a type keyword, E10 and E11), which always set `forceType`.

It is **left** only by the three `=`/`{` cases in the character table, and each
of them requires `forceType` to be off. Consequences, all observed:

| Input | Result | Why |
| --- | --- | --- |
| `x=a as Map<K, V> y` | value `a as Map<K, V>` | `<` is a group in a type context |
| `x=f<T>(y)` | value `f<T`; the `>` ends the tag | not a type context, so `>` is E1's hard stop. **Recorded defect**, [below](#recorded-defects-in-the-default) |
| `x=a: T<K> = f<K>(y)` | value `a: T<K> = f<K` | the `=` leaves the context (no `forceType`), then as the row above |
| `x=a as T = b y`, `x=a as T < b y` | one value up to `b` | `forceType`: the context never ends inside the value |
| `x=a as T {k: T} y=1` | value `a as T {k: T}`, then `y=1` | the look-ahead continues at `{`; with `forceType` the `{` does not leave the context |
| `x=(a): T => a` | one value | the `:` enters the context; the arrow follows `T`, not `)`, so `=>` leaves it |
| concise `div x=a as T > b` | `Mismatched group. A closing ">" character was found but it is not matched …` | concise mode has no `>` hard stop, the look-ahead continues at `>`, and in a type context `>` is a closing bracket with no open group. **Valid TypeScript that the default rejects** (OQ 24) |
| HTML `<div x=a as T > b/>` | `Ambiguous ">" in attribute. …` | the `>` is E1's hard stop; then [the ambiguous `>` check](#the-ambiguous--check) |

#### End of input

`EXPRESSION.parse`, after its loop:

1. If depth is 0 and either the parser is in concise mode (the `isConcise` flag
   of [Document structure](#document-structure-and-modes), which a text body
   under a concise tag keeps) or the position has `terminatedByEOL`, the value
   ends silently at end of input. Depth counts only the groups opened inside
   the position, never the delimiter that opened it.
2. Otherwise an error is reported, chosen by the **state that owns the
   position**, not by the position:

   | Owner | Message |
   | --- | --- |
   | an attribute with no name and not a spread | `EOF reached while parsing attribute name for the "<tag>" tag` |
   | any other attribute | `EOF reached while parsing attribute value for the "<name>" attribute` (`...` for a spread) |
   | a tag name | `EOF reached while parsing tag name` |
   | a placeholder | `EOF reached while parsing placeholder` |
   | anything else | `EOF reached while parsing expression` |

Observed per position:

| Input | Mode | Result |
| --- | --- | --- |
| `<div x=(a`, `div x=(a` | HTML, concise | the attribute-value error in both: rule 1 needs depth 0 |
| `<div x` | HTML | the attribute-name error: the name is not yet recorded while it is being read |
| `<div =(a` | HTML | the attribute-name error |
| `<div ...(` | HTML | the attribute-value error with `...` |
| `<div onClick(a` | HTML | the attribute-value error for `onClick`: arguments share the owner |
| `<div(a` | HTML | `EOF reached while parsing expression` |
| `div(a` | concise | **no error**; tag arguments `a` are reported |
| `-- ${a` | HTML block | the placeholder error |
| `static const x = (` | concise | `EOF reached while parsing expression` |
| `$ {a` | concise | **no error**; the scriptlet `a` is reported |
| `<${a` | HTML | the tag-name error |
| `<div ${a` | HTML | the attribute-name error: after a space, `${` begins an attribute name |
| `<foo<A` | HTML | `EOF reached while parsing expression` |
| `` div x=`a `` | concise | `EOF reached while parsing template string expression` (the template literal's own error) |
| `<div async(a` | HTML | the attribute-name error: with `async` pending, the attribute has no name yet |
| `div onClick(a) {b`, `div\|a`, `div<A`, `div (a` | concise | **no error**; the method, parameters, type arguments or tag arguments are reported |
| `script -- ${b`, `textarea\n  -- ${a` | concise text body | **no error**; the placeholder is reported (compare `div\n  -- ${a`, an HTML-mode block: the placeholder error) |
| `div.a${b` | concise | **no error, and no shorthand event**: only the tag `div` is reported |
| `${x` | concise | **no error and no event at all** |
| ``span\n  div x=`${a`` | concise | **no error, and no value event**: the tags and the name `x` are reported |

`div(a` and `$ {a` end silently although a delimiter is open, because the `(`
and `{` were consumed by the owning state (`OPEN_TAG.parse`,
`INLINE_SCRIPT.parse`) and are not on the position's group stack, while the `(`
of `div x=(a` is. The last three rows are worse: the silent exit happens in a
position inside a tag name or a template literal, and the event that position
belonged to is never reported. All of these are **recorded defects**
([below](#recorded-defects-in-the-default); OQ 19).

### Inventory of positions

Every `enterState(STATE.EXPRESSION)` call in the parser's source, with the flags
and hard stop it sets. There are sixteen calls; fifteen are positions.

| Call site | Flags | Hard stop | Position |
| --- | --- | --- | --- |
| `ATTRIBUTE.parse`, value branch | `operators`, `terminatedByWhitespace`, `atoms`; `attrValue` for a named attribute or a spread, `defaultAtom` otherwise | per mode, see E1/E2 | E1, E2, E3 |
| `ATTRIBUTE.parse`, name branch | `terminatedByWhitespace` | per mode | [attribute name](#attribute-names) |
| `ATTRIBUTE.parse`, `(` branch | `atoms` | `)` | E4, and the parameters of E5 |
| `ATTRIBUTE.parse`, `{` branch | `atoms` | `}` | E5, and the body of E17 |
| `ATTRIBUTE.parse`, `<` branch | `inType`, `forceType` | `>` | E16 |
| `OPEN_TAG.parse`, `/` case | `operators`, `terminatedByWhitespace` | per mode | E9 |
| `OPEN_TAG.parse`, `(` case | `atoms` | `)` | E6, and the parameters of E17 |
| `OPEN_TAG.parse`, `\|` case | none | `\|` | E7 |
| `OPEN_TAG.parse`, `<` case | `inType`, `forceType` | `>` | E14, E15 |
| `TAG_NAME.parse`, `${` branch | `atoms` | `}` | E13 |
| `TAG_NAME.exit`, statement branch (`prepareStatement`) | `operators`, `terminatedByEOL`, `consumeIndentedContent`; `inType` and `forceType` after a type keyword | none | E10 |
| `INLINE_SCRIPT.parse`, line form (`prepareScriptlet`) | `operators`, `terminatedByEOL`; `inType` and `forceType` after a type keyword | none | E11, line form |
| `INLINE_SCRIPT.parse`, block form | none | `}` | E11, block form |
| `checkForPlaceholder` (`PLACEHOLDER.ts`) | `atoms` | `}` | E8 |
| `TEMPLATE_STRING.parse`, `${` case | `atoms` when the position holding the template literal has it | `}` | a template literal's `${…}`, inside any position or a text body |
| `util/validators.ts` | — | — | **excluded**: a validation helper for callers of the parser's API, not a place in a template |

"`atoms`" in this table is the whole list of positions where atoms are lexed
(decision 156, addendum 2; the AST catalogue's table "Where the atom lexer
runs", [ast.md §4.3](/architecture/ast/)). An attribute's `(` branch opens one position whether the
attribute turns out to have arguments or to be a method, so a method's
parameters lex atoms too (decision 163, addendum 1). The tag variable, tag
parameters, the type lists, statement tags and scriptlets never do.

So the continuation test can succeed only in E1, E2, E3, E9, E10 and the line
form of E11, the only positions with `operators`. Tag shorthands and tag names
are not positions; they are read by `TAG_NAME.parse`.

### E1 — Attribute value, HTML mode

- **Start:** after the `=` or `:=` and after all whitespace that follows it,
  newlines included (`ATTRIBUTE.parse`, rows 5–6 of
  [Attributes](#attributes)). `x= :b` therefore starts at `:b` (observed).
- **Hard stops** (`shouldTerminateHtmlAttrValue`):

  | Character | Stop when |
  | --- | --- |
  | `,` | always |
  | `/` | the next character is `>` |
  | `>` | the first of these that applies: (1) it is the value's first character: **stop**; (2) the previous character is `=` (an arrow): **no stop**; (3) the previous character is whitespace **and** the next character is `=` (a spaced `>=`): **no stop**; (4) otherwise: **stop** |

  Each is subject to the operator exemption of step 4: a stop character whose
  preceding non-whitespace character is a look-behind operator is consumed
  instead. The results are not consistent: `<div x=a + ,b/>` is the single
  value `a + ,b`, while `<div x=a +/>` and `<div x=a ? />` are `EOF reached
  while parsing regular expression` (all observed; OQ 17). Valid TypeScript
  does reach the exemption, because the look-behind table counts a legal
  identifier spelled like a unary keyword (`async`) and a non-type `>` as
  operators: `<div x=async/>` is the value `async/` and then `Missing ending
  "div" tag`; `<div x=async, y=1/>` is the value `async,` and then `y=1`; a
  trailing instantiation expression in concise mode, `div x=f<T> ,y=1`, is one
  value (all observed; OQ 17, OQ 24).

  Observed for the `>` cases: `<div x=>a/>` is `Missing value for attribute`
  (1); `<div x=a => b>c</div>` is the value `a => b` (2);
  `<if=count >= 10>a</if>` and `<div x=a >= b>c</div>` are one value (3);
  `<div x=a>= b>c</div>` is the value `a` and the body text `= b>c` (4, no
  whitespace before the `>`); `<div x=a>b>c</div>` is the value `a` (4).
- **Soft stops:** whitespace and newlines, by steps 1 and 3 of the scan with the
  continuation test. HTML mode is not `terminatedByEOL`, so the look-ahead
  **does** cross newlines here: `<div x=a\n  + b/>` and `<div x=a\n\n  + b/>` are
  one value, and `<div x=a\n  <span/>` is the single value `a\n  <span`
  (observed).
- **Comments.** A `//` comment ends the value at the end of its line whatever
  precedes it (step 1.3): `<div x=a // c\n  y=1/>` is the value `a // c` and then
  `y=1`, and `<div x=a + // c\n b/>` is the value `a + // c` and then `b`
  (observed). A comment line after the value is drawn into it, because `/` is a
  look-ahead operator: `<div x=a\n  // c\n  y/>` is the value `a\n  // c` and then
  `y` (observed). A `/* */` comment is transparent to steps 1–4 but its closing
  `/` is not a look-behind operator: `<div x=a /* c */ + b/>` is one value, and
  `<div x=a + /* c */ b/>` is the value `a + /* c */` and then the attribute `b`
  (observed; OQ 24).
- **End of input:** an error; see [End of input](#end-of-input).
- **Overrides (MX).** These are the after-value rule of divergence row "The
  parser after-value rule" (decision 146, divergence 3, with addendum 6) and
  decision 146, addendum 5. They apply when the attribute whose value is being read **has a
  name or is a spread** (`attrValue`, set in `ATTRIBUTE.parse`), except the
  last condition of the `:` row, which is addendum 5's and applies to a default
  attribute's value (`defaultAtom`). The `:` row's condition (c) is decision
  146, addendum 6: after whitespace, "a `:` starts a new attribute only when it
  is followed by an identifier start, or is bare before `>`, `/>`, a newline or
  the end of input"; `x=(a) : T => a` stays one value (observed).

  | Where | Stock | MX |
  | --- | --- | --- |
  | look-ahead, `n` = `:` | operator | **not** an operator when (a) `attrValue` is set, **or** `isSingleAtomDefault` holds: `defaultAtom` is set, the value's first character is `:`, the last atom lexed in it is the one that starts there, and only whitespace lies between that atom's end and `n`; and (b) `ternaryDepth` is 0; and (c) the character after the `:` is `A`–`Z`, `a`–`z`, `$` or `_`, or is `>`, `/>`, `\n`, `\r` or end of input (`isBareColonEnd`). Otherwise an operator, as stock |
  | look-ahead, `n` = `.` | operator when the first non-whitespace character after the `.` is a word character | with `attrValue`: **not** an operator when the character directly after the `.` is `A`–`Z`, `a`–`z`, `$` or `_`; otherwise as stock |
  | character table, `?` with `operators` at depth 0 | opens a ternary | with `attrValue`: when the next character is `?`, or is `.` not followed by a digit, both characters are consumed and no ternary opens |

  Because the first two rows are look-ahead rows, the split happens only when
  the continuation test reaches its step 7: there is whitespace before the `:`
  or `.`, and the character before that whitespace is **not** a look-behind
  operator. Observed: `x=a :b` is the value `a` and an attribute named
  `:b`; `x=a.b .c` is the value `a.b` and an attribute named `.c`; `x=a | :b` is
  one value (and `:b` is an atom); `x=a ? b :c` is one value and `x=a ? b : c :d` splits at `:d`;
  `x=a :` before `/>` or `>` is the value `a` and an attribute named `:`;
  `x=a : b` is one value (a space follows the colon); `x=a . b` and `x=a .2xl`
  are one value; `x=a ?? b :c` and `x=a ?.b :c` split at `:c`. In HTML mode the
  split also happens across a newline (`<div x=a\n  .b/>`). On the stock parser
  each of these is one value, except `x=a :` before `/>` (the regular-expression
  EOF error) and before `>` (`Mismatched group`).

  Three parts of the rule have no spec text of their own and are **not
  settled**: the `??`/`?.` case, including that `?:` is not excepted (`x=a ?:b`
  is one value on both parsers; on main the `?` opens a ternary and `:b` is an
  atom) (OQ 3); the digit exclusion (OQ 4); and spreads (OQ 5).
- **Default attribute.** A value with no name has `attrValue` off, so only
  addendum 5's condition can apply: `<if=a .b>` and `<if=a :b>` are one value
  (observed; decision 151, ruling 2; divergence row "The parser after-value
  rule"), and core reports `:name` after such a value as an error (spec §4
  "Name sugar", "Left alone"). When the default value is one single atom, the
  `:` row splits as for a named attribute (decision 146, addendum 5). Observed:
  `<if=:a :b>`, `<if= :a :b>`, `<if=:a\n :b>`, concise `if=:a :b` and
  `<const/x=:a :b/>` are the value `:a` and an attribute named `:b`;
  `<if=:a :b :c>` adds `:c`; `<if=:a :>` is the value and an attribute named
  `:`. Each of these is one value on stock. These stay one value on both:
  `<if=:a .b>` (addendum 5 covers `:` only), `<if=:a.b :c>`, `<if=:a + :b :c>`,
  `<if=(:a) :b>` (the value is not one atom) and `<if=:a ? :b :c>` (the last
  atom is `:b`, and a `?` is open).
- The whitespace that ends a value belongs to neither the value nor the next
  attribute.

### E2 — Attribute value, concise mode

- **Start:** as E1. The whitespace consumed after the `=` includes newlines in
  concise mode too: `div x=\n  a` is the value `a` (observed).
- **Hard stops:**

  | Where | Character | Stop when |
  | --- | --- | --- |
  | outside `[ … ]` (`shouldTerminateConciseAttrValue`) | `,` | always |
  | | `;` | always |
  | | `-` | the next character is `-` **and** the previous character is whitespace |
  | inside `[ … ]` (`shouldTerminateConciseGroupedAttrValue`) | `,` | always |
  | | `]` | always |

  `>` and `/>` are **not** stops in concise mode: `div x=a > b` is one value
  (observed). The operator exemption applies as in E1.
- **Soft stops:** whitespace and newlines, as E1, with the two differences
  steps 3 and 4 of the continuation test make in concise mode: at a newline
  only the look-behind is tried, and at whitespace the look-ahead finds the
  next character `n` on the same line only. But once `n` is found, the
  look-ahead's keyword row and its `.` row skip **all** whitespace after it,
  newlines included ([the look-ahead table](#the-continuation-test)). So **a
  value continues onto the next line in exactly these cases**:

  | Case | Mechanism |
  | --- | --- |
  | a group is open | step 1.1 of the scan |
  | the character immediately before the newline is a look-behind operator, and no `//` comment precedes the newline | step 1.3 |
  | whitespace before the newline follows a look-behind operator | step 3 of the scan: the continuation test consumes that whitespace and the newline together |
  | whitespace, then on the same line `as`, `extends`, `instanceof`, `in` or `satisfies` followed by whitespace that contains the newline, then an operand that is not `:` `,` `=` `/` `>` or `;` | step 7, the keyword row: the scan resumes at the operand, on a later line, at any indentation, column 0 included |
  | whitespace, then on the same line a `.` followed by whitespace that contains the newline, then a word character | step 7, the `.` row: the scan resumes at that word character |
  | the newline is in the whitespace after `?`, `:`, `=`, a non-type `<` or a division `/` | the character table consumes it (the look-ahead hands `n` = `?`, `:`, `=` or `/` to the character table) |
  | the newline is inside a string, a template literal or a `/* */` comment | an opaque span; the scan does not see it |

  In every other case the newline ends the value and the attribute. The open
  tag then ends too, and an indented next line is a **child**, unless the next
  line begins with `,` or the tag is inside `[ … ]` (rows 1–2 of
  [The open tag](#the-open-tag)), where the next line continues the attribute
  list. A `//` comment before the newline ends the value even after an
  operator. Observed, all concise:

  | Input | Result |
  | --- | --- |
  | `div x=a\n  b` | value `a`; child tag `b` |
  | `div x=a\n  <span/>` | value `a`; child tag `span` |
  | `div x=a\n  .b` | value `a`; an unnamed child tag with class `b` |
  | `div x=a\n  :b` | value `a`; child tag `:b` |
  | `div x=a\n  (b)` | value `a`; an unnamed child tag with tag arguments `b` |
  | `div x=a\n  !b`, `\n  + b`, `\n  ? b : c`, `\n  in b`, `\n  {b}` | value `a`; child tags `!b`, `+`, `?`, `in`, `{b}` |
  | `div x=a   \n  b`, `div x=a as T\n  b` | value ends at the line's end; child tag `b` |
  | `div x=a +\n  b`, `div x=a + \n  b` | one value |
  | `div x=a ?\n  b : c`, `div x=a <\n  b`, `div x=a /\n  b` | one value |
  | `div x=(a,\n  b)` | one value |
  | ``div x=`a\nb` c``, `div x=a /* \n */ + b` | one value (then the attribute `c` in the first) |
  | `div x=a.\n  b` | one value: the look-behind `.` row |
  | `div x=a in\n  b`, `div x=a as\n  T`, `div x=a extends\n  b`, `div x=a in \n  b` | one value: the keyword row |
  | `div x=a instanceof\nB` | one value `a instanceof\nB`: the column-0 line is drawn into it |
  | `div x=a satisfies\n  T y=1` | value `a satisfies\n  T`, then `y=1` |
  | `div [x=a in\n  b]` | one value `a in\n  b` |
  | `div x=a .\nspan`, `div x=a . \n  b` | one value: the `.` row |
  | `div x=a in\n  ,b`, `div x=a in\n  =b` | value `a`, then an attribute `in`: the operand is `,` or `=`. With `,` the open tag continues with `b`; with `=` the line `=b` is a child, an unnamed tag with a default value |
  | `div x=a in`, `div x=a in\n` | value `a`, then an attribute `in`: no operand before end of input |
  | `div x=a .\n  .b` | value `a`, an attribute `.`, then an unnamed child tag with class `b`: after the `.` the next word character is not found |
  | `div x=a\n  ,y=b` | value `a`; the open tag continues with `y=b` |
  | `div x=a + // c\n  b` | value `a + // c`; child tag `b` |
  | `div [x=a\n  .b]` | value `a`; attribute `.b` |
  | `div [x=a +\n  b]` | one value |

  A TypeScript parser continues across the newline where the next line begins
  with `<`, `.`, `(`, a binary operator, `?` or `in` (OQ 18). The default
  continues where the **current** line ends with a keyword operator or a lone
  `.`, even onto a line at column 0, which spec §3 "Concise mode" calls a
  sibling (OQ 18).
- **End of input:** ends the value silently at depth 0; an error with a group
  open ([End of input](#end-of-input)).
- **Overrides and default attribute:** as E1. Observed: `div x=a :b` is the
  value `a` and an attribute named `:b`; `div x=a :` at the end of the line is
  the value `a` and an attribute named `:`; concise `if=:a :b` is the default
  value `:a` and an attribute named `:b` (stock: one value each).

### E3 — Spread attribute

- **Start:** the character immediately after `...`; **no** whitespace is
  skipped (`ATTRIBUTE.parse`, row 7). Whitespace there is therefore the first
  thing the scan sees, at step 3, with the third dot as the character before
  it. By the look-behind `.` row the value continues only when a word character
  follows; otherwise the look-ahead table decides. Observed:

  | Input | Result | Row |
  | --- | --- | --- |
  | `<div ... props/>` | spread ` props` (the range includes the space) | look-behind `.` |
  | `<div ...  (a)/>`, `<div ... {a}/>`, `<div ... -a/>` | spread, range including the whitespace | look-ahead `(`, `{`, `-` |
  | `<div ... [a]/>`, `<div ... "s"/>` | `Missing value for attribute` | neither table: **valid TypeScript that the default rejects** (OQ 24) |

- **Stops, soft stops, end of input:** as E1 in HTML mode and E2 in concise
  mode; it is the same call site.
- **Atoms:** lexed, as in E1 (`<div ...:a/>` reports the atom `a`, observed).
- **Overrides:** the after-value rule applies to a spread as to a named attribute:
  `<div ...a .b/>` is the spread `a` and an attribute named `.b`, and
  `<div ...a :b/>` likewise (observed). The spec text does not mention spreads
  (OQ 5).

### E4 — Attribute arguments

`onClick(a, b)`:

- **Start:** the character immediately after `(`; no whitespace is skipped, so
  the range includes it (`<div onClick( a )/>` reports ` a `, observed).
- **Stops:** the `)` at depth 0. No flags: whitespace, newlines, `,` and `>`
  never end it.
- **End of input:** an error in HTML mode. In concise mode the arguments end
  silently when no group is open inside them: `div onClick(a` reports the
  arguments `a` with no error (observed; [End of input](#end-of-input)).
- **Overrides:** none. The after-value rule does not apply (`attrValue`
  belongs to the value position).
- **Atoms:** lexed (`atoms`; decision 163, addendum 1). The same position is a
  method's parameter list when `{` follows, so `<div x(a = :b) { … }/>`
  reports the atom `b` (observed).

### E5 — Attribute method body

`onClick(a) { … }`:

- **Start:** the character immediately after `{`.
- **Stops:** the `}` at depth 0. No flags.
- **Overrides:** the content is a statement list. Atoms: lexed, because a
  method body is an attribute value (lead ruling 2026-10-05, recorded in
  `PROVENANCE.md` and the catalogue's table, [ast.md §4.3](/architecture/ast/)): `return :c` reports
  the atom `c` (observed).

### E6 — Tag arguments

`<Tag(expr)>`:

- **Start:** the character immediately after `(`; no whitespace is skipped
  (`<foo( a )/>` reports ` a `, observed).
- **Stops:** the `)` at depth 0. No flags.
- **After it** (`OPEN_TAG.return`): if `{` follows, after any whitespace, this
  is E17. Otherwise, if type parameters were read before the `(`, the
  `Unexpected types. …` error. Otherwise tag arguments are reported.
- **Atoms:** lexed (decision 156.1): `<foo(:a)/>` reports the atom `a`
  (observed).

### E7 — Tag parameters

`<Tag|a, b|>`:

- **Start:** the character immediately after `|`; no whitespace is skipped
  (`<foo| x |/>` reports ` x `, observed).
- **Stops:** the next `|` at depth 0. No flags, so `:` and `=` are plain
  characters and nothing but a group, string, template literal, regular
  expression or comment shields a `|`.
- **Overrides:** the content is a parameter list (binding patterns with
  optional types and initialisers; spec §8 "Tag params"). A union type or a
  bitwise or at depth 0 ends the list: `<foo|x: A | B|/>` reports the parameters
  `x: A ` and then an attribute named `B|` (observed). **Not settled** (OQ 6).
  Atoms: never lexed (`<foo|a = :b|/>` reports no atom, observed; spec §4
  "Atoms": never in tag params), so `::` is not reserved here either
  (`<foo|a::b|/>` is accepted, observed).

### E8 — Placeholder

`${expr}`, `$!{expr}`:

- **Start:** the character immediately after `${` or `$!{`; no whitespace is
  skipped (`${ a }` reports ` a `, observed).
- **Stops:** the `}` at depth 0. No flags.
- **Atoms:** lexed in every placeholder, text bodies included (decision 156.1
  and addendum 2): `<p>${:a}</p>` and `<script>${:a}</script>` report the atom
  `a`; `<p>${a::b}</p>` is the reserved-token error (observed).

### E9 — Tag variable

`<Tag/x>`:

- **Start:** the character immediately after `/`. If it is whitespace, the error
  `A slash was found that was not followed by a variable name or lhs expression`
  (`OPEN_TAG.parse`); the same error when the value comes back empty, as in
  `<div/=1/>` (`OPEN_TAG.return`).
- **Hard stops** (`shouldTerminateHtmlTagVar`, `shouldTerminateConciseTagVar`):

  | Character | HTML mode | Concise mode |
  | --- | --- | --- |
  | `\|` `,` `=` `(` | stop | stop |
  | `:` | stop when the next character is `=` | same |
  | `<` | stop **unless** the position is in a type context | same |
  | `>` | stop | not a stop |
  | `/` | stop when the next character is `>` | not a stop |
  | `;` | not a stop | stop |
  | `-` | not a stop | stop when the next character is `-` (no whitespace needed before it, unlike E2) |

  The operator exemption applies (the position has `operators`).
- **Soft stops:** whitespace and newlines with the **same flags as E1**, so the
  whole continuation test applies, look-behind and look-ahead, with E2's
  concise-mode differences. Observed: `<div/x y=1/>` is the variable `x`;
  `<div/x + 1 y=1/>` is `x + 1`; `<let/foo : string/>` and concise
  `let/foo : string` are the variable `foo : string`; `<let/x\n  + 1/>` is the
  variable `x\n  + 1`; concise `let/x\n  + 1` is the variable `x` and a child tag
  `+`; concise `let/x as\n  T` is the variable `x as\n  T` (the keyword row of
  E2's table).
- **Types.** A `:` enters the type context, in which `<` opens a group:
  `<let/x: Map<K,V> = 1/>` is the variable `x: Map<K,V>` and the default value
  `1`. Outside a type context `<` is a hard stop and the open tag then reads a
  type list, so `<let/x<T>=1/>` is the `Unexpected types. …` error. A `|` is a
  hard stop even inside a type: `<let/x: A | B = 1/>` reports the variable
  `x: A` and then reads tag parameters to the end of the input, which is `EOF
  reached while parsing expression` (all observed; OQ 6).
- **Overrides:** the after-value rule does not apply. The value that follows
  the variable is the default attribute and is exempt from the after-value rule
  (`<const/x=items\n .filter(Boolean)/>` is one value, observed; divergence row
  "The parser after-value rule"), except after a single atom
  ([E1](#e1--attribute-value-html-mode)).
- **Atoms:** never lexed in the variable itself (`<let/a::b/>` is the variable
  `a::b`, observed); the default value after it is E1/E2 and lexes them
  (`<let/x=:a/>`, observed).

### E10 — Statement tags

A tag whose name the consumer types `TagType.statement`
([Scriptlets and statement tags](#scriptlets-and-statement-tags)):

- **Constraints** (`TAG_NAME.exit`): a statement tag opened in HTML mode is `The
  "<name>" tag is reserved and cannot be used as an HTML tag.`; one with a
  parent tag is `"<name>" can only be used at the root of the template.`
- **Start:** the position begins at the character that ended the tag name. No
  event carries the statement's text; the open tag simply ends where the
  position ends, and no attributes are parsed (pinned by the `statement tags`
  block of `patches/htmljs-parser.test.ts`).
- **Flags:** `operators`, `terminatedByEOL`, `consumeIndentedContent`. There is
  no hard stop and whitespace is not a stop.
- **Where it ends.** Only at a newline or at end of input. By step 1 of the
  scan, with these flags, a newline ends the statement when **all** of these
  hold:

  1. no group is open;
  2. a `//` comment was just read, **or** the character immediately before the
     newline is not a look-behind operator;
  3. the next line does not begin with a space or tab.

  The look-ahead is never tried (step 3 of the continuation test), and the
  look-behind examines the character **immediately** before the newline, so
  trailing whitespace after an operator defeats it. Observed:

  | Input | Result |
  | --- | --- |
  | `static x = 1\ndiv` | ends at the newline; `div` is a tag |
  | `static x = (\n  a)\ndiv` | continues: a group is open |
  | `static x = 1\n  y\nz` | continues onto the indented line; `z` is a tag |
  | `static x = 1 // c\n  y\nz` | continues: indentation wins over the comment |
  | `static x = 1 // c\ny` | ends at the newline |
  | `static a = b\n  && c\ndiv` | continues: indented |

  After the position ends at a newline, row 1 of [The open tag](#the-open-tag)
  still runs, so a following line that begins with `,` continues the open tag
  with attributes: `static const x = 1\n, y` reports an attribute `y` (observed;
  not a rule to copy, OQ 24).
- **Type context** (`prepareScriptlet`). When the code begins, after spaces and
  tabs, with `declare`, `interface` or `type`, followed by at least one space or
  tab and then a type name, the position starts with `inType` and `forceType`.
  A type name is a word character that is not a digit and does not begin one of
  `as` `extends` `instanceof` `in` `satisfies` as a whole word; after `type`
  only, `{` and `*` also count (`import type { A } from "x"`). So
  `static type A = B<C>` and `export type X = { a: 1 }` are read as types, and
  `type = 1` and `type in x` are not.
- **Overrides:** none. Atoms are not lexed here (decision 156.1: "never inside
  `static`/`import`/script blocks").

### E11 — Scriptlets

`$ statement`, `$ { … }`:

- **Start.** In HTML content: a `$` followed by a whitespace character, with
  only whitespace between the `$` and the previous newline
  (`HTML_CONTENT.parse`, `isBeginningOfLine`); `<p>x $ y</p>` and `<p>$ x</p>` are text (observed).
  In concise content: a line whose first character is `$` followed by a
  whitespace character. Then **all** whitespace after the `$` is consumed,
  newlines included (`INLINE_SCRIPT.parse`), and the next character decides the
  form: `{` is the block form, anything else the line form.
- **Line form.** Flags `operators` and `terminatedByEOL`; no hard stop. It ends
  only at a newline or end of input; a newline ends it when no group is open and
  either a `//` comment was just read or the character **immediately** before
  the newline is not a look-behind operator. The type-context rule of E10
  applies. Observed:

  | Input | Result |
  | --- | --- |
  | `$ const a = 1 +\n  2` | one scriptlet |
  | `$ const a = 1 + \n  2` | ends after `+ ` (a space precedes the newline); the next line is then a concise line of its own |
  | `$ a = b &&\n  c` | one scriptlet |
  | `$ a = b\n  && c` | ends at the newline |
  | `$ a =\n  1`, `$ a = b ?\n  c : d`, `$ a = b /\n  c` | one scriptlet: the character table consumes the newline |
  | `$ foo(\n  a\n)` | one scriptlet: a group is open |
  | `<p>\n$ a</p>` | the scriptlet `a</p>`, then `Missing ending "p" tag`: no hard stop, so the close tag on the line is part of it |
  | `$ const a = 1 // c\n  2` | ends at the newline |

  The second row is valid TypeScript cut short by a trailing space (OQ 24).
- **Block form.** No flags; hard stop `}` at depth 0. After the `}` an optional
  `;`, directly or after whitespace, is consumed (`INLINE_SCRIPT.return`).
- **End of input:** the line form ends silently at depth 0. The block form ends
  silently at depth 0 in concise content and is `EOF reached while parsing
  expression` in HTML content. With a group open, both forms are that error in
  both modes (`$ {(a`, observed; [End of input](#end-of-input)).
- **Overrides:** none. Atoms: never lexed ("script blocks" of decision 156.1
  are "TypeScript statement blocks (`static`, `import`/`export`, scriptlets)",
  addendum 2): `$ x = :a` reports no atom (observed).

### E12 — Delimited HTML blocks

A delimited block begins with two or more hyphens, either as a concise line of
their own or after a concise open tag (row 4 of [The open tag](#the-open-tag)).
`BEGIN_DELIMITED_HTML_BLOCK.parse`:

1. The whole run of hyphens is the **delimiter** (`--`, `---`, …).
2. If the run is followed directly by a newline, the block is **multi-line**.
3. Otherwise the **one character after the run is skipped without being
   examined**. If only whitespace remains on the line after it, the block is
   multi-line; otherwise it is **single-line** and its content starts after the
   skipped character.

Step 3 expects that character to be a space, but does not check: `--abc` is the
text `bc`, and `--x\n  a` is a multi-line block whose `x` is discarded (both
observed; OQ 27).

The content of either form is **HTML content**, or text content when the
enclosing tag is `TagType.text` (`Parser.beginHtmlBlock`): tags and placeholders
in it are parsed. Observed: `-- hi ${x} <b>y</b>` gives the text `hi `, the
placeholder `x`, the text ` `, the tag `b` and the text `y`;
`--\n<b>${x}</b>\n--` gives the tag `b` and the placeholder `x`. Spec §3 "A bare
`${expr}` line" gives `-- ${expr}` as the way to write an interpolation on a
line of its own.

A **single-line** block ends at the end of its line (`handleDelimitedEOL`).

A **multi-line** block has an `indent`, taken when the block begins
(`BEGIN_DELIMITED_HTML_BLOCK.enter`):

- for hyphens on a line of their own, that line's indentation;
- for hyphens after an open tag, the indentation of the **next line** when it
  is longer than the tag line's, otherwise the tag line's (`OPEN_TAG.parse`,
  row 4).

At each newline inside the block, the following line is tested in this order
(`handleDelimitedBlockEOL`):

| # | The next line | Result |
| --- | --- | --- |
| 1 | begins with `indent` + the delimiter | the block ends. Only whitespace may follow the delimiter on that line, otherwise `A concise mode closing block delimiter can only be followed by whitespace.` |
| 2 | begins with `indent`, and `indent` is not empty | the block continues; the `indent` is not part of the text |
| 3 | does not begin with `indent`, `indent` is not empty, and the line is not blank | the block ends and the line is read as concise content |
| 4 | anything else: a blank line, or any line when `indent` is empty | the block continues |

So a block at indentation zero ends only at its delimiter or at end of input
(`--\na\nb` is the text `a\nb`), and a longer delimiter lets a shorter one appear
inside (`----\na\n--\nb\n----` is the text `a\n--\nb`) (both observed). A line
that ends the block by row 3 is then subject to the concise indentation rules,
so it can be an error. Observed:

| Input | Result |
| --- | --- |
| `div --\n    a\n  b\nspan` | text `a`; child tag `b`; tag `span`. The `indent` is the four spaces of the `a` line, so `  b` ends the block (row 3) |
| `div\n  --\n    a\n  span\nb` | text `  a\n`; text `span`; `div` closes; tag `b`. The `indent` is the two spaces of the `--` line, so `  span` stays in the block (row 2) |
| `div\n  --\n    a\n span` | `Line indentation does match indentation of previous line` |

### E13 — Interpolation in a tag name or shorthand

`<${expr}>`, `<div.${x}>`, `<div#${x}>`:

- **Start:** the character immediately after `${` (`TAG_NAME.parse`, row 2).
- **Stops:** the `}` at depth 0. No flags.
- **After it:** an empty value is `Invalid placeholder, the expression cannot be
  missing`; the name or shorthand part continues after the `}`.
- **Atoms:** lexed (decision 156, addendum 2): `<${:a}/>` and `<div.${:a}/>`
  report the atom `a` (observed). The atom event comes before the name or
  shorthand event, because that event is reported when the part ends.

### E14 — Tag type arguments

`<Tag<A, B>>`:

- **Start:** the character after a `<` read at row 14 of
  [The open tag](#the-open-tag). The list is type **arguments** exactly when
  that `<` is the character directly after the tag **name**
  (`OPEN_TAG.return`: the name's end equals the list's start). After whitespace,
  or after a shorthand, it is E15: `<foo.a<A>/>` is the `Unexpected types. …`
  error (observed).
- **Flags and stop:** `inType`, `forceType`; hard stop `>` at depth 0. Nested
  `<…>` are groups. There is no `operators` flag, so the `=` row of the
  character table is inert and the `>` of an arrow **is** the hard stop:
  `<foo<() => void>/>` reports the type arguments `() =` (observed), while
  `<foo<(() => void)>/>` is whole. **Valid TypeScript that the default cuts**
  (OQ 24).
- **After it:** nothing is required to follow. Observed: `<foo<A>/>`,
  `<foo<A> x=1/>` (type arguments, then the attribute), `<foo<A>>y</foo>` (type
  arguments, then the body), `<foo<A> |x|/>` (type arguments, then parameters).
  A second list (`<foo<A><B>/>`) is read as E15.

### E15 — Tag type parameters

`<Tag <A, B>|x|>`, `<Tag <A, B>(x) { … }>`:

- **Start, flags, stop:** as E14, for a `<` that is **not** directly after the
  tag name.
- **After it** (`OPEN_TAG.return`). Whitespace is skipped, then the first
  matching row applies:

  | Next character | Condition | Result |
  | --- | --- | --- |
  | `\|` | the tag has no parameters yet | the list is reported as type parameters; E7 follows |
  | `(` | the tag has no type parameters, parameters or arguments yet | the list is held for a tag-level method; E6 follows, and its `)` **must** be followed by `{` (E17), otherwise `Unexpected types. …` |
  | anything else, or a row whose condition fails | — | `Unexpected types. Type arguments must directly follow a tag name and type paremeters must precede a method or tag parameters.` |

  Observed: `<foo <A>|x|/>` is type parameters and parameters;
  `<foo <A>(a) {x}/>` is a default method; `<foo <A>>` and `<foo <A>(a)/>` are
  the error.

### E16 — Attribute-method type parameters

`<div onClick<T>(a) { … }>`:

- **Start:** the character after a `<` read at row 9 of
  [Attributes](#attributes): directly after an attribute name, or after
  whitespace following it, or after a pending `async`.
- **Flags and stop:** as E14, including the arrow cut:
  `<div onClick<T extends () => void>(a) {x}/>` is an error (observed; OQ 24).
- **After it:** `(` **must** follow, after any whitespace, otherwise `Attribute
  cannot contain type parameters unless it is a shorthand method`; and the
  arguments must then be followed by `{`, otherwise `An attribute cannot have
  both type parameters and arguments`. Observed: `<div onClick<T>(a) {x}/>` and
  `<div onClick <T>(a) {x}/>` are methods; `<div onClick<T>/>` and
  `<div onClick<T>(a)/>` are the two errors.

### E17 — Tag-level default method

`<Tag(a) { … }>`:

- **Parameters:** position E6. When `{` follows its `)`, after any whitespace,
  the open tag begins an attribute that already has those arguments
  (`OPEN_TAG.return`).
- **Body:** position E5; the method is reported with a zero-width name.
- This is the form a tag-adjacent sugar followed by `(params) { body }` takes at
  parser level: `<input:email(a) { return a; }/>` is the tag `input:email` and a
  default method (observed). Decision 146, addendum 4 gives it its meaning, in
  core ([dialect rule 5](#dialect-rules)).

### Types inside the other positions

TypeScript's own type syntax (`as`, `satisfies`, annotations, generic
arguments) is not a separate MX position. In the default it is handled only by
[the type context](#the-type-context), inside the positions that have
`operators`. In the planned design the TypeScript parser reads it and returns
the end offset, and each position's hard stops still bound the value.

## Atoms

An **atom** is `:name` written where an expression is expected, in a position
that lexes atoms (decision 156; spec §4 "Atoms"). The template parser finds
atoms, reports them and reserves `::`; it gives them no meaning. The catalogue
node is `MxAtom` ([ast.md §4.3](/architecture/ast/)).

### Where atoms are lexed

Exactly in the positions whose `EXPRESSION` has the `atoms` flag
([Inventory of positions](#inventory-of-positions)): attribute values (named,
bound, default and spread, E1 to E3), attribute arguments and method parameters
(E4), method bodies (E5), tag arguments (E6; E17 uses E6 and E5),
placeholders in every body (E8),
the `${…}` of a tag name or shorthand (E13), and the `${…}` of a template
literal inside any of those. Never in attribute names, the tag variable (E9),
tag parameters (E7), statement tags (E10), scriptlets (E11) or the type lists
(E14 to E16), and never inside a string, a template literal's text, a regular
expression or a comment, which are other states. Decision 156.1 and addendum 2
fix this list; [ast.md §4.3](/architecture/ast/) states it per catalogue field.

### At a `:` (`lexAtom`)

In a position with `atoms`, every `:` the scan reaches in its character table
(step 5, at any depth) goes to `lexAtom` **before** the ternary and type
handling. The first matching row applies:

| # | At the `:` | Result |
| --- | --- | --- |
| 1 | the next character is `:` | the **reserved-token error** (`INVALID_EXPRESSION`): `` `::name` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:name` for an atom ``, with the name read after `::` (with none, the message names `` `::` `` and suggests `:name`), ranged from the first `:` to the end of that name. The parse stops. This row does not look at what precedes the `:`, so `x=a :: b` and `x=(a ? b::c : d)` are the error too (observed) |
| 2 | no name follows: the next character is not `A`–`Z`, `a`–`z`, `$` or `_` | no atom; the `:` is handled by the rest of the character table |
| 3 | a character at or above U+0080 directly follows the name | no atom (`:aé`) |
| 4 | a `-` directly follows the name, then a character at or above U+0080 | no atom (`:a-é`) |
| 5 | an expression is not expected here (`expectsExpression`, below) | no atom |
| 6 | otherwise | an **atom**, from the `:` to the end of the name. It is recorded, `onAtom` reports it, the position's `atomEnd` is set to its end, and the scan resumes after it. The `:` touches neither `ternaryDepth` nor the type context, and the whitespace after the atom is not consumed |

A **name** (`atomNameEnd`) is `[A-Za-z_$][\w$]*(-[\w$]+)*`: a `-` belongs to it
only when a word character follows. Concise `div x=:a-` is the value `:a-`
with the atom `:a`, and `<div x=:a--b/>` is the value `:a--b` with the atom
`:a` (both observed). In HTML mode `<div x=:a-/>` is `EOF reached while
parsing regular expression`: the `/` of `/>` follows the operator `-` (the
step-4 exemption, OQ 17).

### Is an expression expected? (`expectsExpression`)

Scan backwards from the character before the `:`, skipping whitespace and each
comment already read in this position, stopping at the position's start. Let
`p` be the character reached. The first matching row applies:

| # | `p` | Expected? |
| --- | --- | --- |
| 1 | none: only whitespace and comments lie between the position's start and the `:` | **yes** (`x=:a`, `x= :b`, `${ :a}`) |
| 2 | `)`, `]`, `}`, `"`, `'` or a backtick | **no**: an expression ended |
| 3 | `.` | **yes** only when it is the third of `...` (`[...:a]`); otherwise **no** (`a.:b`) |
| 4 | `?` | if the `?` is the position's first character: **yes**. Otherwise let `o` be the character directly before the `?`. If `o` is a word character: **yes** only when the word ending at `o` starts with a digit (`n === 1? :a : :b`); otherwise **no**, it is TypeScript's optional marker (`(a? :T) => a`). If `o` is `]`, `-` or `+`: **no**. Otherwise **yes** (`c ? :a`) |
| 5 | `!` | skip back over every `!` and whitespace. If nothing is left: **yes**. Let `o` be the character reached. If `o` is `)`, `]`, `-` or `+`: **no** (postfix). If `o` is not a word character: **yes** (`(!:a)`). Otherwise **yes** only when the word ending at `o` is an operator word (below; `typeof!:a`), otherwise **no** (`a! :b`) |
| 6 | `>` | **yes** when the character before it is `=` (`a => :b`). Otherwise **no** when the `>` closes a type argument list (below; `y as Array<T> :z`), otherwise **yes** (a comparison or a shift) |
| 7 | `+` or `-` | **no** when the character before it is the same (`a++ :b`); otherwise **yes** |
| 8 | `/` | **no** when it is the last character of a regular expression read in this position (`/re/ :b`); otherwise **yes** (`a / :b`) |
| 9 | any other character that is not a word character | **yes**: an operator or punctuator (`(:a`, `[:a, :b]`, `a + :b`, `{ k: :a }`). The rule (decision 156, addendum 9) counts as a word character here any character at or above U+0080 that is not Unicode whitespace or a line terminator (U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF), so such a character goes to rows 10 and 11; the excepted characters stay in this row (`x=[a,` then U+00A0 then `:b]` lexes the atom, observed). **Behaviour today, see defect `atom-lookbehind-non-ascii`**: the code counts ASCII word characters only, so `x=({ é:a })` and `x=(é :b)` lex the atom (observed) |
| 10 | a word character directly before the `:`, with no whitespace or comment between | **no**: an object key or a label, keyword or not (`{ new:a }`) |
| 11 | a word character, with whitespace or a comment between | **yes** only when the word ending at `p` is an operator word; otherwise **no** (`c ? b :c`) |

**Operator words** (`isOperatorWord`), for rows 5 and 11. The word is the
maximal run of word characters ending at `p`, not extending before the
position's start. By the rule of decision 156, addendum 9, word characters
here include every character at or above U+0080 except Unicode whitespace and
line terminators (U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF), so in `éin :b` the word is `éin` and no atom lexes. **Behaviour
today, see defect `atom-lookbehind-non-ascii`**: the word is `in` and the atom
lexes (observed). In order:

1. the word ends where the position's last atom ends (an atom's own name:
   `:delete :b`): **no**;
2. a `.` directly precedes the word (`a.new :b`): **no**. This includes the
   third dot of a spread, so `[...await :b]` and `[...new :a]` lex no atom
   (observed), although decision 156, addendum 8 makes `await` there the
   operator: behaviour today, see defect
   ([Recorded defects](#recorded-defects-in-the-default));
3. the word is not one of `await` `case` `delete` `do` `else` `extends` `in`
   `instanceof` `new` `of` `return` `throw` `typeof` `void` `yield`
   (`atomKeywords`): **no**;
4. `of`: **yes** only when the character before it, skipping whitespace, is a
   word character, `)`, `]` or `}` (`for (x of :a)`; `c ? of :b` lexes no atom);
5. `yield` or `await`: **no** when the character before it, skipping
   whitespace, is `?`, `:`, `,` or `(`; otherwise **yes**, at the position's
   start too (but `<div x=yield :b/>` never asks: the after-value rule splits
   at ` :b` first, because `yield` is no unary keyword in the look-behind,
   while `<div x=await :b/>` continues and lexes the atom; both observed).
   Decision 156, addendum 8 gives the reason (addendum 2's "a `:`
   TypeScript could own is TypeScript's"): after `(` or `,` the word can be a
   parameter name with a type annotation, and after `?` or `:` a ternary
   operand; elsewhere it can only be the operator. `f(await :b)` and
   `(a, yield :b)` lex no atom; `x=await :b` and `return await :a` in a method
   body do;
6. any other word of the list: **yes** (`return :a`, `x in :a`).

**A type argument list's closing `>`** (`closesTypeArguments`), for row 6.
Scan backwards from the `>` towards the position's start, counting each `>`
not preceded by `=` up and each `<` down, and each closing bracket `)` `]` `}`
up and each opening one down. At each character, in order:

1. a `<` that brings the angle count to 0: the `>` closes type arguments
   exactly when no bracket is open between them and the `<` directly follows a
   word character (`Array<T>`, `a<b >`);
2. an opening bracket with no closing one after it: **no**;
3. `;`: **no**;
4. `?` or `:` with no bracket open between it and the `>`: **no**;
5. `&&` or `||`: **no**;
6. the position's start reached: **no**.

So `a < b >` (a space before `<`) and `a < b && c >` are comparisons, and
`c ? a < b > :z` lexes the atom (observed as `x=(c ? a < b > :z)` and in
concise mode; unparenthesised in HTML mode the `>` is E1's hard stop and the
ambiguous-`>` error comes first). Decision 156, addendum 4 pins this and
`(a<b> :c)` with no open `?` as known limits of a lexer without a type parser.

Observed (main; stock reports no atom anywhere):

| Input | Atoms |
| --- | --- |
| `x=:a`, `x= :b`, `x=(:a)`, `x=[:a, :b]`, `x=a + :b`, `x=a / :b`, `x=a => :b`, `x=c ? ...:a`, `x=[...:a]`, `x=(!:a)`, `x=(typeof!:a)`, `x=c ? 1? :a : :b`, `x=(return :a)`, `x=(x in :a)`, `x=(for (x of :a))`, `x=await :b`, `x=({ new :a })`, `x=(a ?? :b)`, `x=:a-b` | lexed |
| `x=(:delete :b)` | only `:delete` |
| `x=a.:b`, `x=(a? :T) => a`, `x=(a?:b)`, `x=(a! :b)`, `x=(a++ :b)`, `x=(/re/ :b)`, `x=({ new:a })`, `x=(a.new :b)`, `x=c ? of :b`, `x=f(await :b)`, `x=(yield :b)`, `x=(a, yield :b)`, `x=c ? a[0] :b`, `x=c ? "s" :b`, `x=:aé`, `x=:a-é`, `x=:1`, `x=: a`, `x=(a /* c */ :b)`, `x=(a // c\n :b)` | none |

### The reserved `::` outside expressions

`::` is also reserved in the static text of a tag name and each shorthand part
([Tag names](#tag-names)) and anywhere in an attribute name's range
([Attributes](#attributes)), by `rejectReservedName`, with the same message and
range rule (including the source-read name of [Tag names](#tag-names)). Outside
those two name positions it is not reserved where atoms are not lexed:
`<let/a::b/>` and `<foo|a::b|/>` are accepted, and `::` inside a string is
text (all observed).

### How atoms interact with the other rules

- **Ternary counter and type context:** an atom's `:` counts for neither
  ([Ternary depth](#ternary-depth)).
- **Look-behind keywords:** a lowercase letter that ends an atom is never a
  unary keyword ([the look-behind table](#the-continuation-test)).
- **The after-value rule** runs at step 7 of the continuation test, before the
  character table sees the `:`, so a `:name` it splits off is an attribute
  name, never an atom: `x=:a :b` is the atom value `:a` and an attribute named
  `:b` (spec §4 "Atoms": "the name sugar is an atom standing alone in
  attribute position"). A single-atom default value lets the split happen for
  a default attribute too (decision 146, addendum 5;
  [E1](#e1--attribute-value-html-mode)).
- **Where a value ends.** An atom adds no hard stop and ends no position by
  itself, but lexing it changes where a value ends through these code paths,
  each compared with the same input read without atom lexing (stock, which
  also lacks the after-value rule, is given where it differs):

  | Code path | Effect | Observed on main | Without atoms |
  | --- | --- | --- | --- |
  | `lexAtom` runs before the ternary counter (`EXPRESSION.parse`, `case CODE.COLON`) | an atom's `:` does not close a `?`, so a later ` :name` is the ternary's `:` | `x=a ? :b :c` one value; `x=c ? :a : :b :d` splits at `:d` | the atom's `:` closes the `?`: `x=a ? :b :c` splits at `:c` (stock: one value) |
  | the same, at `ternaryDepth` 0 | an atom's `:` does not enter the type context, so `<` and `>` keep their non-type meaning | concise `div x=:a > b`, `div x=:a <b> c`, `div x=:a >\n  b`: one value | the `:` enters the type context and the `>` is `Mismatched group` (stock) |
  | the atom guard in `lookBehindForKeyword` (continuation test step 2, and the step-4 exemption) | an atom named like a unary keyword is no operator | `x=:new :b` and `x=:typeof :b` split at `:b`; concise `div x=:new\n  span` ends at the newline; `<div x=:typeof />` ends before `/>` | `new`/`typeof` continue the value (stock: `:new :b`, `:new\n  span`, `:typeof /` then `Missing ending "div" tag`) |
  | `lexAtom` row 1 | `::` is the reserved-token error and the parse stops | `x=::a`, `x=a :: b` | one value (stock) |
  | `isSingleAtomDefault` (decision 146, addendum 5) | a default value that is one atom splits at ` :name` | `<if=:a :b>` | one value (decision 151, ruling 2; stock) |

  `mx-atoms.cases.ts` pins `<div x=:new :b/>`.

### What the parser reports

- `onAtom` (`util/constants.ts`), once per atom, in source order, as it is
  lexed. Its range is the whole atom, `:` included; its `value` is the name.
  It comes before the event that reports the range holding the atom
  (`atom ":a"`, then `value ":a"`).
- `read(range)` (`Parser.read`) returns the source of `range` with every atom
  wholly inside it replaced by a numeric literal of the same length, `0.`
  followed by zeros (`:a` is `0.`, `:rename-all` is `0.000000000`). A read of
  exactly a raw open tag (from the tag name's start to the `onOpenTagEnd`
  range's start, `rawOpenTags`) returns the source. The stand-in exists for
  consumers that hand `read()` text to Babel (today `@marko/compiler`); a
  consumer that wants the source slices it. The catalogue's front end builds
  the atom's `StringLiteral` with `extra.mxAtom` itself ([ast.md §4.3](/architecture/ast/), §7).

## Dialect rules

These are MX's own rules. Each says which layer applies it: the template parser
(this document's subject) or core, after the parse.

1. **Tag-adjacent sugar.** `#x` sets an id, `.x` a class and `:x` a name, in any
   order, on a named tag or the unnamed tag (decision 146 and its addendum of
   23:23; spec §4 "Name sugar"). *Layer:* the parser reports the written head
   ([Tag names](#tag-names), [Shorthand](#shorthand-id-and-class)); core splits
   it.
2. **Attribute-position sugar, first or after a boolean attribute.** The parser
   reports attributes named `#x`, `.x`, `:x` (`<input :email type="email"/>`,
   `<input :email :other/>`, `<div a .b/>`, observed); core rewrites them to `id`,
   class and `name` (spec §4 "Name sugar", "In attribute position").
3. **Attribute-position sugar after a value.** `#x` after a value is already a
   new attribute in the default, since `#` is in neither operator table. `:x`
   and `.x` after a value are new attributes only through MX's after-value
   rule ([E1 overrides](#e1--attribute-value-html-mode); decision 146,
   divergence 3). The default attribute's value is exempt (decision 151, ruling
   2), except that when it is a single atom, whitespace and `:name` after it is
   the name sugar (decision 146, addendum 5; `isSingleAtomDefault`, E1).
4. **The sugar's value.** `:name` takes an identifier, `[A-Za-z_$][\w$-]*`;
   `#x` and `.x` take what a shorthand part takes (spec §4 "Name sugar"). The
   after-value rule's test for a `:` or `.` split checks only the character
   right after the sigil, which must be `A`–`Z`, `a`–`z`, `$` or `_`; what
   follows it is then read as an attribute name, by the name rules. So the test
   is narrower than the shorthand's rule at the first character (`x=a .2xl`
   does not split although `.2xl` is a valid class sugar elsewhere, OQ 4) and
   broader than the identifier rule after it (`x=a :b%c` splits off an
   attribute named `:b%c`, which core then rejects). `x=a .é` splits on the
   stock parser too, because `é` is not a word character and the value simply
   ends (all observed).
5. **A sugar followed by `=value` or `(params) { body }`** sets the tag's
   default attribute; the only error is a tag that already has a default value
   (decision 146, addendum 4). *Layer:* core (`packages/core/src/name-sugar.ts`).
   At parser level the forms are ordinary: `<input:email=1/>` is the tag
   `input:email` with a default value; `<input :email=1/>` is an attribute named
   `:email` with the value `1`; `<input #main(a) {}/>` is a method named `#main`
   (all observed). The catalogue records the result as `MxShorthand.operator`
   and `default` ([ast.md §3.6](/architecture/ast/)).
6. **Left alone** (spec §4 "Name sugar", "Left alone"; decision 146, divergence
   2 and addendum 3): the named forms `class:x`, `style:x`, `value:fn:=x` and the
   explicit `value:x`; a dynamic tag name; a bound attribute; the default
   attribute; an attribute tag's own name.
7. **Repeated sugars** follow the duplicate rule: the later one wins, with a
   warning (decision 135; spec §4 "Name sugar"). The parser reports each:
   `x=a :b :c` is the value and two attributes (observed; stock: one value).
8. **A bare `:`** in attribute position is a positioned error from core
   (divergence row "Bare `:x` is `name="x"`"). The after-value rule ends a
   value before a bare `:` so that the error can name it ([E1 overrides](#e1--attribute-value-html-mode));
   `<input :/>` is an attribute named `:` on both parsers (observed).
9. **The unnamed tag and `defaultTag` (decision 145).** The parser reports an
   empty name range and **must not** write a tag name into it. Core resolves the
   name afterwards: parent contract `defaultTag`, then user config
   `package.json#mx.<target>.defaultTag`, then the host override, then the
   target's built-in (decision 145, addendum 2). An invalid `defaultTag` value
   is an error at its declaration, never at the use site (decision 145 and its
   addendum 1). The one place the parser itself assumes `div` is close-tag
   matching ([Document structure](#document-structure-and-modes); OQ 25).
10. **Wildcard children (decision 147)** add no syntax: a child keeps its
    authored tag name, and only `<:att>` yields a child whose `name` is `att`.
    The parser is unaffected.
11. **Atoms (decision 156 and its addenda 1 to 4 and 8).** `:name` in an MX
    expression position is a value that represents itself; its runtime value
    is the name as a string (156.1, 156.2). *Layer:* the template parser lexes
    it and reserves `::` ([Atoms](#atoms)); core gives it meaning and raises
    the misuse errors of spec §4 "Atoms".

### Ternary depth

- In a position with `operators`, a `?` at depth 0 adds one to `ternaryDepth`
  and a `:` at depth 0 takes one away; a `:` at `ternaryDepth` 0 enters the
  type context instead ([the character table](#how-a-position-is-scanned)).
- An atom's `:` does neither: `lexAtom` consumes it first. So `x=a ? :b :c` is
  one value, `a ? :b` closed by the second `:` (observed; spec §4 "Atoms":
  "an atom's own `:` is never the ternary's"). This is one of several ways
  atoms change where a value ends; [Atoms](#how-atoms-interact-with-the-other-rules)
  lists them all.
- A `?` or `:` inside a group, a string, a template literal or a comment does
  not count.
- The after-value `:` split requires `ternaryDepth` 0
  ([E1 overrides](#e1--attribute-value-html-mode)).
- In a named or spread attribute's value, `??` and `?.` (when no digit follows
  the `.`) do not count. `?:` does: `x=a ?:b` is one value, and on main its
  `:b` is an atom (observed). Not settled (OQ 3).

## Ambiguous inputs

Each row gives an input and the parse the grammar requires. "Observed" is the
event stream of main's template parser, with the stock parser agreeing unless
the row says otherwise. Inputs written `x=…` were run as `<div x=…/>` unless a
tag is shown. Where the parser reports a name and core gives it meaning, both
are given.

| Input | Required parse | Settled by |
| --- | --- | --- |
| `x=a ? b : c` | one value | default (observed) |
| `x=a :b` | value `a`, then an attribute named `:b` (core: `name="b"`). Stock: one value | decision 146, divergence 3 (observed) |
| `x=a.b .c` | value `a.b`, then an attribute named `.c` (core: class `c`). Stock: one value | decision 146, divergence 3 (observed) |
| `x=(a) :T => a` | value `(a)`, then an attribute named `:T` whose value is empty: `Missing value for attribute`. Stock: one value | decision 151, ruling 3; divergence row "The parser after-value rule" (observed) |
| `x=(a): T => a` | one value | default (observed) |
| `x=(a) : T => a` | one value: a space follows the `:` | decision 146, addendum 6 (observed) |
| `x=a ?? b` | one value | default (observed) |
| `x=a?.b` | one value | default (observed) |
| `x=a?.b :c` | value `a?.b`, then an attribute named `:c`. Stock: one value | decision 146, divergence 3 for the split; the `?.` handling is MX's, **not settled** (OQ 3) |
| `x=a < b` | one value | default (observed) |
| `x=f<T>(y)` | observed: value `f<T`; the `>` ends the tag; `(y)/>` is body text. A recorded defect; the required parse is **not settled** | OQ 7 |
| `<div x=a > b</div>` | value `a`; the tag ends at `>`; body text ` b` | default: E1's `>` stop (observed) |
| `<div x=a > b/>`, `<div x=a > b>` | `Ambiguous ">" in attribute. …` | default: the ambiguous `>` check (observed); OQ 8 |
| concise `div x=a > b` | one value | default: `>` is not a concise stop (observed) |
| `x=a as T` | one value | default (observed) |
| `x=a satisfies T` | one value | default (observed) |
| `x=a! .c` | value `a!`, then an attribute named `.c`. Stock: one value | decision 146, divergence 3 (observed) |
| `x=/re/ .c` | value `/re/`, then an attribute named `.c`. Stock: one value | decision 146, divergence 3 (observed) |
| `x=a as Map<K, V>` | one value | default: the type context (observed) |
| `x=a [0]` | value `a`, then an attribute named `[0]` | default (observed); **not settled**, OQ 2 |
| `x=a {b}` | one value | default (observed); **not settled**, OQ 2 |
| `x=a: b` | one value | default (observed); OQ 2 |
| `` x=a `t` `` | value `a`, then an attribute named `` `t` `` | default (observed); **not settled**, OQ 2 |
| `x=a .2xl` | one value | the after-value rule's digit exclusion (observed); **not settled**, OQ 4 |
| `x=a :b :c` | value `a`, then attributes named `:b` and `:c`; core: the later name wins, with a warning. Stock: one value | decision 146, divergence 3; decision 135; spec §4 "Name sugar" (observed) |
| `x=a ?:b` | one value; `:b` is an atom | default for the extent (observed); OQ 3. The atom: decision 156 ([Atoms](#atoms), row 4) |
| `x= :b` | the value `:b`, which is the atom `b` | decision 156.1; spec §4 "Atoms" (observed) |
| `x=:a :b` | the atom value `:a`, then an attribute named `:b` (core: `name="b"`). Stock: one value | decision 146, divergence 3; spec §4 "Atoms" (observed) |
| `x=a ? :b :c` | one value, `a ? :b : c`, with the atom `b`. Stock: one value, no atom | decision 156; spec §4 "Atoms" (observed) |
| `<if=:a :b>` | the default value `:a` (an atom), then an attribute named `:b`. Stock: one value | decision 146, addendum 5 (observed) |
| `<if=:a .b>` | one value | decision 151, ruling 2: addendum 5 covers `:` only (observed) |
| `x=a :: b`, `x=::a`, `x=(a ? b::c : d)` | the reserved-token error at the `::`. Stock: one value | decision 156.5 and addendum 2 (observed) |
| `x=(c ? a < b > :z)`, concise `div x=c ? a < b > :z` | one value with the atom `z` (a spaced `< >` is a comparison). Unparenthesised in HTML mode, `<div x=c ? a < b > :z/>` is the ambiguous-`>` error: the `>` is E1's hard stop first | decision 156, addendum 4: a known limit (observed) |
| `div x=a\n  <span/>` (concise) | value `a`, then the child tag `span` | default: [E2](#e2--attribute-value-concise-mode) (observed); OQ 18 |
| `div x=a\n  .b` (concise) | value `a`, then an unnamed child tag with class `b` | same |
| `div x=a\n  (b)` (concise) | value `a`, then an unnamed child tag with tag arguments `b` | same |
| `div x=a\n  + b` (concise) | value `a`, then the child tag `+` | same |
| `div x=a +\n  b` (concise) | one value | default: the look-behind (observed) |
| `<div x=a\n  <span/>` (HTML) | observed: the single value `a\n  <span`. **Not settled** | OQ 2, OQ 18 |
| `<input type="email" :email>` | `type="email"`, then an attribute named `:email` (core: `name="email"`). Stock: one value | decision 146, divergence 3; spec §4 "Name sugar" (observed) |
| `<:email/>` | parser: tag name `:email`. Core: the unnamed tag with `name="email"` | decisions 145 and 146 |
| `<input:email/>` | parser: tag name `input:email`. Core: tag `input`, `name="email"` | decision 146, divergence 1 |
| `<input :email/>` | parser: an attribute named `:email`. Core: `name="email"` | decision 146; spec §4 "Name sugar" |
| `<input#main:email.big/>` | parser: id part `main:email`, class part `big`. Core: id `main`, name `email`, class `big` | decision 146, addendum of 23:23 |
| the six orders of the three tag-adjacent sugars: `<input:email.big#main/>`, `<input:email#main.big/>`, `<input.big:email#main/>`, `<input.big#main:email/>`, `<input#main:email.big/>`, `<input#main.big:email/>` | parser: the `:name` stays in the tag name (first two) or in the shorthand part it follows (`.big:email`, `#main:email`). Core: each sugar keeps its meaning | decision 146, addendum of 23:23 (observed) |
| `<input #main/>`, `<input .big/>` | parser: attributes named `#main`, `.big`. Core: id, class | decision 146; spec §4 "Name sugar" |
| `<input :email type="email"/>` | parser: attributes `:email`, then `type`. Core: `name` first | decision 146 |
| `<input x=1 #main .big :email/>` | parser: `x=1`, then attributes named `#main`, `.big`, `:email` | decision 146 (observed) |
| `<input x=a.b .c/>` | as `x=a.b .c` | decision 146, divergence 3 |
| `<input:email=1/>` | parser: tag `input:email` with a default value `1`. Core: `name="email"` and the default value | decision 146, addendum 4 |
| `<input :email=1/>` | parser: an attribute named `:email` with the value `1`. Core: `name="email"` and the default value `1` | decision 146, addendum 4; spec §4 "Name sugar" |
| `<input:email(a) { return a; }/>` | parser: tag `input:email` with a default method. Core: `name="email"` and a default value that is the function | decision 146, addendum 4 |
| `<input #main(a) {}/>` | parser: a method named `#main`. Core: id `main` and a default value that is the function | decision 146, addendum 4 |
| `<input x=1 :/>`, `<input :/>` | parser: an attribute named `:` (the first not on stock). Core: positioned error, bare `:` | divergence row "Bare `:x` is `name="x"`" |
| `<a:b:c/>` | parser: tag name `a:b:c`. Core: positioned error, one name per tag | divergence row "A static tag name may not contain `:`"; spec §4 "Name sugar" |
| `<if=a\n .b>x</if>` | one value: the default attribute is exempt | decision 151, ruling 2 (observed) |
| `<const/x=items\n .filter(Boolean)/>` | one value | decision 151, ruling 2 (observed) |
| `<div class:x=1/>`, `<div style:x=1/>` | parser: an attribute named `class:x` / `style:x`. Reserved on native elements | spec §4 "`class:foo` / `style:foo` modifiers" |
| `<input value:fn:=x/>` | parser: a bound attribute named `value:fn` | decision 146, divergence 2 (observed) |
| `<div><@svg:rect/></div>` | parser: a tag named `@svg:rect`, not split. An attribute tag on a native element is then an error | decision 146, addendum 3; spec §8 "Deferred to MX 2" |
| `x=a ? b :c` | one value | default: `ternaryDepth` is 1 at the `:` (observed) |
| `x=a ?? b :c` | value `a ?? b`, then an attribute named `:c`. Stock: one value | the after-value rule's `??` case (observed); **not settled**, OQ 3 |
| `x=a ?.b :c` | value `a ?.b`, then an attribute named `:c`. Stock: one value | the after-value rule's `?.` case (observed); **not settled**, OQ 3 |
| `div x=a in\n  b` (concise) | one value | default: the look-ahead keyword row (observed); OQ 18 |

## Open questions for mx-lead

The numbers are stable across drafts, because the text cites them. Seven
items have been settled since they were raised (9, 14, 20, 21, 28, 29, 32);
each says so in place, with the decision or ruling that settled it, and the
normative text follows that ruling. Every other item is unresolved, and the
normative text does not resolve it.

1. **End offset from the expression parser.** The vendored `@babel/parser` has
   no entry point that returns where an expression stopped; `startIndex` fixes
   only the start. *Recommendation:* a thin wrapper, owned by the parser lead,
   that returns the node and its end index, built first.
2. **Where the default and a TypeScript parser end a value differently.** The
   cases are in [the table below](#where-a-real-typescript-parser-would-end-the-value-differently),
   each with its class under the 2026-10-05 ruling. *Recommendation:* rule the
   rows of class (c) one by one; until then the boundary reproduces the default
   for them, as decision 157.3 requires.
3. **`??`, `?.` and `?:`.** MX's after-value rule stops `??` and `?.` from opening a
   ternary, and tests pin it, but no spec paragraph or decision states it, and
   `?:` still counts as a ternary (and on main `x=a ?:b` reads `:b` as an atom). *Recommendation:* state `??` and `?.` in the
   spec as what "no open `?`" means, and decide whether `x=a ?:b` is an error.
4. **`.` followed by a digit.** The after-value rule does not split `x=a .2xl`, while spec
   §4 "Name sugar" says `.2xl` works as a class "in both positions".
   *Recommendation:* keep the exclusion and say so in the spec, or align the
   positions.
5. **Spreads.** MX applies the after-value rule to a spread
   (`...props .b` splits); the spec text and divergence row speak of "an
   attribute value". *Recommendation:* rule spreads in explicitly.
6. **`|` inside tag parameters and tag variables.** `<foo|x: A | B|/>` ends the
   parameters at the first `|`, and `<let/x: A | B = 1/>` ends the variable
   there. *Recommendation:* require parentheses around a union or bitwise or in
   both positions, and say so in spec §8.
7. **Generic calls and generic arrows in an HTML-mode value.** `x=f<T>(y)` and
   `x=<T,>(a) => a` are cut at `>` with no error. *Recommendation:* the
   TypeScript-aware boundary consumes the type arguments; rule whether E1's `>`
   stop yields to it.
8. **The ambiguous `>` error.** *Recommendation:* keep it; a TypeScript parser
   cannot tell `>` the operator from `>` the tag end either.
9. **Atoms in a ternary.** *Settled* by decision 156 and spec §4 "Atoms" ("an
   atom's own `:` is never the ternary's"): `x=a ? :b :c` is one value on main
   ([Ternary depth](#ternary-depth)).
10. **Wording of the parser's own errors.** Messages such as `A semicolon
    indicates the end of a line. Only comments may follow it.` and the HTML
    comment error are the stock parser's; no MX source says whether MX keeps
    the wording. *Recommendation:* keep them and pin each with a fixture.
11. **Spec §4 contradicts itself on a bare `:foo`.** Spec §4 "Attribute forms"
    (row "Namespaced name": `:foo=y` is "Marko's own attribute named
    `value:foo`") and spec §4 "`:modifier`" (`<div :foo="y"/>` "is one
    attribute literally named `value:foo`"; `<div :/>` is `value:`) say the
    opposite of spec §4 "Name sugar" and divergence row "Bare `:x` is
    `name="x"`", which decision 158.1's "no `value:` modifier split" also
    supports. (The earlier question here, `:x=1` listed as an error, is settled:
    spec §4 "Name sugar" now states decision 146 addendum 4.)
    *Recommendation:* rewrite the two `value:` paragraphs for named heads only
    (`x:foo`, `value:foo`) and point bare `:foo` at the name sugar.
12. **`$!{…}` in an attribute value.** The template parser accepts it as value
    text; spec §3 "Interpolation" says "Marko's parser rejects it". Under
    decision 158 there is no Marko compiler; which MX layer raises it?
    *Recommendation:* the expression parse at the boundary, with an MX message.
13. **Text bodies.** The parser recognises placeholders, strings and template
    literals in a `TagType.text` body, and an unbalanced quote there is an
    end-of-input error (`<textarea>don't</textarea>`), and a backslash does not
    escape a quote there, so valid JavaScript such as `<script>var s =
    "a\"b";</script>` is that error too; spec §3 "CDATA sections
    and XML declarations" says such a body is "a single `MarkoText`" and lists
    `<title>`, which the consumer's `TEXT` set does not contain.
    *Recommendation:* amend the spec to "text and placeholders", decide whether
    quotes stay significant in `textarea`, honour `\` escapes in a
    text-body string, and settle `title`.
14. **Atoms outside the three ruled positions.** *Settled*: decision 156,
    addendum 2 (every `${}`; "script blocks" are statement blocks), decision
    163 (ruling C11 and addendum 1: attribute arguments and method parameters,
    method bodies, and never the tag variable, tag parameters or type lists)
    and the lead ruling of 2026-10-05 on method bodies. The positions are in
    [Atoms](#atoms).
15. **Spec §4 "Consumers on a stock parser"** and divergence row "The parser
    after-value rule" describe the stock-parser diagnostic of decision 151,
    ruling 1. Decision 157 addendum 3 removed it, 158.2 kept it for the
    interim, and decision 159 makes core bundle the in-repo template parser,
    so a published core no longer reaches it. *Recommendation:* the paragraphs
    lapse now (decision 159), not at the drop of `@marko/compiler`; keep only
    the sentence for a caller that bypasses the bundle, as spec §4 "Atoms"
    already does.
16. **A tag name's first character.** The parser accepts any character that is
    not a terminator, a leading digit included. *Recommendation:* state the
    terminator rule in the spec, or add a rule and a diagnostic.
17. **The operator exemption.** A hard stop written directly after an operator
    is consumed (`x=a + ,b` is one value; `x=a +/>` is a regular-expression
    error). Valid TypeScript is affected, because the look-behind table counts
    a legal identifier spelled like a unary keyword and a non-type `>`:
    `<div x=async/>` is the value `async/`, `<div x=async, y=1/>` the value
    `async,`, concise `div x=async\n  span` swallows the child, and
    `div x=f<T> ,y=1` (a trailing instantiation expression) is one value.
    *Recommendation:* make the stop unconditional and let the expression parser
    report `a +`.
18. **Newline continuation.** In concise mode a value continues past a newline
    only in the cases E2 lists. Two of them reach a line that spec §3 "Concise
    mode" would call a child or a sibling: a keyword operator or a lone `.` at
    the end of the line draws in the next line at any indentation
    (`div x=a instanceof\nB` swallows a column-0 line), and so does a trailing
    look-behind operator (`div x=a +\nspan`). In HTML mode the look-ahead
    crosses newlines, which yields values such as `a\n  <span`.
    *Recommendation:* keep the concise rule, and rule whether a continuation may
    reach a line at column 0, and whether HTML mode keeps the look-ahead across
    a newline.
19. **End of input with an open delimiter, in concise mode.** `div x=(a` is an
    error; `div(a`, `$ {a`, `div|a`, `div<A`, `div (a`, `div onClick(a) {b` and,
    under a concise text tag, `script -- ${b` end silently, because the
    delimiter is not on the position's group stack. Three lose an event
    entirely: `div.a${b` (no shorthand event), `${x` (no event at all) and a
    template literal's `${` in a concise value (``span\n  div x=`${a``: no value
    event). *Recommendation:* an error in all of them.
20. **`::` followed by whitespace.** *Settled* by decision 156, addendum 2
    ("`::` is the reserved token in every position MX lexes"): on main
    `x=a :: b` is the reserved-token error ([Atoms](#atoms)).
21. **Agreement with the AST catalogue.** *Settled* by decision 163, ruling
    Q10: field names follow the AST; a container's span is the parser's `value`
    range and `outer` its event range. This document adopts both
    ([Ranges](#ranges-and-the-names-the-ast-catalogue-gives-them)).
22. **The 2026-10-05 boundary ruling has no decision number**, so nothing
    outside this document can cite it and `divergences.md` has no row for it.
    *Recommendation:* number it in the entry that fixes the boundary mechanism
    (OQ 1).
23. **`x=a !b` and `x=a ++b`.** The default reads each as one value, which is
    not a TypeScript expression; TypeScript reads `a!` and `a++` and stops. No
    spec text covers either. *Recommendation:* let the boundary end the value
    after `a!` and `a++`, which turns a later compile error into `x` plus a
    boolean attribute `b`; confirm that this is wanted.
24. **Valid TypeScript that the default rejects or cuts**, beyond OQ 7: concise
    `div x=a as T > b` (`Mismatched group`); an arrow type at the top level of a
    type list (`<foo<() => void>>`, `onClick<T extends () => void>(a) {}`); a
    block comment after an operator (`x=a + /* c */ b` ends at the comment); a
    space between a trailing operator and the newline in a scriptlet or
    statement (`$ a = 1 + ⏎`); `... [a]` and `... "s"`; `<div x=/* c */ a/>`, a block comment at the
    value's start, is the value `/* c */` and then an attribute `a`; and the
    exemption cases of OQ 17. One oddity on the other
    side: a `,` line after a statement tag adds attributes to it.
    *Recommendation:* treat each as a defect for the TypeScript-aware boundary
    to remove; none is covered by spec text.
25. **`div` in close-tag matching.** `<.a></div>` is accepted because the parser
    compares against the literal `div` for an unnamed tag, whatever `defaultTag`
    resolves to (decision 145). The htmljs fixture `shorthand-closing-html2` pins it.
    *Recommendation:* accept only `</>` for an
    unnamed tag, or compare against the resolved name in core.
26. **A close tag in a concise region.** Spec §3 "Concise mode" says closing
    tags are a parse error there; the parser reports one only when no tag is
    open or the name differs, and `div\n  </div>` closes the concise `div`.
    *Recommendation:* make it an error, as the spec says.
27. **The character after a `--` run.** It is skipped unexamined (`--abc` is the
    text `bc`). *Recommendation:* require whitespace or the end of the line
    after the hyphens.
28. **Decision 146, divergence 3 and the `:` condition.** *Settled* by decision
    146, addendum 6: "a `:` starts a new attribute only when it is followed by
    an identifier start, or is bare before `>`, `/>`, a newline or the end of
    input", amending the divergence row's wording. `x=(a) : T => a` stays one
    value ([E1](#e1--attribute-value-html-mode)).
29. **`await :name`.** *Settled* by decision 156, addendum 8: addendum 3's rule
    restated by addendum 2's principle, "a `:` TypeScript could own is
    TypeScript's" ([Atoms](#atoms), operator words, rule 5).
30. **Statement tags and their "attributes".** Spec §2 "Syntax" says `import`,
    `static` and `export` parse as tags whose "attributes are the remaining
    words". With the statement set supplied, the parser reports no attributes
    for them ([E10](#e10--statement-tags)); only without the set (five hosts
    today) are the words attributes. *Recommendation:* correct spec §2 when MX1
    TODO `statement-tags-not-declared-on-five-hosts` lands.
31. **A template literal's `${}` in a text body.** Decision 156, addendum 2
    makes "every `${}` placeholder" an atom position, `<script>` bodies
    included. A template literal inside a text body is text to the parser, so
    its `${…}` is no placeholder and lexes no atom
    (``<script>`${:a}`</script>``). *Recommendation:* confirm that addendum 2
    means placeholders only.
32. **Non-ASCII identifiers before an atom.** *Settled* by decision 156,
    addendum 9: the atom look-behind treats as a word character any character
    at or above U+0080 that is not Unicode whitespace or a line terminator
    (U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF). Today's code is the defect MX1 TODO `atom-lookbehind-non-ascii`
    ([Atoms](#atoms), rows 9 to 11).

### Where a real TypeScript parser would end the value differently

Each row is an observed input. "Default" is main's result. The class is assigned from the spec text and
decision 146 under the 2026-10-05 ruling:

- **(a)** the spec's rule applies and its outcome turns on a fact only
  TypeScript's grammar supplies; a TypeScript-aware boundary **may** make the
  case exact;
- **(b)** the spec's rule, in text that exists, decides the input; that result
  stands and the boundary **must not** change it;
- **(c)** the spec is silent; the default stands under decision 157.3 until
  mx-lead rules. The last column notes whether TypeScript's reading would
  accept anything the spec rejects.

| Input | Default | TypeScript | Class | Basis |
| --- | --- | --- | --- | --- |
| `x=a.b .c`, `x=fn(a) .b` | split before `.c` / `.b` | member access, one expression | **(b)** | divergence row "The parser after-value rule" names both spellings |
| `x=(a) :T => a` | split before `:T`, then `Missing value for attribute` | an arrow function with a return type | **(b)** | the same row names this input; decision 151, ruling 3 |
| `<if=a .b>`, `<const/x=items\n .filter()/>` | one value | one expression | **(b)**, no difference | the same row: the default attribute is exempt |
| `x=a ?? b :c`, `x=a ?.b :c` | split before `:c` | `??` and `?.` are not ternaries; the expression ends before `:c` | **(a)** | the rule says "`:` … with no open `?`"; whether `??` or `?.` opens one is a fact of TypeScript's grammar. OQ 3 |
| `x=a ? :b :c` | one value, with the atom `b` | `a ? :b : c` is no TypeScript; with atoms read as values it is one expression | **(b)**, no difference | spec §4 "Atoms": "an atom's own `:` is never the ternary's, so `a ? :b :c` is `a ? "b" : c`"; divergence row "`a ? :b :c` is one value" |
| concise `div x=a\n  .b` | value `a`, then an unnamed child tag with class `b` | member access across the newline | **(b)** | divergence row "The parser after-value rule": `.` followed by an identifier after whitespace starts a new attribute, "and across a newline" |
| concise `div x=a\n  (b)`, `\n  + b`, `\n  ? b : c`, `\n  in b`, `\n  <span/>` | value `a`, then a child | continues across the newline | **(c)** | spec §3 "Concise mode" says a concise tag's "children are the lines indented under it" but says nothing about attribute values, and the default itself continues a value onto such lines in other cases (`div x=a +\n  b`, `div x=a in\n  b`). Whether §3 governs value continuation is OQ 18 |
| `<div x=async/>`, `<div x=async, y=1/>`, concise `div x=async\n  span` | `async/`, then a missing close tag; `async,` then `y=1`; one value swallowing the child | the identifier `async`, then stops | **(c)** | spec silent. OQ 17 |
| concise `div x=f<T> ,y=1` | one value | an instantiation expression `f<T>`, then stops | **(c)** | spec silent. OQ 17 |
| `<div x=/* c */ a/>` | value `/* c */`, then an attribute `a` | the expression `a` after a comment | **(c)** | spec silent. OQ 24 |
| `x=a [0]` | value `a`, then an attribute named `[0]` | `a[0]` | **(c)** | spec silent. In concise mode `[` begins an attribute group, so continuing would change `div x=a [y=1]` |
| `` x=a `t` `` | value `a`, then an attribute named `` `t` `` | a tagged template, `` a`t` `` | **(c)** | spec silent; accepts nothing the spec rejects |
| `x=a {b}` | one value | stops after `a` | **(c)** | spec silent |
| `x=a: b` | one value | stops after `a`; `: b` is not part of an expression | **(c)** | spec silent: the after-value rule needs whitespace before the `:` |
| `x=a !b`, `x=a ++b` | one value | `a!`, `a++`, then stops | **(c)** | spec silent. OQ 23 |
| `x=f<T>(y)`, `x=<T,>(a) => a` | cut at the `>` | a generic call; a generic arrow | **(c)** | spec silent; accepts nothing the spec rejects. Recorded defect. OQ 7 |
| `x=a as T = b`, `x=a as T < b`, `x=a as T {k: T}` | one value | the type ends at `T` | **(c)** | spec silent |
| concise `div x=a as T > b` | `Mismatched group` | a comparison | **(c)** | spec silent. OQ 24 |
| `x=a + /* c */ b` | value `a + /* c */`, then an attribute `b` | one expression | **(c)** | spec silent. OQ 24 |
| `<div x=a\n  <span/>` (HTML) | the single value `a\n  <span` | `a < span`, then stops at `/` | **(c)** | spec silent on newlines inside an HTML-mode value. OQ 18 |
| `<div ... [a]/>`, `<div ... "s"/>` | `Missing value for attribute` | a spread of `[a]`, of `"s"` | **(c)** | spec silent. OQ 24 |
| `<let/foo : string/>` | the variable `foo : string` | as a pattern with a type annotation, the same; as an expression, stops after `foo` | **(c)** | spec silent on how the boundary reads a tag variable; it must be read as a binding pattern for the two to agree |
| `<foo\|x: A \| B\|/>` | parameters end at the first `\|` | a union type | **(c)** | spec silent. OQ 6 |
| `<foo<() => void>/>` | type arguments `() =` | a function type | **(c)** | spec silent. OQ 24 |

### Recorded defects in the default

These behaviours above are defects, not grammar, and are to be fixed in
`packages/parser/src/template/`:

- a generic call or generic arrow in an HTML-mode value is cut at `>` with no
  error (`x=f<T>(y)`, `x=<T,>(a) => a`);
- end of input in concise mode inside a position whose delimiter was consumed
  by the owning state raises no error (`div(a`, `$ {a`, `div|a`, `div<A`,
  `div (a`, `div onClick(a) {b`, `script -- ${b`);
- end of input in concise mode inside a tag name's or shorthand's `${…}`, or
  a template literal's `${…}`, raises no error **and drops the owning event**
  (`div.a${b` reports no shorthand, `${x` reports nothing, ``div x=`${a``
  reports no value);
- the atom look-behind counts ASCII word characters only (`x=({ é:a })`,
  `x=(é :b)` and `x=(éin :b)` lex an atom), MX1 TODO
  `atom-lookbehind-non-ascii`;
- the name in the `::` reserved-name error is read past the static piece
  (`<a::b${x}/>` reports `::b$` at 2–6, `<div.a::${x}/>` `::$` at 6–9);
- the third dot of a spread counts as a member dot in the atom look-behind,
  so `x=[...await :b]` and `x=[...new :a]` lex no atom, against decision 156,
  addendum 8.

The behaviours listed in OQ 13 (no `\` escape in a text-body string), OQ 17,
OQ 24, OQ 25 and OQ 27 look like defects as well and are not filed. An implementer **must not** treat any of them as intended
grammar; each is described here only so that a difference from the default is a
decision and not an accident.

## Conformance

The htmljs fixtures cited below are upstream's 418 fixture directories, kept
byte-identical in `packages/parser/src/template/__tests__/fixtures/` (one
directory per case with an `input.marko` and a snapshot) and run by
`upstream-suite.test.ts`. They are **evidence of the default behaviour, not a
gate**. MX's own tests of the template parser sit beside them:
`mx-after-value.test.ts` (the after-value rule, re-pointed from
`patches/htmljs-parser.test.ts`, with the same `CHANGED`, `PINNED`,
`DEFAULT_ATTRIBUTE` and `statement tags` blocks), `mx-atoms.test.ts` over the
case table `mx-atoms.cases.ts`, `__tests__/base-offset.test.ts`, and
`corpus-equivalence.test.ts`, which pins identical event streams between this
source and the patched npm build.

| Section | Exercised by |
| --- | --- |
| Tag names, shorthands, the `:` split | `packages/core/src/name-sugar.test.ts`; htmljs fixtures `tag-name-*`, `shorthand-*` |
| Close tags | htmljs fixtures `empty-closing-tag*`, `shorthand-closing-html*` (`shorthand-closing-html2` is `<#foo>` closed by `</div>`) |
| Sugars and the after-value rule, addendum 5 | `packages/parser/src/template/mx-after-value.test.ts`; `patches/htmljs-parser.test.ts` (`CHANGED`, `PINNED`, `DEFAULT_ATTRIBUTE`); `packages/core/src/name-sugar.test.ts`; `packages/core/src/stock-parser.test.ts`; `packages/targets/html/src/stock-parser.test.ts` |
| Attributes, names, `=` spacing | htmljs fixtures `whitespace-around-equals`, `attr-comma-multiline*`; `packages/targets/html/fixtures-marko/attr-value-modifier` |
| E1–E3 values and spreads | `patches/htmljs-parser.test.ts`; htmljs fixtures `ts-generic-*`, `attr-ambiguous-right-angle-bracket*`, `attr-eof-spread` |
| E4, E5, E16, E17 methods | htmljs fixtures `attr-method-*`, `argument-attr-extra-whitespace`, `invalid-attr-type-params`, `invalid-type-params-attr-arg` |
| E6, E7, E14, E15 | htmljs fixtures `argument-tag-extra-whitespace`, `tag-with-type-arguments`, `tag-params-with-type-parameters`, `invalid-*type*`; `fixtures/render-props/input.solid.mx` (tag parameters) |
| E8, E13 | htmljs fixtures `placeholder-within-script-tag`, `tag-name-expression-*`, `tag-name-placeholder-*`, `shorthand-*-dynamic*`; `fixtures/counter/input.solid.mx` (a placeholder and a method) |
| E9 tag variables | htmljs fixtures `tag-var-*`; `patches/htmljs-parser.test.ts` (`DEFAULT_ATTRIBUTE`) |
| E10 statement tags | `patches/htmljs-parser.test.ts` (`statement tags`); htmljs fixtures `statement-concise-only`, `statement-root-only` |
| E11 scriptlets | htmljs fixtures `scriptlet-*` |
| E12 delimited blocks | htmljs fixtures `double-hyphen-*`, `multiline-html-block*`, `single-line-text-block*`, `concise-contentplaceholder-start` |
| Concise mode, mixed mode | `apps/docs/example/home-example.mx`; `packages/tooling/tsc/src/fixtures/host-dispatch/data-check/violation.mx`; htmljs fixtures `semicolon-concise`, `mixed-*`, `open-tag-comments*` |
| Whitespace (consumer level) | `test-fixtures/body-whitespace/cases.json` |
| Text, comments, doctype | `packages/targets/html/fixtures-marko/{doctype-page,comments-and-html-comment,html-comment-placeholder,elements-text,piped-text}`; htmljs fixture `dtd` |
| Attribute tags | `packages/targets/html/fixtures-marko/attribute-tags*` |
| End of input | htmljs fixtures `eof-*`, `attr-eof-*`, `tag-name-placeholder-eof`, including `eof-attr-value-js-comment-comment-concise` and `eof-placeholder-concise` for concise mode |
| Atoms, the reserved `::` | `packages/parser/src/template/mx-atoms.cases.ts` (run by `mx-atoms.test.ts` and by `patches/htmljs-parser.test.ts` against both npm builds); `packages/core/src/atoms.test.ts` |
| Base position | `packages/parser/src/template/__tests__/base-offset.test.ts` |
| E2 continuation onto a later line | htmljs fixtures `attr-operators-newline-after` (unary keywords and a lone `.` at the end of a line, operand at column 0) and `attr-operators-newline-before` |

### Rules no existing test covers

For each rule below, a search of the htmljs fixtures' `input.marko` files,
`mx-after-value.test.ts`, `mx-atoms.cases.ts`, `base-offset.test.ts` and
`patches/htmljs-parser.test.ts` for the rule's characteristic input found
nothing:

- concise `as T >` (the `Mismatched group` case of the type context);
- an operator followed by a block comment and an operand (`a + /* c */ b`);
- a spread whose expression starts after whitespace with `[` (`... [a]`);
- an arrow at the top level of a type list (the fixture
  `tag-type-argument-arrow-function` has its arrow inside `{ … }`);
- a union type inside tag parameters or a tag variable;
- a trailing operator followed by whitespace before the newline, in a scriptlet
  or statement;
- hyphens followed directly by a non-space character (`--abc`);
- a binary keyword (`in`, `as`, `instanceof`, `satisfies`, `extends`) at the end
  of a concise value's line;
- `async` before a hard stop (`x=async/>`), and a block comment at a value's
  start (`x=/* c */ a`).

Not searched, and therefore not claimed either way: the concise newline cases
of E2 as a set, and close tags inside a concise region.

The operator exemption (`x=a + ,b`) should stay unpinned until OQ 17 is
ruled.

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
  addenda 2 and 4 on that point). `@marko/compiler` stays an npm dependency,
  with the current htmljs patch, only until the MX AST and the ported lowering
  land. Until then "decision 151 §1 stands" (158.2): the stock-parser
  diagnostic of decision 151, ruling 1, which 157 addendum 3 had removed, is
  live again for the interim.
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

Three changes are described here as they **will be**, not as the parser is
today. Each is marked *planned* where it appears:

- decision 146, addendum 4: a sugar immediately followed by `=value` or
  `(params) { body }` sets the tag's default attribute;
- decision 146, addendum 5: a default value that is a single atom does not block
  the name sugar after it;
- atoms (decision 156 and its addendum 1): `:name` lexed in expression position,
  `::` reserved.

### Method: every behavioural rule is read out of the parser source

Every statement below about what the parser does today is derived from the
source of `htmljs-parser` 5.18.0 at `/Users/svallory/work/htmljs-parser/src`
(read-only) and names the file and symbol it comes from. Where a rule has more
than one branch, it is written as a table or an ordered list **in the code's own
branch order**, so that every branch of the cited symbol is either a row or
explicitly excluded.

The same source is in this repository on `main` at
`packages/parser/src/template/` (PR #336; compared for this revision at
`origin/main` `0cd544d84`): the files cited here are byte-identical to
upstream, except `states/ATTRIBUTE.ts` and `states/EXPRESSION.ts`, which carry
the MX patch as ordinary source. This branch does not contain that path.
Citations are therefore **by file and symbol**, and the symbols exist under the
same names on `main`. Line numbers, where given, refer **only** to the pinned
upstream files; they do not hold on `main`, where the two patched files are
longer.

"The patch" means `patches/htmljs-parser@5.18.0.patch`, which is the same change
as the source difference on `main`: the `attrValue` flag set in
`ATTRIBUTE.parse`, the `??`/`?.` branch in `EXPRESSION.parse`, and the `:` and
`.` branches of `lookAheadForOperator` with the helpers `isIdentStartCode` and
`isBareColonEnd`.

Every rule was then attacked by probe: inputs chosen to exercise each branch,
including inputs the wording might be read to exclude, run through the
**patched** 5.18.0 build in this repo's `node_modules` and through the **stock**
source with the same callbacks (`onOpenTagName` returning `TagType.statement`
for `static`/`import`/`export`/`server`/`client`, `TagType.text` for
`script`/`style`/`textarea`, `TagType.void` for `input`/`br`). "Observed" below
means the output of those runs. **Stock and patched agree on every observed
input unless the text says they differ**, and they differ only where the patch's
after-value rule applies ([E1 overrides](#e1--attribute-value-html-mode)).

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
- Where the spec says nothing, the ruling does not decide. The stock default
  stands under decision 157.3 until mx-lead rules, and the case is listed as not
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
- **Soft stop.** Whitespace or a newline, in a position that has the
  `terminatedByWhitespace` or `terminatedByEOL` flag. At depth 0 it ends the
  value only when the continuation test fails.
- **Whitespace** is any character with code 32 or lower, which includes tab,
  newline and carriage return (`isWhitespaceCode`, `util/util.ts`). **Indent
  characters** are space and tab only (`isIndentCode`). A **word character** is
  `A`–`Z`, `a`–`z`, `0`–`9`, `$` or `_` (`isWordCode`); no non-ASCII character is
  one.
- **The default** is what the stock parser's source does, as confirmed by
  probe. Decision 157.3 makes it the normative answer wherever MX has no ruling.

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
| 4 | `-` | concise | if the next character is not `-`: `"-" not allowed as first character of attribute name`. Inside `[ … ]`: `Attribute group was not properly ended`. Otherwise the open tag ends and a delimited block begins ([E12](#e12--delimited-html-blocks)) |
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

So `:` alone is a name character, and only `:=` ends a name: `<a:b=1/>` is the
tag `a:b` with a default value, `<div:=x/>` is the tag `div` with a bound
default value (both observed; decision 146: "tag-adjacent `:` is a tag-name
character"). `>` is a name character in concise mode (`div>a` is one tag name,
observed). The loop has no leading-character rule: `<1abc/>` is the tag `1abc`
(observed), and no source of truth states one (OQ 16).

Four name forms result:

| Form | Example | Grammar |
| --- | --- | --- |
| Static | `div`, `my-widget` | a run of row-5 characters |
| Interpolated | `<${expr}>`, `<${foo}-bar>`, `<${a}${b}>` | any mix of row-5 characters and `${…}` |
| Unnamed | `<.card>`, `<#main>` | the name part is empty and a shorthand follows; the name event has an **empty** range (decision 145) |
| Statement tag | `static`, `import`, … | a name for which the consumer returns `TagType.statement` ([E10](#e10--statement-tags)) |

The empty name range is the parser's signal that the tag is unnamed; core
resolves it through the `defaultTag` ladder ([dialect rule 9](#dialect-rules)).
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

A shorthand part is read by the tag-name loop above, so it ends on exactly the
row-3 characters and on the next `.` or `#`. A part may contain `${…}`
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
  mode: `div x =1` is `x` with the value `1`.
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
| name | reported, unless it is a pending `async` (below). In HTML mode the ambiguous-`>` check runs ([below](#the-ambiguous--check)) |
| arguments | if `{` follows, after any whitespace **including newlines in both modes**, the attribute is a method and the arguments are its parameters. Otherwise, if type parameters were read: `An attribute cannot have both type parameters and arguments`. Otherwise the arguments are reported as attribute arguments |
| method body | the method is reported; the attribute ends |
| type parameters | `(` **must** follow, after any whitespace; otherwise `Attribute cannot contain type parameters unless it is a shorthand method` |
| value | an empty value is `Missing value for attribute`. In HTML mode the ambiguous-`>` check runs. The value (or spread) is reported; the attribute ends |

**`async` methods** (`isAsyncMethodPrefix`, `flushPendingAsync`). A name that is
exactly `async`, read first in its attribute, is held back when the next
character after whitespace (spaces and tabs only in concise mode) is a word
character, `(`, or `<` not followed by `/`. If the attribute then turns out to
be a method, `async` is its modifier and only the method name is reported:
`<div async onClick(a) {x}/>` is the method `onClick`. In every other case it is
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
[Status](#status-sources-of-truth-and-method) for the modifier split.

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
concise content, in an open tag, or inside an expression.

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
statement tag when the consumer's `onOpenTagName` returns `TagType.statement`
(`TAG_NAME.exit`); the parser has no list of its own. In this repository the
consumer's set is `class`, `client`, `export`, `import`, `server`, `static`
(`STATEMENT` in `packages/core/src/close-tag-opener.ts`, which its comment says
reproduces Marko 6.3.51's core taglib parse options). Spec §2 "Syntax" names
`import`, `static` and `export`, and spec §2 "`server` and `client` blocks"
names the other two; no spec section names `class`.

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
| 6 | `"` or `'` | a string to the same quote, within which placeholders are recognised; unterminated is `EOF reached while parsing string expression` |
| 7 | `${`, `$!{`, or backslashes before one | a placeholder or escaped placeholder |
| 8 | anything else | text |

So a text body is text **and placeholders**, and a quote in it must be balanced:
`<script>a ${x} <b></script>` gives the placeholder `x` and the text ` <b>`;
`<textarea>don't</textarea>` is the string EOF error (both observed). Spec §3
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

Rules of the open tag that are specific to concise mode are rows 1, 3, 4, 5, 6
and 12 of [The open tag](#the-open-tag). The rule for a value that reaches the
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
(`handleDelimitedBlockEOL`).

The whitespace rules of spec §3 "Whitespace" (boundary trimming, dropping a
whitespace-only run that begins with a newline, collapsing runs to one space,
ignoring comments, the `preserveWhitespace` bypass) are applied by the consumer
of the parser's events. Today that is `@marko/compiler`'s `onText`, which the
spec calls "Marko's parser". When `@marko/compiler` is dropped (decision 158.2),
the MX layer that takes its place **must** apply them exactly once; decision
158.3 puts the front end from parser events to the MX AST in `@mxlang/parser`,
and no decision says more. Core and hosts **must not** re-normalize (spec §3
"Whitespace").

## Error conditions

Every diagnostic is a positioned error. The template parser's own messages, each
observed unless a symbol is cited instead:

| Condition | Message |
| --- | --- |
| `=`, `:=` or `...` with no value | `Missing value for attribute` |
| empty `${}` in content, in a tag name or in a template literal | `Invalid placeholder, the expression cannot be missing` |
| end of input in an attribute name, or in a default attribute's value or arguments | `EOF reached while parsing attribute name for the "<tag>" tag` |
| end of input in a named attribute's value, arguments, type parameters or method body | `EOF reached while parsing attribute value for the "<name>" attribute` |
| end of input in a spread | `EOF reached while parsing attribute value for the ... attribute` |
| end of input after an attribute name and whitespace, HTML mode | `EOF reached while parsing attribute "<name>" for the "<tag>" tag` |
| end of input in a tag name's `${…}` | `EOF reached while parsing tag name` |
| end of input in a placeholder | `EOF reached while parsing placeholder` |
| end of input in any other position | `EOF reached while parsing expression` |
| end of input in a string | `EOF reached while parsing string expression` |
| end of input in a template literal | `EOF reached while parsing template string expression` |
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
sugar", "Left alone"); duplicate attributes, which are a warning with the last
occurrence winning (decision 135); `::name` (decision 156.5, planned).

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

The position also tracks: the group stack (depth); `ternaryDepth`; `inType` and
`forceType` as they change; and `wasComment`, set when a `//` comment has just
been read and cleared only when a newline is passed.

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
   | backtick | a template literal, to the closing backtick; `\` escapes one character; each `${` opens a nested position with no flags and the hard stop `}` |
   | `?` | with `operators` at depth 0: `ternaryDepth` + 1, then **all whitespace after it is consumed, newlines included**. Otherwise a plain character. The patch adds an earlier case, see [E1 overrides](#e1--attribute-value-html-mode) |
   | `:` | with `operators` at depth 0: if `ternaryDepth` > 0 it is decremented, otherwise the type context is entered (`inType`); then all whitespace after it is consumed. Otherwise a plain character |
   | `=` | with `operators`, at any depth: if the next character is `>` (an arrow), the type context is left when `inType` is set, `forceType` is not, and the previous non-whitespace character is not `)`; both characters are consumed. If the next character is not `>`, the type context is left unless `forceType` is set or a group is open. Then all whitespace after it is consumed. Without `operators` a plain character |
   | `/` | `//` is a comment to the end of the line; `/*` is a comment to `*/`. Otherwise it is a **division** when the previous non-whitespace character is a word character or one of backtick, `'`, `"`, `%`, `)`, `.`, `<`, `]`, `}`: it is consumed with all whitespace after it. Otherwise it starts a **regular expression**, which runs to the next `/` that is not escaped and not inside `[…]`. This row does not depend on `operators` or on depth |
   | `(`, `[` | opens a group |
   | `{` | opens a group. Before that, when `inType` is set and `forceType` is not, the type context is left unless the previous non-whitespace character is an operator by the look-behind table |
   | `<` | in a type context: opens a group that closes with `>`. Otherwise, with `operators` at depth 0, it is consumed with all whitespace after it. Otherwise a plain character |
   | `>` | a plain character when the position is not in a type context, or when the previous character is `=`. Otherwise it is a closing bracket |
   | `)`, `]`, `}`, and `>` as a closing bracket | closes the innermost group. With no open group, or when the innermost group expects a different closer, the error `Mismatched group. …` |
   | any other | consumed |

Source: `EXPRESSION.parse`, upstream `EXPRESSION.ts:94-334`; `canFollowDivision`
for the division test.

Four properties of the scan matter in every position:

- **A type context exists only where `operators` is on or the position starts
  in one.** In a position with no flags, `?`, `:`, `=`, `<` and `>` are plain
  characters, so only `(`, `[`, `{`, strings, template literals, regular
  expressions and comments shield its hard stop.
- **Inside a group nothing ends the value.** Steps 1, 3 and 4 require depth 0.
  Inside a group, `?` and `:` are plain characters, so a ternary inside a group
  does not touch `ternaryDepth`, and an `as` or `:` inside a group never enters
  the type context (`<div x=(a as number > b)/>` is one value, observed).
- **`?`, `:`, `=`, a non-type `<` and a division `/` consume the whitespace
  after them themselves**, newlines included, in every mode. After one of them
  the scan never reaches step 1 or step 3 for that whitespace.
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
| a lowercase letter | yes when a unary keyword ends at `c` as a whole word. Outside a type context the keywords are `async` `await` `class` `function` `new` `typeof` `delete` `void`; inside one they are `async` `await` `class` `function` `new` `typeof` `asserts` `infer` `is` `keyof` `readonly` `unique`. "Whole word" means the keyword starts at the first character of the value, or the character before it is neither a word character nor `.` |
| anything else | no |

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

The patch changes the `:` and `.` rows for a named or spread attribute's value;
see [E1 overrides](#e1--attribute-value-html-mode). `[`, a backtick, a quote
and a word character are in neither row, so they never continue a value across
whitespace.

Source: `checkForOperators`, `lookBehindForOperator`, `lookAheadForOperator`,
`lookBehindForKeyword`, and the keyword tables at the top of upstream
`EXPRESSION.ts` (`:35-67`).

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

`EXPRESSION.parse`, after its loop (upstream `EXPRESSION.ts:336-389`):

1. If depth is 0 and either the parser is in concise mode or the position has
   `terminatedByEOL`, the value ends silently at end of input.
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

`div(a` and `$ {a` end silently although a delimiter is open, because the `(`
and `{` were consumed by the owning state (`OPEN_TAG.parse`,
`INLINE_SCRIPT.parse`) and are not on the position's group stack, while the `(`
of `div x=(a` is. Both are **recorded defects**
([below](#recorded-defects-in-the-default); OQ 19).

### Inventory of positions

Every `enterState(STATE.EXPRESSION)` call in the parser's source, with the flags
and hard stop it sets. There are sixteen calls; fifteen are positions.

| Call site | Flags | Hard stop | Position |
| --- | --- | --- | --- |
| `ATTRIBUTE.parse`, value branch | `operators`, `terminatedByWhitespace` | per mode, see E1/E2 | E1, E2, E3 |
| `ATTRIBUTE.parse`, name branch | `terminatedByWhitespace` | per mode | [attribute name](#attribute-names) |
| `ATTRIBUTE.parse`, `(` branch | none | `)` | E4 |
| `ATTRIBUTE.parse`, `{` branch | none | `}` | E5, and the body of E17 |
| `ATTRIBUTE.parse`, `<` branch | `inType`, `forceType` | `>` | E16 |
| `OPEN_TAG.parse`, `/` case | `operators`, `terminatedByWhitespace` | per mode | E9 |
| `OPEN_TAG.parse`, `(` case | none | `)` | E6, and the parameters of E17 |
| `OPEN_TAG.parse`, `\|` case | none | `\|` | E7 |
| `OPEN_TAG.parse`, `<` case | `inType`, `forceType` | `>` | E14, E15 |
| `TAG_NAME.parse`, `${` branch | none | `}` | E13 |
| `TAG_NAME.exit`, statement branch (`prepareStatement`) | `operators`, `terminatedByEOL`, `consumeIndentedContent`; `inType` and `forceType` after a type keyword | none | E10 |
| `INLINE_SCRIPT.parse`, line form (`prepareScriptlet`) | `operators`, `terminatedByEOL`; `inType` and `forceType` after a type keyword | none | E11, line form |
| `INLINE_SCRIPT.parse`, block form | none | `}` | E11, block form |
| `checkForPlaceholder` (`PLACEHOLDER.ts`) | none | `}` | E8 |
| `TEMPLATE_STRING.parse`, `${` case | none | `}` | a template literal's `${…}`, inside any position |
| `util/validators.ts` | — | — | **excluded**: a validation helper for callers of the parser's API, not a place in a template |

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
  instead. No valid TypeScript puts an operator there, and the results are not
  consistent: `<div x=a + ,b/>` is the single value `a + ,b`, while
  `<div x=a +/>` and `<div x=a ? />` are `EOF reached while parsing regular
  expression` (all observed; OQ 17).

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
- **Overrides (the patch).** These apply when the attribute whose value is being
  read **has a name or is a spread** (`attrValue`, set in `ATTRIBUTE.parse`).
  They are the after-value rule of divergence row "The parser after-value rule"
  (decision 146, divergence 3).

  | Where | Stock | Patched |
  | --- | --- | --- |
  | look-ahead, `n` = `:` | operator | **not** an operator when `ternaryDepth` is 0 and the character after the `:` is `A`–`Z`, `a`–`z`, `$` or `_`, or is `>`, `/>`, a newline or end of input |
  | look-ahead, `n` = `.` | operator when a word character follows (after whitespace) | **not** an operator when the character directly after the `.` is `A`–`Z`, `a`–`z`, `$` or `_`; otherwise as stock |
  | character table, `?` with `operators` at depth 0 | opens a ternary | when the next character is `?`, or is `.` not followed by a digit, both characters are consumed and no ternary opens |

  Because the first two rows are look-ahead rows, the split happens only when
  the continuation test reaches its step 7: there is whitespace before the `:`
  or `.`, and the character before that whitespace is **not** a look-behind
  operator. Observed, patched: `x=a :b` is the value `a` and an attribute named
  `:b`; `x=a.b .c` is the value `a.b` and an attribute named `.c`; `x=a | :b` is
  one value; `x=a ? b :c` is one value and `x=a ? b : c :d` splits at `:d`;
  `x=a :` before `/>` or `>` is the value `a` and an attribute named `:`;
  `x=a : b` is one value (a space follows the colon); `x=a . b` and `x=a .2xl`
  are one value; `x=a ?? b :c` and `x=a ?.b :c` split at `:c`. In HTML mode the
  split also happens across a newline (`<div x=a\n  .b/>`). On the stock parser
  each of these is one value, except `x=a :` before `/>` (the regular-expression
  EOF error) and before `>` (`Mismatched group`).

  Three parts of the patch have no spec text of their own and are **not
  settled**: the `??`/`?.` case, including that `?:` is not excepted (`x=a ?:b`
  is one value on both parsers) (OQ 3); the digit exclusion (OQ 4); and spreads
  (OQ 5).
- **Default attribute.** A value with no name has `attrValue` off, so none of
  the patch applies: `<if=a .b>` and `<if=a :b>` are one value (observed;
  decision 151, ruling 2; divergence row "The parser after-value rule"). Core
  then reports `:name` after a default value as an error (spec §4 "Name sugar",
  "Left alone").
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
  only the look-behind is tried, and at whitespace the look-ahead does not look
  past the end of the line. So **a value continues onto the next line in
  exactly these cases**:

  | Case | Mechanism |
  | --- | --- |
  | a group is open | step 1.1 of the scan |
  | the character immediately before the newline is a look-behind operator, and no `//` comment precedes the newline | step 1.3 |
  | whitespace before the newline follows a look-behind operator | step 3 of the scan: the continuation test consumes that whitespace and the newline together |
  | the newline is in the whitespace after `?`, `:`, `=`, a non-type `<` or a division `/` | the character table consumes it |
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
  | `div x=a\n  ,y=b` | value `a`; the open tag continues with `y=b` |
  | `div x=a + // c\n  b` | value `a + // c`; child tag `b` |
  | `div [x=a\n  .b]` | value `a`; attribute `.b` |
  | `div [x=a +\n  b]` | one value |

  A TypeScript parser continues across the newline where the next line begins
  with `<`, `.`, `(`, a binary operator, `?` or `in` (OQ 18).
- **End of input:** ends the value silently at depth 0; an error with a group
  open ([End of input](#end-of-input)).
- **Overrides and default attribute:** as E1. Observed, patched: `div x=a :b`
  is the value `a` and an attribute named `:b`; `div x=a :` at the end of the
  line is the value `a` and an attribute named `:`.

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
- **Overrides:** the patch applies to a spread as to a named attribute:
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
- **Overrides:** none. The patch does not apply (`attrValue` belongs to the
  value position).
- **Atoms:** no ruling (OQ 14).

### E5 — Attribute method body

`onClick(a) { … }`:

- **Start:** the character immediately after `{`.
- **Stops:** the `}` at depth 0. No flags.
- **Overrides:** the content is a statement list. Atoms: the atoms report
  excludes method bodies; no decision does (OQ 14).

### E6 — Tag arguments

`<Tag(expr)>`:

- **Start:** the character immediately after `(`; no whitespace is skipped
  (`<foo( a )/>` reports ` a `, observed).
- **Stops:** the `)` at depth 0. No flags.
- **After it** (`OPEN_TAG.return`): if `{` follows, after any whitespace, this
  is E17. Otherwise, if type parameters were read before the `(`, the
  `Unexpected types. …` error. Otherwise tag arguments are reported.
- **Atoms:** decision 156.1 names tag arguments as an atom position (planned).

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
  Atoms: no ruling (OQ 14).

### E8 — Placeholder

`${expr}`, `$!{expr}`:

- **Start:** the character immediately after `${` or `$!{`; no whitespace is
  skipped (`${ a }` reports ` a `, observed).
- **Stops:** the `}` at depth 0. No flags.
- **Overrides:** decision 156.1 names `${}` as an atom position (planned).

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
  `+`.
- **Types.** A `:` enters the type context, in which `<` opens a group:
  `<let/x: Map<K,V> = 1/>` is the variable `x: Map<K,V>` and the default value
  `1`. Outside a type context `<` is a hard stop and the open tag then reads a
  type list, so `<let/x<T>=1/>` is the `Unexpected types. …` error. A `|` is a
  hard stop even inside a type: `<let/x: A | B = 1/>` reports the variable
  `x: A` and then reads tag parameters to the end of the input, which is `EOF
  reached while parsing expression` (all observed; OQ 6).
- **Overrides:** the patch does not apply. The value that follows the variable
  is the default attribute and is exempt from the after-value rule
  (`<const/x=items\n .filter(Boolean)/>` is one value, observed; divergence row
  "The parser after-value rule").
- **Atoms:** no ruling (OQ 14).

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
  | `$ const a = 1 // c\n  2` | ends at the newline |

  The second row is valid TypeScript cut short by a trailing space (OQ 24).
- **Block form.** No flags; hard stop `}` at depth 0. After the `}` an optional
  `;`, directly or after whitespace, is consumed (`INLINE_SCRIPT.return`).
- **End of input:** the line form ends silently at depth 0. The block form ends
  silently at depth 0 in concise content and is `EOF reached while parsing
  expression` in HTML content. With a group open, both forms are that error in
  both modes (`$ {(a`, observed; [End of input](#end-of-input)).
- **Overrides:** none. Atoms: the atoms report excludes scriptlets; no decision
  names them (OQ 14).

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
- **Atoms:** no ruling (OQ 14).

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
  default method (observed). Decision 146, addendum 4 gives it its meaning
  (planned; [dialect rule 5](#dialect-rules)).

### Types inside the other positions

TypeScript's own type syntax (`as`, `satisfies`, annotations, generic
arguments) is not a separate MX position. In the default it is handled only by
[the type context](#the-type-context), inside the positions that have
`operators`. In the planned design the TypeScript parser reads it and returns
the end offset, and each position's hard stops still bound the value.

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
   and `.x` after a value are new attributes only through the patch
   ([E1 overrides](#e1--attribute-value-html-mode); decision 146, divergence 3).
   The default attribute's value is exempt (decision 151, ruling 2).
   *Planned:* when the default value is a single atom, whitespace and `:name`
   after it is the name sugar (decision 146, addendum 5); the patch does not do
   this today.
4. **The sugar's value.** `:name` takes an identifier, `[A-Za-z_$][\w$-]*`;
   `#x` and `.x` take what a shorthand part takes (spec §4 "Name sugar"). The
   patch's test for a `:` or `.` split is narrower than both: the next character
   must be `A`–`Z`, `a`–`z`, `$` or `_`. So `x=a .2xl` does not split although
   `.2xl` is a valid class sugar elsewhere (OQ 4), while `x=a .é` splits on the
   stock parser too, because `é` is not a word character and the value simply
   ends (observed).
5. **A sugar followed by `=value` or `(params) { body }`** sets the tag's
   default attribute; the only error is a tag that already has a default value
   (decision 146, addendum 4). *Planned in core.* At parser level the forms
   already parse: `<input:email=1/>` is the tag `input:email` with a default
   value; `<input :email=1/>` is an attribute named `:email` with the value `1`;
   `<input #main(a) {}/>` is a method named `#main` (all observed). Spec §4
   "Name sugar" still lists `:x=1` and `:b(x)` as errors (OQ 11).
6. **Left alone** (spec §4 "Name sugar", "Left alone"; decision 146, divergence
   2 and addendum 3): the named forms `class:x`, `style:x`, `value:fn:=x` and the
   explicit `value:x`; a dynamic tag name; a bound attribute; the default
   attribute; an attribute tag's own name.
7. **Repeated sugars** follow the duplicate rule: the later one wins, with a
   warning (decision 135; spec §4 "Name sugar"). The parser reports each:
   `x=a :b :c` is the value and two attributes (observed, patched).
8. **A bare `:`** in attribute position is a positioned error from core
   (divergence row "Bare `:x` is `name="x"`"). The patch ends a value before a
   bare `:` so that the error can name it ([E1 overrides](#e1--attribute-value-html-mode));
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
11. **Atoms (decision 156 and its addendum 1).** *Planned; not in the parser
    source at `origin/main` `0cd544d84`.* `:name` in an MX expression position
    is a value that represents itself, and its runtime value is the name as a
    string (156.1, 156.2). Decision 156.1 names the positions: "attribute value,
    placeholder `${}`, tag arguments; never inside `static`/`import`/script
    blocks". A name may contain `-` (156.1). `::name` is reserved, and "the
    lexer treats `::` as one token" (156.5). Every other position, and the rule
    for which preceding token allows an atom, come from the atoms report
    (`scratch/reports/squad-atoms/parser-approach.md`, §1d and the test table in
    §5), which is evidence, not a decision (OQ 14).

### Ternary depth

- In a position with `operators`, a `?` at depth 0 adds one to `ternaryDepth`
  and a `:` at depth 0 takes one away; a `:` at `ternaryDepth` 0 enters the
  type context instead ([the character table](#how-a-position-is-scanned)).
- A `?` or `:` inside a group, a string, a template literal or a comment does
  not count.
- The after-value `:` split requires `ternaryDepth` 0
  ([E1 overrides](#e1--attribute-value-html-mode)).
- With the patch, in a named or spread attribute's value, `??` and `?.` (when no
  digit follows the `.`) do not count. `?:` does: `x=a ?:b` is one value
  (observed). Not settled (OQ 3).

## Ambiguous inputs

Each row gives an input and the parse the grammar requires. "Observed" is the
event stream of the **patched** parser, with the stock parser agreeing unless
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
| `x=a ?? b` | one value | default (observed) |
| `x=a?.b` | one value | default (observed) |
| `x=a?.b :c` | value `a?.b`, then an attribute named `:c`. Stock: one value | decision 146, divergence 3 for the split; the `?.` handling is the patch, **not settled** (OQ 3) |
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
| `x=a .2xl` | one value | the patch (observed); **not settled**, OQ 4 |
| `x=a :b :c` | value `a`, then attributes named `:b` and `:c`; core: the later name wins, with a warning | decision 146, divergence 3; decision 135; spec §4 "Name sugar" (observed) |
| `x=a ?:b` | one value | default (observed); OQ 3 |
| `x= :b` | value `:b` | default: the whitespace after `=` is consumed (observed). *Planned:* the atom `b` (decision 156.1; atoms report §3) |
| `x=a ? :b :c` | observed, patched: value `a ? :b`, then an attribute named `:c`. *Planned:* one value, `a ? "b" : c` (atoms report §5, test-table row 6). **Not settled** | OQ 9 |
| `x=a :: b` | observed: one value `a :: b`. **Not settled**: decision 156.5 reserves `::name` and says `::` is one token | OQ 20 |
| `x=::a` | observed: the value `::a`. *Planned:* the reserved-`::` error at the `::` column | decision 156.5; atoms report §5, test-table row 7 |
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
| the six orders of the three tag-adjacent sugars | each sugar keeps its meaning | decision 146, addendum of 23:23 |
| `<input #main/>`, `<input .big/>` | parser: attributes named `#main`, `.big`. Core: id, class | decision 146; spec §4 "Name sugar" |
| `<input :email type="email"/>` | parser: attributes `:email`, then `type`. Core: `name` first | decision 146 |
| `<input x=1 #main .big :email/>` | parser: `x=1`, then attributes named `#main`, `.big`, `:email` | decision 146 (observed) |
| `<input x=a.b .c/>` | as `x=a.b .c` | decision 146, divergence 3 |
| `<input:email=1/>` | parser: tag `input:email` with a default value `1`. *Planned:* `name="email"` and the default value | decision 146, addendum 4 |
| `<input :email=1/>` | parser: an attribute named `:email` with the value `1`. *Planned:* `name="email"` and the default value `1` | decision 146, addendum 4; OQ 11 |
| `<input:email(a) { return a; }/>` | parser: tag `input:email` with a default method. *Planned:* `name="email"` and a default value that is the function | decision 146, addendum 4 |
| `<input #main(a) {}/>` | parser: a method named `#main`. *Planned:* id `main` and a default value that is the function | decision 146, addendum 4 |
| `<input x=1 :/>`, `<input :/>` | parser: an attribute named `:` (the first only with the patch). Core: positioned error, bare `:` | divergence row "Bare `:x` is `name="x"`" |
| `<a:b:c/>` | parser: tag name `a:b:c`. Core: positioned error, one name per tag | divergence row "A static tag name may not contain `:`"; spec §4 "Name sugar" |
| `<if=a\n .b>x</if>` | one value: the default attribute is exempt | decision 151, ruling 2 (observed) |
| `<const/x=items\n .filter(Boolean)/>` | one value | decision 151, ruling 2 (observed) |
| `<div class:x=1/>`, `<div style:x=1/>` | parser: an attribute named `class:x` / `style:x`. Reserved on native elements | spec §4 "`class:foo` / `style:foo` modifiers" |
| `<input value:fn:=x/>` | parser: a bound attribute named `value:fn` | decision 146, divergence 2 (observed) |
| `<div><@svg:rect/></div>` | parser: a tag named `@svg:rect`, not split. An attribute tag on a native element is then an error | decision 146, addendum 3; spec §8 "Deferred to MX 2" |
| `x=a ? b :c` | one value | default: `ternaryDepth` is 1 at the `:` (observed) |
| `x=a ?? b :c` | value `a ?? b`, then an attribute named `:c`. Stock: one value | the patch (observed); **not settled**, OQ 3 |
| `x=a ?.b :c` | value `a ?.b`, then an attribute named `:c`. Stock: one value | the patch (observed); **not settled**, OQ 3 |

## Open questions for mx-lead

None of these is resolved in the normative text.

1. **End offset from the expression parser.** The vendored `@babel/parser` has
   no entry point that returns where an expression stopped; `startIndex` fixes
   only the start. *Recommendation:* a thin wrapper, owned by the parser lead,
   that returns the node and its end index, built first.
2. **Where the default and a TypeScript parser end a value differently.** The
   cases are in [the table below](#where-a-real-typescript-parser-would-end-the-value-differently),
   each with its class under the 2026-10-05 ruling. *Recommendation:* rule the
   rows of class (c) one by one; until then the boundary reproduces the default
   for them, as decision 157.3 requires.
3. **`??`, `?.` and `?:`.** The patch stops `??` and `?.` from opening a
   ternary, and tests pin it, but no spec paragraph or decision states it, and
   `?:` still counts as a ternary. *Recommendation:* state `??` and `?.` in the
   spec as what "no open `?`" means, and decide whether `x=a ?:b` is an error.
4. **`.` followed by a digit.** The patch does not split `x=a .2xl`, while spec
   §4 "Name sugar" says `.2xl` works as a class "in both positions".
   *Recommendation:* keep the exclusion and say so in the spec, or align the
   positions.
5. **Spreads.** The patch applies the after-value rule to a spread
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
9. **Atoms in a ternary.** The atoms report expects `x=a ? :b :c` to be one
   value; the patch splits it at `:c`. *Recommendation:* the ternary counter
   skips an atom's `:`.
10. **Wording of the parser's own errors.** Messages such as `A semicolon
    indicates the end of a line. Only comments may follow it.` and the HTML
    comment error are the stock parser's; no MX source says whether MX keeps
    the wording. *Recommendation:* keep them and pin each with a fixture.
11. **Spec §4 "Name sugar" still lists `:x=1` and `:b(x)` as errors**, which
    decision 146, addendum 4 replaced. *Recommendation:* update the spec with
    the addendum-4 change.
12. **`$!{…}` in an attribute value.** The template parser accepts it as value
    text; spec §3 "Interpolation" says "Marko's parser rejects it". Under
    decision 158 there is no Marko compiler; which MX layer raises it?
    *Recommendation:* the expression parse at the boundary, with an MX message.
13. **Text bodies.** The parser recognises placeholders, strings and template
    literals in a `TagType.text` body, and an unbalanced quote there is an
    end-of-input error (`<textarea>don't</textarea>`); spec §3 "CDATA sections
    and XML declarations" says such a body is "a single `MarkoText`" and lists
    `<title>`, which the consumer's `TEXT` set does not contain.
    *Recommendation:* amend the spec to "text and placeholders", decide whether
    quotes stay significant in `textarea`, and settle `title`.
14. **Atoms outside the three ruled positions.** Decision 156.1 names attribute
    values, `${}` and tag arguments, and excludes `static`/`import`/script
    blocks. Scriptlets, method bodies, attribute arguments, tag parameters, the
    tag variable, spreads and tag-name interpolations have no ruling, and
    "script blocks" is undefined. *Recommendation:* extend 156.1 with the full
    list.
15. **Spec §4 "Consumers on a stock parser"** and divergence row "The parser
    after-value rule" describe the stock-parser diagnostic of decision 151,
    ruling 1. Decision 157 addendum 3 removed it and decision 158.2 says it
    stands until `@marko/compiler` is dropped. *Recommendation:* keep the
    paragraphs, and say in them that they lapse with that drop.
16. **A tag name's first character.** The parser accepts any character that is
    not a terminator, a leading digit included. *Recommendation:* state the
    terminator rule in the spec, or add a rule and a diagnostic.
17. **The operator exemption.** A hard stop written directly after an operator
    is consumed (`x=a + ,b` is one value; `x=a +/>` is a regular-expression
    error). No valid TypeScript is affected. *Recommendation:* make the stop
    unconditional and let the expression parser report `a +`.
18. **Newline continuation.** In concise mode a value continues past a newline
    only in the cases E2 lists; in HTML mode the look-ahead crosses newlines,
    which yields values such as `a\n  <span`. *Recommendation:* keep the
    concise rule, and rule whether HTML mode keeps the look-ahead across a
    newline.
19. **End of input with an open delimiter.** `div x=(a` is an error; `div(a`
    and `$ {a` end silently, because their delimiter is not on the position's
    group stack. *Recommendation:* an error in all three.
20. **`::` followed by whitespace.** Decision 156.5 reserves `::name`; today
    `x=a :: b` is one value. *Recommendation:* reject `::` wherever the atom
    lexer runs.
21. **Agreement with the AST catalogue.** MX2 has its own AST (decision 158),
    catalogued in `apps/docs/docs/architecture/ast.md` on another branch. The
    two documents must agree on the names of the expression positions and on
    span rules (for example that argument, parameter and placeholder ranges
    include the whitespace inside their delimiters, and that a tag variable's
    range includes the `/`). This document neither depends on nor edits that
    catalogue. *Recommendation:* whichever lands second adopts the other's
    names.
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
    statement (`$ a = 1 + ⏎`); `... [a]` and `... "s"`. One oddity on the other
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

### Where a real TypeScript parser would end the value differently

Each row is an observed input. "Default" is the stock parser's result, plus the
patch where the row says so. The class is assigned from the spec text and
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
| `x=a.b .c`, `x=fn(a) .b` | patched: split before `.c` | member access, one expression | **(b)** | divergence row "The parser after-value rule" names both spellings |
| `x=(a) :T => a` | patched: split before `:T`, then `Missing value for attribute` | an arrow function with a return type | **(b)** | the same row names this input; decision 151, ruling 3 |
| `<if=a .b>`, `<const/x=items\n .filter()/>` | one value | one expression | **(b)**, no difference | the same row: the default attribute is exempt |
| `x=a ?? b :c`, `x=a ?.b :c` | patched: split before `:c` | `??` and `?.` are not ternaries; the expression ends before `:c` | **(a)** | the rule says "`:` … with no open `?`"; whether `??` or `?.` opens one is a fact of TypeScript's grammar. OQ 3 |
| `x=a ? :b :c` | patched: split before `:c` | with atoms, `:b` is a value and `:c` closes the ternary | **(a)** | the same clause, once atoms exist. OQ 9 |
| concise `div x=a\n  .b`, `\n  (b)`, `\n  + b`, `\n  ? b : c`, `\n  in b`, `\n  <span/>` | value `a`, then a child | continues across the newline | **(b)** | spec §3 "Concise mode": a concise tag's "children are the lines indented under it" |
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

Two behaviours above are filed defects, not grammar, and are to be fixed in
`packages/parser/src/template/`:

- a generic call or generic arrow in an HTML-mode value is cut at `>` with no
  error (`x=f<T>(y)`, `x=<T,>(a) => a`);
- a concise-mode file that ends inside an open delimiter raises no error
  (`div(a`, `$ {a`).

The behaviours listed in OQ 24, OQ 25 and OQ 27 look like defects as well and
are not filed. An implementer **must not** treat any of them as intended
grammar; each is described here only so that a difference from the default is a
decision and not an accident.

## Conformance

The htmljs-parser fixtures cited below are in
`/Users/svallory/work/htmljs-parser/src/__tests__/fixtures/`, one directory per
case with an `input.marko` and a snapshot, and are **evidence of the default
behaviour, not a gate**.

| Section | Exercised by |
| --- | --- |
| Tag names, shorthands, the `:` split | `packages/core/src/name-sugar.test.ts`; htmljs fixtures `tag-name-*`, `shorthand-*` |
| Close tags | htmljs fixtures `empty-closing-tag*`, `shorthand-closing-html*` (`shorthand-closing-html2` is `<#foo>` closed by `</div>`) |
| Sugars and the after-value rule | `patches/htmljs-parser.test.ts` (`CHANGED`, `PINNED`, `DEFAULT_ATTRIBUTE`); `packages/core/src/name-sugar.test.ts`; `packages/core/src/stock-parser.test.ts`; `packages/targets/html/src/stock-parser.test.ts` |
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
| Atoms | **no asset**: the test table in the atoms report (§5) is written, not implemented |

### Rules no existing test covers

For each rule below, a search of the htmljs fixtures' `input.marko` files and of
`patches/htmljs-parser.test.ts` for the rule's characteristic input found
nothing (the patterns searched are in the task report):

- concise `as T >` (the `Mismatched group` case of the type context);
- an operator followed by a block comment and an operand (`a + /* c */ b`);
- a spread whose expression starts after whitespace with `[` (`... [a]`);
- an arrow at the top level of a type list (the fixture
  `tag-type-argument-arrow-function` has its arrow inside `{ … }`);
- a union type inside tag parameters or a tag variable;
- a trailing operator followed by whitespace before the newline, in a scriptlet
  or statement;
- hyphens followed directly by a non-space character (`--abc`).

Not searched, and therefore not claimed either way: the concise newline cases
of E2 as a set, and close tags inside a concise region.

Not implemented, so untested by construction: decision 146, addenda 4 and 5,
and atoms. The operator exemption (`x=a + ,b`) should stay unpinned until OQ 17
is ruled.

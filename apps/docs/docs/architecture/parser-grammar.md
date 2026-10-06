---
title: "The parser grammar"
description: "How MX source text is split into tokens, expressions and nodes, in every mode, for the MX-owned parser."
---

# The parser grammar

This document is the parser-level specification of MX: how source text is split
into tags, attributes, values, bodies, placeholders, scriptlets and text, in
HTML mode, concise mode, and the delimited blocks. It is written to be
implementable and testable, not to be read as a tutorial.

It is **a draft for review by the language lead**, who owns language design. Where the
language spec, the decision log and `divergences.md` disagree or are silent, the
disagreement is recorded in [Open questions for the language lead](#the-parser-grammar-open-questions-for-the-language-lead)
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
  install of core parses with MX's rules" (OQ 15).
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

### Method: the tables and the probes are the specification

Decision 165 fixes what in this document is normative:

- **Normative:** every table whose last column is **Probes**. Each of its rows
  cites the probes that pin it.
- **Informative:** everything else, which is all prose and every table
  without a Probes column. It explains the tables and links them; it states
  no rule of its own.

A **probe** is one input, the options handed to the parser, and the parser's
whole ordered event list for it: every event with its ranges and the text
`read()` returns, every error with its code, message and range. The probes are
`packages/parser/src/template/grammar-spec.corpus.json`, and a probe id is
written `gNNNN`. `grammar-spec.test.ts` runs the corpus against the template
parser's source, `patches/htmljs-parser.test.ts` runs it against both builds
of the patched npm parser, and the first also fails when a row of a normative
table cites no probe, when a cited id does not exist, or when a probe is cited
by no row. `grammar-spec.cases.ts` gives the event format and the command that
regenerates the expected events after a parser change.

How to read a normative table:

- A row's cells summarise what its probes' events show. Where a cell and a
  probe disagree, the probe is right and the cell is an error in this
  document.
- A table whose first column is `#` is in the branch order of the code symbol
  named above it: the first row whose condition holds is the one that applies.
- An input written `x=v` stands for `<div x=v/>`, or for `div x=v` where the
  row says concise; `\n` in an input is a newline. The probe holds the exact
  input.
- A row that pins a recorded defect or limit names its TODO. Its probes carry
  that name in the corpus, and the fix for the TODO regenerates them.
- A "Stock: …" remark in a cell, a column headed "Stock", and the "Without
  atoms" column of the atoms table describe builds the corpus does not run
  (stock 5.18.0, and main with atom lexing switched off). They are
  observations made on 2026-10-06, informative and not probed.
- The probes' consumer types `script`, `style`, `textarea`, `html-comment`,
  `html-script` and `html-style` as text tags, `input` and `br` as void tags,
  and `static`, `import`, `export`, `server`, `client` and `class` as
  statement tags.

The subject is **MX's template parser**: the source on `main` at
`packages/parser/src/template/` (decision 158.3; read for this revision at
`origin/main` `98f5df47b`). It began as a copy of `htmljs-parser` 5.18.0 and is
now MX's own code; its `PROVENANCE.md` records its departures from 5.18.0.
Code is cited **by file and symbol**, not by line number.

**Stock** means htmljs-parser 5.18.0 unchanged
(the v5.18.0 tag of htmljs-parser). It appears as a
comparison in some cells ("Stock: …"). The departures from stock, with the
symbols that carry them:

| Departure | Files and symbols | Source of the rule |
| --- | --- | --- |
| the after-value rule | `states/ATTRIBUTE.ts` (`attrValue`); `states/EXPRESSION.ts`: the `??`/`?.` branch of `EXPRESSION.parse`, the `:` and `.` rows of `lookAheadForOperator`, `isIdentStartCode`, `isNameStartCode`, `isBareColonEnd` | decision 146, divergence 3 and addendum 6 ([E1](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode)) |
| a single-atom default value | `states/ATTRIBUTE.ts` (`defaultAtom`); `states/EXPRESSION.ts` (`isSingleAtomDefault`) | decision 146, addendum 5 ([E1](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode)) |
| atoms and the reserved `::` | `states/EXPRESSION.ts` (`lexAtom`, `expectsExpression`, `isOperatorWord`, `closesTypeArguments`, `isUnicodeWhitespaceCode`, `isSpreadEnd`, `atomNameEnd`, `rejectReservedName`, the atom guard in `lookBehindForKeyword`); the `atoms = true` sites in `states/ATTRIBUTE.ts`, `OPEN_TAG.ts`, `PLACEHOLDER.ts`, `TAG_NAME.ts`, `TEMPLATE_STRING.ts`; `rejectReservedName` calls in `TAG_NAME.exit` and `ATTRIBUTE.return`; `core/Parser.ts` (`atoms`, `read`, `rawOpenTags`); `util/constants.ts` (`onAtom`); `OPEN_TAG.exit` (`rawOpenTags`) | decision 156 and its addenda 2 to 4 and 8 to 10 ([Atoms](#the-parser-grammar-atoms)) |
| the base position | `core/Parser.ts` (`ParseOptions`, `parse`, `positionAt`, `offsetAt`); `index.ts` | the parser's API ([Base position](#the-parser-grammar-base-position-for-fragment-parses)) |
| non-ASCII word characters where the parser looks behind or ahead | `util/util.ts` (`isUnicodeWordCode`, `wordWidthBefore`, `wordWidthAt`, `isUnicodeSpaceCode`) and its callers in `core/Parser.ts`, `states/EXPRESSION.ts`, `ATTRIBUTE.ts` and `INLINE_SCRIPT.ts` | decision 156, addenda 9, 10 and 13 ([Vocabulary](#the-parser-grammar-status-sources-of-truth-and-method-vocabulary)) |
| Unicode whitespace in every look-behind that asks whether a character is whitespace | `util/util.ts` (`isUnicodeWhitespaceCode`) and its callers: `core/Parser.ts` (`getPreviousNonWhitespaceCharCode`); `states/EXPRESSION.ts` (the terminator and `{` look-behinds of `EXPRESSION.parse`, `checkForOperators`, the `++`/`--` row of `lookBehindForOperator`, the atom look-behind); `states/ATTRIBUTE.ts` (`shouldTerminateHtmlAttrValue`, `shouldTerminateConciseAttrValue`, `shouldTerminateConciseAttrName`); `states/HTML_CONTENT.ts` | decision 156, addenda 10 to 12 ([Vocabulary](#the-parser-grammar-status-sources-of-truth-and-method-vocabulary)) |
| a `//` comment in a text tag's open tag; a close tag with no open tag, or after a tag that never got its name | `states/JS_COMMENT_LINE.ts` (`isInTextBody`); `states/CLOSE_TAG.ts` (`checkForClosingTag`, `ensureExpectedCloseTag`) | the parser does not throw (below) |

The bun patch `patches/htmljs-parser@5.18.0.patch`, which `@marko/compiler`'s
npm copy still runs under in this repository, carries the same after-value,
addendum-5 and atom rules (`PROVENANCE.md`); the corpus and
`corpus-equivalence.test.ts` hold the three builds together.

**The parser does not throw** (the language lead, 2026-10-06, recorded with decision
165): an internal failure is reported through `onError`.

| Rule | Result | Probes |
| --- | --- | --- |
| a parse reports its failures through `onError` and returns | holds for the inputs of [Error conditions](#the-parser-grammar-error-conditions); `<div x=(` is one of them | g0678 |
| the same, for a `//` comment in a text tag's open tag followed by a close tag in the body, which threw a `TypeError` before the fix of TODO `template-parser-comment-in-text-tag-open-crash` | the comment runs to the end of its line and the body is read: `<script x=1 // </script>\n>a</script>` is the value `1 // </script>`, the text `a` and the close tag | g0048 |
| the same, for a named close tag after a tag that never got its name (`,--/</e>`: the `,` opens one and a concise `--` line follows), which threw a `TypeError` from `ensureExpectedCloseTag` before the look-behinds follow-up | `The closing "e" tag was not expected`, on the close tag | g1683 |

Where the parser's behaviour differs from what a source of truth says, or the
parser accepts input that is not valid TypeScript, or rejects input that is,
this document records it and raises an open question.

### The central design change

The parser stops guessing where an embedded TypeScript expression ends. At the
positions in [Expression boundaries](#the-parser-grammar-expression-boundaries) it will call a real
TypeScript expression parser **at the value's start offset**, supply stop
conditions, and take the **end offset** back. The vendored `@babel/parser`
7.29.8 is that parser. Its `startLine`, `startColumn` and `startIndex` options
exist and **must** be supplied with the value's real base offsets, so a
diagnostic column is the column in the MX file. No entry point of the vendored
parser returns where an expression stopped yet (OQ 1).

#### The ruling governing that boundary

The language lead, who owns language design, ruled on 2026-10-05. The ruling has no
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
  under decision 157.3 until the language lead rules, and the case is listed as not
  settled.

The table in [Where a real TypeScript parser would end the value
differently](#the-parser-grammar-open-questions-for-the-language-lead-where-a-real-typescript-parser-would-end-the-value-differently)
classifies the known differences in those classes.

### Vocabulary

These are definitions of terms; the tables that use them carry the rules.

- **Position.** A place where the parser reads an expression, statement list,
  type list or pattern: one run of the `EXPRESSION` state, configured by flags
  and one stop function ([Inventory of positions](#the-parser-grammar-expression-boundaries-inventory-of-positions)).
- **Depth.** The number of open groups in the position (`groupStack.length`).
- **Hard stop.** A character for which the position's stop function
  (`shouldTerminate`) returns true
  ([How a position is scanned](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned), step 4).
- **Soft stop.** Whitespace or a newline in a position whose flags make it one
  (steps 1 and 3 of the same table).
- **Whitespace** is a character with code 32 or lower (`isWhitespaceCode`,
  `util/util.ts`). Where a look-behind asks whether a character is
  whitespace, the excepted characters below count as whitespace too
  (`isUnicodeWhitespaceCode`; decision 156, addenda 10 to 12):
  `<div x=(é)\u00a0/ 2/>` divides and `<div x=a +\u00a0 y=1/>` is one value,
  as with a space ([Recorded defects](#the-parser-grammar-open-questions-for-the-language-lead-recorded-defects-in-the-default)).
  Current-character and look-ahead tests
  keep `isWhitespaceCode`; **indent characters** are space and tab (`isIndentCode`); a
  **word character** is `A`–`Z`, `a`–`z`, `0`–`9`, `$`, `_`, or a code point at
  or above U+0080 that has the Unicode property `ID_Continue`, or is U+200C or
  U+200D (`isUnicodeWordCode`, `wordWidthBefore`, `wordWidthAt`,
  `util/util.ts`; decision 156, addendum 13, which replaced addendum 9's
  "anything that is not whitespace"). A surrogate pair is one code point, read
  as one looking back (a low surrogate with the high surrogate before it) and
  looking ahead (a high surrogate with the low surrogate after it); a lone
  surrogate is no word character. So `é`, `名`, a combining mark and `𠞷` are
  word characters, and `©`, `×`, `…`, `«`, an emoji and a private-use
  character are not. The excepted characters above are U+00A0, U+1680,
  U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF
  (`isUnicodeSpaceCode`); none of them is a word character. The set is
  ECMAScript's WhiteSpace plus LineTerminator above ASCII, which is also
  Babel's; TypeScript additionally treats U+0085 and U+200B as whitespace, and
  MX does not. Step 2 of the
  scan and an atom's own name use the ASCII part (`isWordCode`).

  | Input | Result | Probes |
  | --- | --- | --- |
  | `<div x=a >\u00a9>c</div>` (U+00A9 is no word character) | the value `a`, then the text `\u00a9>c`, as stock; no `Ambiguous ">"` error | g1691 |
  | `<div x=\u00a9 / 2 y=1/>` | the `/` after a non-word character starts a regular expression, which swallows the rest of the tag (stock) | g1692 |
  | `<div x=😀 / 2 y=1/>` (an emoji, a surrogate pair) | the same | g1693 |
  | `<div x=\ud800 / 2 y=1/>` (a lone surrogate) | the same | g1697 |
  | `<div x=𠞷 / 2 y=1/>` (U+20BB7, `ID_Start`, a surrogate pair) | a division: the value is `𠞷 / 2`, then `y=1` | g1694 |
  | `<div x=a\u200d / 2 y=1/>` (a ZWJ) | a division | g1695 |
  | `<div x=a\u0301 / 2 y=1/>` (a combining mark) | a division | g1696 |
  | `<div x=a >𠞷>c</div>` | `Ambiguous ">"`, as with `a >b>c` | g1698 |
- **The default** is what the template parser does where no MX departure
  applies. Decision 157.3 makes it the normative answer wherever MX has no
  ruling.
- **Supplied sets.** Which names are statement tags, text tags and void tags
  is answered by the consumer's `onOpenTagName` handler, which returns a
  `TagType` (`TAG_NAME.exit`). The AST catalogue makes the statement set and
  the tag shapes inputs supplied per target (decision 163 addenda 1 and 3;
  [the AST catalogue](/architecture/ast/) §3.10 "Statement keywords per
  target" and §3.12). This document says "the supplied statement set" and "a
  text tag" for them.

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

| Event (`util/constants.ts`) | Range the parser reports | Catalogue field (ast.md section) | Probes |
| --- | --- | --- | --- |
| `onOpenTagName` | the written name, sugar included; an empty range for the unnamed tag | `MxTag.name` (§3.3), after core's `:` split | g0001 g0002 |
| `onTagShorthandId`, `onTagShorthandClass` | the part from its `#` or `.`, which may hold a `:name` | `MxShorthand` with `position: "tag"` (§3.6), after core's split | g0003 g0004 |
| `onTagTypeArgs`, `onTagVar`, `onTagArgs`, `onTagTypeParams`, `onTagParams` | `value`: inside `<…>`, after `/`, inside `(…)`, inside `\|…\|`; event range: with the delimiters | `MxTag.typeArgs`, `var`, `args`, `typeParams`, `params` (§3.4): span = `value`, `outer` = event range | g0005 g0006 g0007 g0008 g0009 |
| `onAttrName` | the name; empty for the default attribute | `MxAttribute.nameSpan`, or an `MxShorthand` with `position: "attribute"` for `#x`, `.x`, `:x` (§3.5, §3.6) | g0010 g0011 g0012 |
| `onAttrValue` | `value`: from the first character after `=`/`:=` and the whitespace after it | `MxAttribute.value` or `MxShorthand.default` (§3.5) | g0013 g0014 |
| `onAttrSpread` | `value`: from the character after `...`, whitespace included | `MxSpreadAttribute.value` (§3.5b) | g0015 |
| `onAttrArgs` | `value`: inside `(…)` | `MxAttribute.args` (§3.5) | g0016 |
| `onAttrMethod` | `params`, `body`, `typeParams`, each with a `value` inside its delimiters | `MxMethod.params`, `body`, `typeParams` (§3.5a) | g0017 |
| `onPlaceholder` | `value`: inside `${…}` | `MxPlaceholder.expression` (§3.9) | g0018 g0019 |
| `onScriptlet` | `value`: the statement, or inside `{…}` for the block form | `MxScriptlet.code` (§3.10) | g0020 g0021 |
| `onAtom` | the whole atom, `:` included; `value` is the name | `MxAtom` in the enclosing container's `atoms` (§4.3) | g0022 |

A statement tag's code is reported by no event of its own
([E10](#the-parser-grammar-expression-boundaries-e10-statement-tags)): the parser reports the name and then
`onOpenTagEnd` where the statement ends, and the catalogue's
`MxModuleStatement` (§3.10) takes the statement from that range.



## Document structure and modes

`Parser.parse` enters `CONCISE_HTML_CONTENT` with `isConcise = true`. The
content states:

| State | Entered by | Left by | Probes |
| --- | --- | --- | --- |
| **Concise content** (`CONCISE_HTML_CONTENT`) | the start of the file; the end of an HTML region or delimited block | never; it is the root state | g0023 |
| **HTML content** (`HTML_CONTENT`) | a concise line whose first character is `<` (mixed mode); a delimited block; the `>` that ends an HTML-mode open tag continues in the enclosing HTML content | the newline rules below; end of input | g0024 g0025 |
| **Text content** (`PARSED_TEXT_CONTENT`) | the end of the open tag of a tag the consumer typed `TagType.text`, in HTML mode; a delimited block whose enclosing tag is such a tag | its close tag; the end of its delimited block | g0026 g0027 |

**Concise mode is the parser flag `isConcise`.** `CONCISE_HTML_CONTENT` sets
it, `HTML_CONTENT.enter` clears it, and `PARSED_TEXT_CONTENT` leaves it as it
was, which is why a delimited block under a concise text tag is still concise
mode. "In concise mode" in this document means this flag. Where the flag is
read (`grep -rnE "(this|parser)\.isConcise\b" states core | grep -v "isConcise = "`
lists the reads; `tag.concise`, the copy `OPEN_TAG.enter` records, is read by
`TAG_NAME.exit` and `htmlEOF`):

| Read by | What the flag decides | Stated in |
| --- | --- | --- |
| `EXPRESSION.parse`, end of input | whether a position at depth 0 ends silently | [End of input](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-end-of-input) |
| `checkForOperators` | the newline and look-ahead steps of the continuation test, and its `</` step | [The continuation test](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-the-continuation-test) |
| `ATTRIBUTE.parse` | whether a newline ends the attribute; which stop function a value and a name get; end of input after a name | [Attributes](#the-parser-grammar-attributes), E1 to E3, [Error conditions](#the-parser-grammar-error-conditions) |
| `ATTRIBUTE.return` | whether the ambiguous `>` check runs | [The ambiguous `>` check](#the-parser-grammar-attributes-the-ambiguous-check) |
| `isAsyncMethodPrefix` | which whitespace is skipped after `async` | [Attributes](#the-parser-grammar-attributes) |
| `OPEN_TAG.enter`, `OPEN_TAG.exit` | the tag's recorded mode; the `onOpenTagEnd` range; which state reads a text tag's body | the table below; [Text bodies](#the-parser-grammar-text-comments-cdata-doctype-declarations-and-text-bodies-text-bodies) |
| `OPEN_TAG.parse` | rows 1 to 8 of the open-tag table; which stop function the tag variable gets; end of input | [The open tag](#the-parser-grammar-tags-the-open-tag), E9 |
| `TAG_NAME.parse` | which characters end a name or a shorthand part | [Tag names](#the-parser-grammar-tags-tag-names) |
| `PARSED_TEXT_CONTENT.parse`, `JS_COMMENT_LINE.parse` | whether a close tag ends a text body and a `//` comment in it | [Text bodies](#the-parser-grammar-text-comments-cdata-doctype-declarations-and-text-bodies-text-bodies) |

**Modes, regions and the end of input** (`CONCISE_HTML_CONTENT.parse`,
`HTML_CONTENT.parse`, `OPEN_TAG.enter`/`OPEN_TAG.exit`, `Parser.closeTagEnd`,
`htmlEOF`):

| Case | Result | Probes |
| --- | --- | --- |
| a concise line that starts with `<` | an HTML region; it ends at the first newline after its top-level tag has closed, and text after that tag on the line is HTML content: `div\n  <span>a</span> b\n  p` is the tag `span`, the text ` b`, then the concise child `p` | g0024 |
| a newline inside an open HTML tag of the region | the region continues: `<a></a><b>\n</b>\ndiv` | g0679 |
| a region line with no open tag (an HTML comment) | the region ends at the newline | g0680 |
| a region whose top-level tag is a void tag | the region ends at the newline | g0681 |
| `/>` in HTML mode | self-closes the tag, void or not | g0682 g0683 |
| the `onOpenTagEnd` range | empty in concise mode; the `>` or `/>` in HTML mode | g0684 g0044 g0010 |
| a delimited block under a concise text tag | concise mode: end of input in its placeholder is silent | g0377 |
| a delimited block under any other concise tag | HTML mode: the same end of input is an error | g0379 |
| end of input with concise tags open | they are closed silently | g0023 |
| end of input with an HTML-mode tag open | `Missing ending "<name>" tag` | g0223 |

**Close tags** (`CLOSE_TAG.parse`, `ensureExpectedCloseTag`). `</` in HTML
content reads to the next `>`, and the text between is compared:

| # | The text between `</` and `>` | Result | Probes |
| --- | --- | --- | --- |
| 1 | empty (`</>`) | closes the open tag, whatever its name | g0155 g0685 |
| 2 | equal to the open tag's written name, or to the literal `div` when the name range is empty | closes it. `<div:x>` is closed by `</div:x>` and not by `</div>`. TODO `unnamed-tag-close-compares-literal-div` | g0154 g0686 g0687 g0688 |
| 3 | equal to the source from the start of the name to the end of its shorthands | closes it | g0689 |
| 4 | anything else | `The closing "x" tag does not match the corresponding opening "y" tag` | g0238 |
| — | any, with no open tag | `The closing "x" tag was not expected` | g0237 |
| — | a named close tag when the open tag never got its name (`,--/</e>`) | `The closing "x" tag was not expected`; `</>` still closes that tag (row 1) | g1683 |
| — | a close tag on a line under a concise tag | closes the concise tag without error. TODO `concise-close-tag-closes-concise-tag` | g0690 |

The literal `div` in row 2 is OQ 25. Spec §3 "Concise mode" describes the last
row as a parse error (OQ 26).

## Tags

### The open tag

`OPEN_TAG.parse`:

| # | Character | Mode | Result | Probes |
| --- | --- | --- | --- | --- |
| 1 | newline | concise, outside `[ … ]` | look ahead over whitespace (newlines included), `//` comments and `/* */` comments; if the next character is `,` the open tag continues, otherwise the open tag ends at this newline | g0028 g0029 g0030 |
| 2 | newline | HTML, or inside `[ … ]` | skipped | g0031 g0032 |
| 3 | `;` | concise | the open tag ends. Only whitespace, a `//` or `/* */` comment or an HTML comment may follow on the line, otherwise `A semicolon indicates the end of a line. Only comments may follow it.` This applies inside `[ … ]` too | g0033 g0034 g0035 |
| 4 | `-` | concise | first, if the next character is not `-`, in or out of `[ … ]`: `"-" not allowed as first character of attribute name` (`div [a -b]`, observed). Otherwise, inside `[ … ]`: `Attribute group was not properly ended`. Otherwise the open tag ends and a delimited block begins ([E12](#the-parser-grammar-expression-boundaries-e12-delimited-html-blocks)) | g0036 g0037 g0038 g0039 |
| 5 | `[` | concise | begins an attribute group; a second `[` inside one is `Unexpected "[" character within open tag.` | g0040 g0041 |
| 6 | `]` | concise | ends the attribute group; outside one it is `Unexpected "]" character within open tag.` | g0042 g0043 |
| 7 | `>` | HTML | ends the open tag | g0044 |
| 8 | `/>` | HTML | ends the open tag, self-closed | g0010 |
| 9 | `//`, `/*` | both | a JavaScript comment, reported as an open-tag comment. A `//` comment runs to the end of its line, in a text tag's open tag too (`isInTextBody`): `<script // c </script>` is the comment `// c </script>` and then `EOF reached while parsing open tag`; `<script x=1 // </script>\n>a</script>` is the value `1 // </script>`, the body text `a` and the close tag | g0045 g0046 g0047 g0048 |
| 10 | `<!--` | both | `An html comment cannot be used within an open tag. Use a JavaScript comment (// or /* */) instead.` | g0049 |
| 11 | whitespace | both | skipped | g0050 |
| 12 | `,` | both | skipped together with **all** whitespace after it, newlines included, in concise mode too | g0051 g0052 |
| 13 | any other, and the tag already has an attribute | both | an attribute begins here ([Attributes](#the-parser-grammar-attributes)) | g0053 |
| 14 | any other, the tag has a name and no attribute yet | both | `/` begins the tag variable (E9); `(` begins tag arguments (E6); `\|` begins tag parameters (E7); `<` begins a type list (E14, E15); anything else begins the first attribute | g0054 g0007 g0055 g0005 g0056 |
| 15 | any other, the tag has no name yet | both | the tag name begins here | g0001 g0057 |

What the row order means for some inputs:

| Input | Result | Probes |
| --- | --- | --- |
| `<foo x \|a\|/>` | row 14 is before the first attribute only: after `x`, `\|a\|` is an attribute name | g0691 |
| `<foo x=1 /y/>` | the single value `1 /y` | g0692 |
| `<div/x(a)/>`, `<div\|a\|/x/>`, `<foo\|a\|(b)/>`, `<foo(a)\|b\|/>` | the forms of row 14 in either order | g0693 g0694 g0695 g0696 |
| `<foo(a)(b)/>` | `A tag can only have one argument` | g0226 |
| `<foo\|a\|\|b\|/>` | `A tag can only specify parameters once` | g0227 |
| `<foo (a)/>`, `<foo /x/>` | whitespace before the form (row 11): tag arguments, a tag variable | g0697 g0698 |
| `div a--b` | the attribute name `a--b`: row 4 is reached where an attribute could begin | g0126 |
| `div a -- text` | the name `a` and a text block | g0699 |
| `div x\u00a0-- text` (U+00A0 before `--`) | the name `x\u00a0` and a text block: the name keeps the Unicode space, which ends no name (decision 156, addendum 12) | g1681 |
| `div a\n  // c\n  ,b` | attributes `a` and `b`: row 1's look-ahead crosses the comment line | g0700 |
| `<div` | `EOF reached while parsing open tag` | g0221 |
| `div a` | the tag ends at end of input | g0684 |
| `div [a` | `EOF reached while within an attribute group (e.g. "[ ... ]").` | g0222 |

### Tag names

`TAG_NAME.parse`, for a name and for each shorthand part:

| # | Character | Result | Probes |
| --- | --- | --- | --- |
| 1 | newline | the part ends | g0058 g0023 |
| 2 | `${` | an interpolation (E13) inside the part; the part continues after its `}` | g0059 g0060 |
| 3 | whitespace, `=`, `:` when the next character is `=`, `(`, `/`, `\|`, `<`, `,`; in concise mode also `;` and `[`; in HTML mode also `>` | the part ends, and the open tag continues at this character | g0010 g0061 g0062 g0063 g0064 g0065 g0066 g0067 g0068 g0069 g0070 |
| 4 | `.` or `#` | the part ends and a shorthand part begins after this character | g0071 |
| 5 | any other | part of the name | g0072 |

| Input | Result | Probes |
| --- | --- | --- |
| `<a:b=1/>` | the tag `a:b` with a default value: `:` is a name character (decision 146: "tag-adjacent `:` is a tag-name character") | g0701 |
| `<div:=x/>` | the tag `div` with a bound default value | g0702 |
| concise `div>a` | one tag name | g0703 |
| `<1abc/>` | the tag `1abc` (OQ 16) | g0704 |
| `<a::b/>`, `<div.a::b/>`, `<div#a::b/>` | `::` in the static text of a name or shorthand part is the reserved-token error `` `::b` is reserved (decision 156): … `` (`TAG_NAME.exit`, `rejectReservedName`; decision 156, addenda 2 and 3), and the part is not reported. Stock: the tag `a::b`, the parts `.a::b`, `#a::b` | g0194 g0195 g0705 |
| `<${"a::b"}/>` | the tag `${"a::b"}`: the `::` is inside the interpolation | g0706 |
| `<a::b${x}/>`, `<a::${x}/>` | the error names `::b` and `::`: the name after `::` ends where the static piece ends | g0707 g0708 |
| `<:email/>` | the name `:email`; the tag is not unnamed at this level | g0635 |
| `<a:b:c/>` | the tag `a:b:c`; the second `:` is core's error, not the parser's | g0655 |

The name forms:

| Form | Example | Grammar | Probes |
| --- | --- | --- | --- |
| Static | `div`, `my-widget` | a run of row-5 characters | g0057 g0073 |
| Interpolated | `<${expr}>`, `<${foo}-bar>`, `<${a}${b}>` | any mix of row-5 characters and `${…}` | g0074 g0075 g0076 |
| Unnamed | `<.card>`, `<#main>` | the name part is empty and a shorthand follows; the name event has an **empty** range (decision 145) | g0002 g0077 |
| Statement tag | `static`, `import`, … | a name in the supplied statement set, for which the consumer returns `TagType.statement` ([E10](#the-parser-grammar-expression-boundaries-e10-statement-tags)) | g0078 g0079 g0080 |

The empty name range is the parser's signal that the tag is unnamed (the
catalogue's `MxTagName` `kind: "unnamed"`, [ast.md §3.3](/architecture/ast/));
core resolves it through the `defaultTag` ladder
([dialect rule 9](#the-parser-grammar-dialect-rules)).

The `:` split of a static tag name (`tag:rest` is the tag `tag` plus
`name="rest"`; divergence row "A static tag name may not contain `:`";
decision 146, divergence 1) is core's, after the parse; the parser reports the
written head as the name (the rows `<:email/>` and `<a:b:c/>` above). A
dynamic name is not split (spec §4 "Name sugar", "Left alone").

### Shorthand `#id` and `.class`

A shorthand part is read by the tag-name loop above (`TAG_NAME.parse`,
`TAG_NAME.exit`):

| Input | Result | Probes |
| --- | --- | --- |
| `div.a\n  span` | the part `.a` and a child: a part ends on a newline | g0058 |
| `<div.${x}-y/>`, `<div.a${x}b/>` | one class part: a part continues across `${…}` | g0709 g0060 |
| `<div.a#b.c/>` | parts `.a`, `#b`, `.c`: a part ends at the next `.` or `#` | g0071 |
| `<div#a#b/>` | `Multiple shorthand ID parts are not allowed on the same tag` | g0233 |
| `<input#main:email.big/>` | the id part `main:email` and the class part `big`: `:` is a name character, so a `:name` after a shorthand is inside that part | g0638 |

Core splits the static part of a shorthand `class`/`id` value at its first `:`
(divergence row "A shorthand class or id cannot contain `:`"; decision 146,
addendum of 23:23).

## Attributes

`ATTRIBUTE.parse`, which the open tag enters at its rows 13 and 14. "Read"
in the Condition column is how far the attribute has got: nothing, a name,
arguments, type parameters.

| # | Character | Condition | Result | Probes |
| --- | --- | --- | --- | --- |
| 1 | newline | concise mode (also inside `[ … ]`) | the attribute ends | g0081 g0082 |
| 2 | newline | HTML mode | skipped | g0083 |
| 3 | whitespace | — | skipped | g0084 |
| 4 | `<!--` | — | the attribute ends; the open tag reports the HTML-comment error | g0049 |
| 5 | `=` | — | the value begins after the `=` and after **all** whitespace that follows it, newlines included ([E1](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode), [E2](#the-parser-grammar-expression-boundaries-e2-attribute-value-concise-mode)) | g0085 |
| 6 | `:=` | — | as row 5; the value is bound | g0086 |
| 7 | `...` | — | a spread value begins immediately after the third dot, with **no** whitespace skipped ([E3](#the-parser-grammar-expression-boundaries-e3-spread-attribute)) | g0087 g0088 |
| 8 | `(` | — | attribute arguments (E4) | g0089 |
| 9 | `<` | a name has just been read, or an `async` is pending | method type parameters (E16) | g0090 g0091 |
| 10 | `{` | arguments have been read | the method body (E5) | g0092 |
| 11 | `</` | nothing read yet | `A close tag was found before the "<tag>" open tag was closed. …` | g0093 |
| 12 | `<` | nothing read yet | `Invalid attribute name. Attribute name cannot begin with the "<" character.` | g0094 |
| 13 | any other | nothing read yet | the name begins at this character ([Attribute names](#the-parser-grammar-attributes-attribute-names)) | g0010 |
| 14 | any other | something read | the attribute ends; the open tag continues at this character | g0053 |

What the row order means for some inputs:

| Input | Result | Probes |
| --- | --- | --- |
| `<div x = 1/>`, `<div x\n  =1/>` | `x` with the value `1`: after a name, whitespace is skipped and the `=` still attaches | g0710 g0711 |
| `<foo x (a)/>` | `x` with arguments | g0712 |
| `<foo x <T>(a) {b}/>` | a method named `x` | g0713 |
| concise `div x\n  =1` | the attribute `x`, then a child: an unnamed tag with the default value `1` (row 1) | g0714 |
| concise `div x =1` | `x` with the value `1` | g0715 |
| `<div x /*d*/ = :a/>` | the name `x`, an open-tag comment, then a default attribute with the value `:a`: a comment is row 14 | g0716 |
| `<div a ...b/>` | the name `a`, then a spread `b` | g0717 |
| `<div a(b)=c/>` | the name, the arguments and the value `c` | g0718 |
| `<if=x/>`, `<if:=x/>`, `<foo(a) { b }/>` | the default attribute: a zero-width name range, then the value or method | g0011 g0719 g0120 |
| `<div a(b)(c)/>` | `An attribute can only have one set of arguments` | g0099 |

After each part is read (`ATTRIBUTE.return`):

| Part | Result | Probes |
| --- | --- | --- |
| name | first, a name that is exactly `async`, read first in its attribute, may be held back (below). Otherwise a `::` anywhere in the name's range is the reserved-token error and the parse stops (`rejectReservedName`; `<div ::b/>` and `<div a::b/>` are the error, observed; stock reports the names). Otherwise the name is reported, unless an `async` is pending, and in HTML mode the ambiguous-`>` check runs ([below](#the-parser-grammar-attributes-the-ambiguous-check)) | g0095 g0096 g0097 g0098 |
| arguments | if the attribute already has arguments: `An attribute can only have one set of arguments`. Otherwise, if `{` follows, after any whitespace **including newlines in both modes**, the attribute is a method and the arguments are its parameters. Otherwise, if type parameters were read: `An attribute cannot have both type parameters and arguments`. Otherwise the arguments are reported as attribute arguments | g0099 g0100 g0101 g0102 g0089 |
| method body | the method is reported; the attribute ends | g0103 |
| type parameters | `(` **must** follow, after any whitespace; otherwise `Attribute cannot contain type parameters unless it is a shorthand method` | g0104 g0105 |
| value | an empty value is `Missing value for attribute`. In HTML mode the ambiguous-`>` check runs. The value (or spread) is reported; the attribute ends | g0106 g0107 g0108 g0087 |

**`async` methods** (`isAsyncMethodPrefix`, `flushPendingAsync`): how a
leading `async` is read.

| Input | Result | Probes |
| --- | --- | --- |
| `<div async onClick(a) {x}/>` | the method `onClick`, with `async` as its modifier | g0720 |
| `<div async(a) {b}/>`, `<div async <T>(a) {b}/>` | a default method (empty name) | g0721 g0091 |
| `<div async x/>` | the names `async` and `x` | g0722 |
| `<div async(1)/>` | the attribute `async` with arguments | g0723 |
| `<div async/>`, `<div async=1/>` | the attribute `async` | g0724 g0725 |
| concise `div async\tonClick(a) {x}` | the method `onClick`: a tab is skipped | g0726 |
| concise `div async\n  onClick(a) {x}` | the attribute `async`, then a child tag: a newline is not skipped | g0727 |

The attribute forms:

| Form | Syntax | Parser note | Probes |
| --- | --- | --- | --- |
| Boolean | `disabled` | a name with no value; **no value event** | g0109 |
| Value | `value=expr`, `class="card"` | a quoted string is not a separate form: it is an expression whose first token is a string (`<div a="1"b="2"/>` is one value, observed) | g0110 g0111 |
| Bound | `value:=count` | row 6. The space decides: `x:=1` is a bound `x`; `x: =1` is the name `x:` with the value `1` (observed; spec §4 "`:modifier`") | g0112 g0113 g0114 |
| Spread | `...expr` | row 7 | g0115 |
| Arguments | `onClick(a)` | row 8 | g0116 |
| Method | `onClick(a) { … }`, `onClick<T>(a) { … }`, `async onClick(a) { … }` | rows 8–10 | g0117 g0017 g0118 |
| Default | `=expr`, `(a) { … }` after tag arguments | zero-width name | g0119 g0120 |
| Sugar | `#x`, `.x`, `:x` | at this level an attribute whose **name** is `#x`, `.x` or `:x` ([Dialect rules](#the-parser-grammar-dialect-rules)) | g0121 |

| Input | Result | Probes |
| --- | --- | --- |
| `<div class:x=1/>` | the name `class:x`: a `:` inside a name does not split it (see [Status](#the-parser-grammar-status-sources-of-truth-and-method) for the modifier split) | g0658 |
| `<input value:fn:=x/>` | the name `value:fn`, bound | g0660 |

### Attribute names

A name is an `EXPRESSION` position with the flag `terminatedByWhitespace`
(`ATTRIBUTE.parse`, row 13; [Inventory](#the-parser-grammar-expression-boundaries-inventory-of-positions)), scanned by
[How a position is scanned](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned). Its hard stops:

| Mode | Hard stops | Source | Probes |
| --- | --- | --- | --- |
| HTML | `,` `=` `(` `>` `<`; `:` when the next character is `=`; `/` when the next character is `>` | `shouldTerminateHtmlAttrName` | g0122 g0086 g0010 g0123 |
| Concise | `,` `=` `(` `;` `<`; `:` when the next character is `=`; `-` when the next character is `-` **and** the previous character is whitespace, ASCII or Unicode (decision 156, addendum 12) | `shouldTerminateConciseAttrName` | g0124 g0125 g0126 g0127 g1681 |
| Concise, inside `[ … ]` | `,` `=` `(` `]` `<`; `:` when the next character is `=` | `shouldTerminateConciseGroupedAttrName` | g0128 g0129 g0130 g0131 |

| Input | Result | Probes |
| --- | --- | --- |
| `<div a b/>`, `<div a\n b/>` | two names: whitespace and a newline end a name | g0053 g0728 |
| `<div a[b c]/>`, `<div {a b}/>`, `<div a"b c"/>` | one name each: no stop is examined inside a group or a string | g0729 g0730 g0731 |
| `<div a/ b/>` | one name `a/ b`: the `/` follows a word character, so it is a division, which consumes the whitespace after it | g0732 |
| `<div a: b/>`, `<div a? b/>` | the names `a:` and `b`, `a?` and `b`: with no `operators` flag, `:` and `?` consume nothing | g0733 g0734 |
| `<div a)/>` | `Mismatched group. …` | g0735 |
| concise `div a[b]=1` | the name `a[b]` | g0736 |
| `<div a/b/>` | the name `a/b`: a lone `/` is no HTML stop | g0737 |
| concise `div [a;b]` | the name `a;b`: `;` is no stop inside `[ … ]` | g0738 |

### The ambiguous `>` check

`detectAmbiguousCloseAngleBracket` runs in HTML mode after an attribute name
and after an attribute value that ended at a space or tab followed, on the
same line, by `>`. From that `>` it scans on by the table below. It reports
`Ambiguous ">" in attribute. …` when the scan reaches a later top-level `>`
not followed by `=`, or a top-level `/>`, that is preceded by an operand;
otherwise the first `>` ends the tag.

| # | Character | Effect | Probes |
| --- | --- | --- | --- |
| 1 | `>=` anywhere; `>` inside `(…)` or `[…]` | a comparison; scanning continues | g0132 g0133 g0134 |
| 2 | word character | an operand; but if an operand already ended at a space or tab and no operator has been seen since, **no error** | g0135 g0136 |
| 3 | space, tab | marks the previous operand as ended | g0136 |
| 4 | `=>`; `/` preceded (ignoring spaces and tabs) by a word character, `)` or `]`; `(` `[`; a matched `)` `]`; `&` `*` `^` `:` `!` `-` `%` `.` `\|` `+` `?` `~` | connects operands; scanning continues | g0137 g0138 g0139 g0140 |
| 5 | end of input | **no error** | g0141 |
| 6 | anything else: a newline, `<`, a quote, a backtick, `{`, `}`, `,`, `;`, a bare `=`, an unmatched `)` or `]`, a `/` not preceded by an operand | **no error** | g0142 g0143 g0144 g0145 |

| Input | Result | Probes |
| --- | --- | --- |
| `<div x=a > b/>`, `<div x=a > b>`, `<div x=a >b/>`, `<div a > b>` | the error | g0135 g0616 g0739 g0740 |
| `<div x=a > b</div>` | the value `a`, the end of the open tag, and the body text ` b` | g0143 |
| concise `div x=a > b` | one value: the check does not run in concise mode | g0264 |

Whether the TypeScript-aware boundary keeps this check is OQ 8.

## Tag arguments, tag variables, tag parameters and types

Each of these begins at row 14 of [The open tag](#the-parser-grammar-tags-the-open-tag); the positions
are E6, E7, E9, E14 to E17 below.

| Form | Result | Probes |
| --- | --- | --- |
| tag arguments `<Tag(expr)>` ([E6](#the-parser-grammar-expression-boundaries-e6-tag-arguments)) | arguments, and attributes may follow them at this level: `<foo(a) b=1/>` | g0741 |
| tag-level default method `<Tag(a) { … }>` ([E17](#the-parser-grammar-expression-boundaries-e17-tag-level-default-method)) | tag arguments followed by `{` are the parameters of the default attribute's method | g0120 |
| tag variable `<Tag/x>` ([E9](#the-parser-grammar-expression-boundaries-e9-tag-variable)) | a value written after it with `=` is the tag's default attribute: `<let/x = 1/>` is the variable `x` and the default value `1` | g0742 |
| tag parameters `<Tag\|a, b\|>` ([E7](#the-parser-grammar-expression-boundaries-e7-tag-parameters)) | the parameters; empty pipes are accepted | g0743 g0744 |
| tag type arguments `<Tag<A, B>>` ([E14](#the-parser-grammar-expression-boundaries-e14-tag-type-arguments)) | the list directly after the name | g0745 |
| tag type parameters `<Tag <A, B>\|x\|>` ([E15](#the-parser-grammar-expression-boundaries-e15-tag-type-parameters)) | the list after whitespace, before parameters | g0746 |
| attribute-method type parameters ([E16](#the-parser-grammar-expression-boundaries-e16-attribute-method-type-parameters)) | `<div onClick<T>(a) { … }>` | g0017 |

That a tag must not have both arguments and plain attributes is not a parser
rule (see [Status](#the-parser-grammar-status-sources-of-truth-and-method); decision 109). Spec §8
"Tag params" gives the parameters' meaning.

## Attribute tags

| Input | Result | Probes |
| --- | --- | --- |
| `<div><@svg:rect/></div>` | the tag name `@svg:rect`: `<@name>` is an ordinary tag to the parser | g0661 |

What an attribute tag means is decided after the parse: its name is a property
key, so the `:` split does not apply (decision 146, addendum 3; spec §4 "Name
sugar", "Attribute tags"); attribute-position sugar on it does apply; placement
and collision rules are in spec §8 "Collisions and placement"; an attribute tag
on a native element is rejected (spec §8 "Deferred to MX 2").

## Placeholders

`${expr}` interpolates escaped and `$!{expr}` interpolates raw (spec §3
"Interpolation"); the value is position [E8](#the-parser-grammar-expression-boundaries-e8-placeholder)
(`checkForPlaceholder`).

| Input | Result | Probes |
| --- | --- | --- |
| `<p>${a} $!{b}</p>` | two placeholders in HTML content, the second unescaped | g0747 |
| `<script>${a}</script>`, `<script>"${a}"</script>` | a placeholder in a text body, and inside a quoted string of one | g0748 g0749 |
| `<script>${:a}</script>` | the atom `a`: a placeholder lexes atoms in a text body too (decision 156, addendum 2) | g0750 |
| ``<script>`${:a}`</script>`` | text only: a template literal in a text body is text, so its `${…}` is no placeholder | g0751 |
| `<p>\${a}</p>` | the text `${a}`: an odd run of backslashes before the `$` makes it literal | g0752 |
| `<p>\\${a}</p>` | the text `\` and the placeholder `a`: an even run keeps half as text | g0753 |
| `<p>${}</p>` | `Invalid placeholder, the expression cannot be missing` | g0190 |
| `<p>${ }</p>` | a placeholder whose value is the space | g0754 |
| `<div x=$!{a}/>` | the value text `$!{a}`: in an attribute value `$` is a word character and `{…}` a group (OQ 12) | g0755 |
| concise `${x} a=1` | a tag whose name is the interpolation, with an attribute (spec §3 "A bare `${expr}` line") | g0756 |
| concise `div ${x}` | an attribute name `${x}`: no placeholder in an open tag | g0757 |

## Scriptlets and statement tags

**Scriptlets** `$ statement` and `$ { … }` are position
[E11](#the-parser-grammar-expression-boundaries-e11-scriptlets) and are rejected on every host (spec §3 "Scriptlets").

**Statement tags** are position [E10](#the-parser-grammar-expression-boundaries-e10-statement-tags). A tag is a
statement tag when its name is in **the supplied statement set**: when the
consumer's `onOpenTagName` returns `TagType.statement` (`TAG_NAME.exit`).

| Input | Supplied statement set | Result | Probes |
| --- | --- | --- | --- |
| `static const a = 1` | holds `static` | a statement tag: the name, then the open tag's end where the statement ends | g0758 |
| `static const a = 1` | empty | the tag `static` with the attributes `const` and `a`, the second with the value `1` | g0759 |

The sets are the AST catalogue's ([ast.md §3.10](/architecture/ast/),
"Statement keywords per target"; decision 163, addendum 3): the language's
`import`, `export`, `static`, `server`, `client` and `class`; on the data
target `import`, `static`, `export`; and today an empty set on the hosts and
`parseFragment` callers that MX1 TODO
`statement-tags-not-declared-on-five-hosts` names.

## Text, comments, CDATA, doctype, declarations and text bodies

### HTML content

`HTML_CONTENT.parse`, first matching row:

| # | At | Result | Probes |
| --- | --- | --- | --- |
| 1 | newline | ends a mixed-mode region or a delimited block when their rules say so; otherwise text | g0146 g0147 |
| 2 | `<![CDATA[` | a CDATA section, to the next `]]>` | g0148 |
| 3 | `<!--` | an HTML comment, to the next `->` (`HTML_COMMENT.parse` looks for a `-` directly followed by `>`, so `<!-- a -> b -->` ends after `a ->`, observed) | g0149 g0150 |
| 4 | `<!` | a doctype, to the next `>` | g0151 |
| 5 | `<?` | a declaration, to the next `>`; a `?` directly before that `>` is part of the closer | g0152 g0153 |
| 6 | `</` | a close tag | g0154 g0155 |
| 7 | `<` followed by `>`, `<` or whitespace | text | g0156 |
| 8 | `<` followed by anything else | an open tag | g0157 |
| 9 | `$` followed by whitespace, with only whitespace between it and the previous newline | a scriptlet (E11) | g0158 g0159 |
| 10 | `//` or `/*`, when the character before it is ASCII whitespace (as upstream; a Unicode space does not count here, decision 156, addendum 13, which withdrew addendum 11 at this site) | a JavaScript comment: `//` to the end of the line, `/* */` to its end | g0160 g0161 g0162 g1682 g1689 g1690 |
| 11 | `${`, `$!{`, or backslashes before one | a placeholder or escaped placeholder | g0163 |
| 12 | anything else | text | g0164 |

| Input | Result | Probes |
| --- | --- | --- |
| `<p>a // b\n</p>` | the text `a ` and a comment to the end of the line (row 10) | g0760 |
| `<p>a\u00a0// b\n</p>` (U+00A0 before `//`) | text only, `a\u00a0// b\n`: no comment, as upstream and Marko (row 10; decision 156, addendum 13) | g1682 g0760 |
| `<p>Visit\u00a0//cdn.example/x.js</p>` | text; the tag closes (the reading alpha.7 and alpha.8 got wrong: a comment that swallowed `</p>`) | g1689 |
| `<p>a\u00a0/* b */ c</p>` | text only: no comment | g1690 |
| `<p>http://x</p>` | text: no whitespace before the `//` | g0761 |

CDATA sections and declarations parse to events and are rejected in lowering
(spec §3 "CDATA sections and XML declarations").

### Text bodies

A **text body** is the body of a tag the consumer typed `TagType.text`. In this
repository the consumer's set is `html-comment`, `html-script`, `html-style`,
`script`, `style`, `textarea` (`TEXT` in
`packages/core/src/close-tag-opener.ts`). `PARSED_TEXT_CONTENT.parse`:

| # | At | Result | Probes |
| --- | --- | --- | --- |
| 1 | newline | ends a delimited block when its rules say so; otherwise text | g0165 g0166 |
| 2 | `<` | in HTML mode, `</>` or `</name>` with exactly the open tag's written name ends the body (`checkForClosingTag`); any other `<` is text | g0026 g0167 g0168 |
| 3 | `//` | text, to the end of the line or, in HTML mode, to the body's close tag (concise `script -- // a</script> b` is the one text `// a</script> b`, observed) | g0169 g0170 |
| 4 | `/*` | text, to `*/`; unterminated is `EOF reached while parsing multi-line JavaScript comment` | g0171 g0172 |
| 5 | a backtick | a template literal, lexed as in an expression, `${…}` included | g0173 |
| 6 | `"` or `'` | a string to the **next** same quote, within which placeholders are recognised; unterminated is `EOF reached while parsing string expression`. A backslash does **not** escape the quote: `PARSED_STRING.parse` treats `\` only as a possible placeholder escape, so `"a\"b"` ends after `a\"` | g0174 g0175 g0176 |
| 7 | `${`, `$!{`, or backslashes before one | a placeholder or escaped placeholder | g0177 |
| 8 | anything else | text | g0178 |

| Input | Result | Probes |
| --- | --- | --- |
| `<script>a ${x} <b></script>` | the placeholder `x` and the text ` <b>` | g0762 |
| `<textarea>don't</textarea>` | `EOF reached while parsing string expression`: a quote must be balanced | g0763 |
| `<script>var s = "a\"b";</script>`, `<script>var s = 'it\'s';</script>` | the same error for valid JavaScript (row 6; OQ 13). TODO `text-body-string-backslash-escape` | g0176 g0764 |

Spec §3 "CDATA sections and XML declarations" describes a raw-text body as "a
single `MarkoText`" and lists `<title>` among them; both differ from the rows
above (OQ 13).

## Concise mode: indentation and line rules

`CONCISE_HTML_CONTENT.parse` takes a line's leading whitespace as its
indentation and then acts on the first other character:

| # | Step | Result | Probes |
| --- | --- | --- | --- |
| 1 | the line's indentation is compared, by length, with each open tag's | a tag indented as much or more is closed: `div\n  span\np` | g0765 |
| 2 | no tag remains open and the line is indented | `Line has extra indentation at the beginning`, unless its first character is `/` | g0767 g0768 |
| 3 | the enclosing tag is a text tag and the first character is not `-` | `A line within a tag that only allows text content must begin with a "-" character` | g0769 |
| 4 | a child line whose indentation string differs from the tag's first child line | `Line indentation does match indentation of previous line` | g0770 g0766 |
| 5 | otherwise | the first character selects a row of the next table | g0771 |

| First character | Result | Probes |
| --- | --- | --- |
| `<` | an HTML region (mixed mode) | g0179 |
| `$` followed by whitespace | a scriptlet (E11) | g0180 |
| `--` | a delimited block (E12) | g0181 |
| `-` not followed by `-` | `A line in concise mode cannot start with a single hyphen. Use "--" instead. …` | g0182 |
| `//`, `/*` | a JavaScript comment. After a `/* */` comment only whitespace may follow on the line, otherwise `In concise mode a javascript comment block can only be followed by whitespace characters and a newline.` | g0183 g0184 g0185 |
| `/` followed by anything else | `A line in concise mode cannot start with "/" unless it starts a "//" or "/*" comment` | g0186 |
| anything else | an open tag; `$foo` is therefore a tag | g0057 g0187 |

| Input | Result | Probes |
| --- | --- | --- |
| `script\n  - foo` | the single-hyphen error | g0772 |
| `script\n  -- foo` | the text `foo` | g0773 |

The open tag's concise-mode rows are in [The open tag](#the-parser-grammar-tags-the-open-tag); a value
that reaches the end of a line is [E2](#the-parser-grammar-expression-boundaries-e2-attribute-value-concise-mode).
Spec §3 "Concise mode" says these rules are inherited from Marko and fixed by
no MX decision.

## Whitespace at the parser level

The template parser reports text as raw source ranges (`htmlEOF`,
`handleDelimitedBlockEOL`):

| Input | Text ranges reported | Probes |
| --- | --- | --- |
| `<p>\n  $ x\n</p>` | `"\n  "` and `"\n"`: nothing is trimmed or collapsed | g0774 |
| concise `-- a\n\n` | `a`: at end of input in concise content the text stops before trailing newlines | g0775 |
| `div\n  --\n    a\n  --` | the block's indentation and the newline before the closing delimiter are outside the text | g0776 |
| `div -- a\nb`, `div --  a  \nb` | `a`; ` a  `: a single-line block's text starts after its hyphens and one more character and stops before the newline | g0777 g0778 |

The whitespace rules of spec §3 "Whitespace" (boundary trimming, dropping a
whitespace-only run that begins with a newline, collapsing runs to one space,
ignoring comments, the `preserveWhitespace` bypass) are applied by the consumer
of the parser's events, not by the parser. Today that is `@marko/compiler`'s
`onText`. When `@marko/compiler` is dropped (decision 158.2), the design
intent is that the MX layer taking its place applies them once (decision
158.3 puts the front end from parser events to the MX AST in
`@mxlang/parser`) and that core and hosts do not re-normalize (spec §3
"Whitespace"). This is a statement about consumers, not a parser rule.

## Base position for fragment parses

`parse(code, options?)` (`index.ts`, `Parser.parse`) takes an optional base
position for the case where `code` is a substring of a larger file:
`startOffset`, `startLine` (zero-based) and `startColumn` (zero-based)
(`ParseOptions`, `core/Parser.ts`). The source copy has this API; the patched
npm builds do not, so these probes run on the source copy.

| Input and base | Result | Probes |
| --- | --- | --- |
| `<a x=1/>` with `{ startOffset: 100, startLine: 4, startColumn: 7 }` | the events and their ranges are those of the plain parse (the value is `5-6`); `positionAt(0)` is line 4, character 7; `offsetAt(0)` is 100 | g0779 g0780 |
| `<a>\n<b/></a>` with the same base | `startColumn` applies to the first line: the position of the last offset is on line 5 at its plain column | g0781 |
| `<a x=(` with `{ startOffset: 50, startLine: 2, startColumn: 9 }` | the error range stays relative to `code` | g0782 |

Positions are UTF-16 code units. This is the base the AST catalogue's fragment
rule ([ast.md §5.3](/architecture/ast/)) builds on: the catalogue adds
`base.offset` to every reported range when it builds a node.

## Error conditions

The template parser's own messages:

| Condition | Message | Probes |
| --- | --- | --- |
| `=`, `:=` or `...` with no value | `Missing value for attribute` | g0106 g0188 g0189 |
| empty `${}` in content, in a tag name or in a template literal | `Invalid placeholder, the expression cannot be missing` | g0190 g0191 g0192 |
| `::` where atoms are lexed, or in the static text of a tag name, shorthand part or attribute name | `` `::name` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:name` for an atom `` with the written name ([Atoms](#the-parser-grammar-atoms)) | g0193 g0194 g0195 g0097 |

End of input inside a **position**
([End of input](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-end-of-input) has the rule and the silent cases); the message
depends on the state that owns the position:

| Condition | Message | Probes |
| --- | --- | --- |
| end of input in a position owned by an attribute with no name that is not a spread: an attribute name, a default value or default arguments, and the arguments after a pending `async` (`<div async(a`, observed) | `EOF reached while parsing attribute name for the "<tag>" tag` | g0196 g0197 g0198 |
| end of input in a position owned by a named attribute: its value, arguments, method type parameters or method body | `EOF reached while parsing attribute value for the "<name>" attribute` | g0199 g0200 g0201 g0202 |
| end of input in a spread | `EOF reached while parsing attribute value for the ... attribute` | g0203 |
| end of input in a tag name's or shorthand's `${…}` | `EOF reached while parsing tag name` | g0204 g0205 |
| end of input in a placeholder | `EOF reached while parsing placeholder` | g0206 |
| end of input in any other position | `EOF reached while parsing expression` | g0207 g0208 g0209 |

End of input in the opaque spans and outside a position, and the other
conditions:

| Condition | Message | Probes |
| --- | --- | --- |
| end of input after an attribute name and whitespace, HTML mode | `EOF reached while parsing attribute "<name>" for the "<tag>" tag` | g0210 |
| end of input in a string | `EOF reached while parsing string expression` | g0211 |
| end of input in a template literal's text | `EOF reached while parsing template string expression` | g0212 |
| end of input in a regular expression | `EOF reached while parsing regular expression` | g0213 |
| a newline in a regular expression | `EOL reached while parsing regular expression` (`REGULAR_EXPRESSION.parse`) | g0214 |
| end of input in a `/* */` comment | `EOF reached while parsing multi-line JavaScript comment` (`JS_COMMENT_BLOCK.parse`) | g0215 |
| end of input in a CDATA section, an HTML comment, a doctype, a declaration, a close tag | `EOF reached while parsing CDATA`, `… comment`, `… document type`, `… declaration`, `… closing tag` | g0216 g0217 g0218 g0219 g0220 |
| end of input in an HTML-mode open tag | `EOF reached while parsing open tag` | g0221 |
| end of input in a `[ … ]` group | `EOF reached while within an attribute group (e.g. "[ ... ]").` | g0222 |
| end of input with an HTML-mode tag open | `Missing ending "<tag>" tag` | g0223 |
| a closing bracket with no open group, or the wrong one | `Mismatched group. …` | g0224 g0225 |
| the ambiguous `>` | `Ambiguous ">" in attribute. …` | g0135 |
| `</` where an attribute name would begin | `A close tag was found before the "<tag>" open tag was closed. …` | g0093 |
| `<` where an attribute name would begin | `Invalid attribute name. Attribute name cannot begin with the "<" character.` | g0094 |
| a second argument list on an attribute | `An attribute can only have one set of arguments` | g0099 |
| type parameters on an attribute not followed by `(` | `Attribute cannot contain type parameters unless it is a shorthand method` | g0105 |
| type parameters and arguments with no method body | `An attribute cannot have both type parameters and arguments` | g0102 |
| a second argument list on a tag | `A tag can only have one argument` | g0226 |
| a second parameter list on a tag | `A tag can only specify parameters once` | g0227 |
| a type list that is not directly after the tag name and is not followed by `\|` or `(` under the conditions of [E15](#the-parser-grammar-expression-boundaries-e15-tag-type-parameters); type parameters whose `(…)` is not followed by `{` | `Unexpected types. Type arguments must directly follow a tag name and type paremeters must precede a method or tag parameters.` | g0228 g0229 g0230 |
| `/` after a tag name followed by whitespace or by an immediate hard stop | `A slash was found that was not followed by a variable name or lhs expression` | g0231 g0232 |
| a second `#id` shorthand | `Multiple shorthand ID parts are not allowed on the same tag` | g0233 |
| a statement tag in HTML mode | `The "<name>" tag is reserved and cannot be used as an HTML tag.` | g0234 |
| a statement tag under another tag | `"<name>" can only be used at the root of the template.` | g0235 |
| an HTML comment in an open tag | `An html comment cannot be used within an open tag. Use a JavaScript comment (// or /* */) instead.` | g0049 |
| code after `;` on a concise line | `A semicolon indicates the end of a line. Only comments may follow it.` | g0236 |
| a lone `-` where a concise attribute would begin | `"-" not allowed as first character of attribute name` | g0037 |
| `--` inside `[ … ]` at an attribute start | `Attribute group was not properly ended` | g0038 |
| `[` inside `[ … ]`; `]` outside one | `Unexpected "[" character within open tag.`; `Unexpected "]" character within open tag.` | g0041 g0043 |
| a close tag with no open tag | `The closing "<name>" tag was not expected` | g0237 |
| a close tag naming another tag | `The closing "<x>" tag does not match the corresponding opening "<y>" tag` | g0238 |
| the concise line errors | the five messages in [Concise mode](#the-parser-grammar-concise-mode-indentation-and-line-rules) | g0182 g0186 g0185 g0239 |
| text after a closing block delimiter | `A concise mode closing block delimiter can only be followed by whitespace.` | g0240 |

Rejections raised **outside** the template parser, by core: scriptlets, CDATA
and declarations (spec §3); a second `:` in a tag head, a bare `:` in attribute
position, a `:name` that is not an identifier (divergence rows; spec §4 "Name
sugar"); sugar after a default value (decision 151, ruling 2; spec §4 "Name
sugar", "Left alone"), except after a single-atom default value (decision 146,
addendum 5); duplicate attributes, a warning with the last occurrence winning
(decision 135); the atom misuses of spec §4 "Atoms". The catalogue's list of
front-end codes is [ast.md §3.13](/architecture/ast/).

## Expression boundaries

A place where a TypeScript expression, statement list, type list or pattern
appears in MX source is one run of the parser's `EXPRESSION` state. This
section gives the scan they share, then the inventory of positions, then each
position.

### How a position is scanned

A position is created with a start offset, a stop function `shouldTerminate`,
and flags (`EXPRESSION.enter`). This table says where each flag is read; the
rules themselves are the rows it points to.

| Flag | Read by |
| --- | --- |
| `operators` | step 4 below (the operator exemption); the `?`, `:`, `=` and non-type `<` rows of the character table; step 1 of [the continuation test](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-the-continuation-test) |
| `terminatedByWhitespace` | steps 1 and 3 below |
| `terminatedByEOL` | step 1 below; steps 3 and 4 of the continuation test; [End of input](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-end-of-input) |
| `consumeIndentedContent` | step 1 below |
| `inType` | the reads listed in [The type context](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-the-type-context) |
| `forceType` | the `=` and `{` rows of the character table |
| `atoms` | the `:` row of the character table ([Atoms](#the-parser-grammar-atoms)); `EXPRESSION.return`, which records where a regular expression ended and each comment for the atom look-behind; `TEMPLATE_STRING.parse`, which copies the flag to a `${…}` |
| `attrValue` | the `?` row of the character table and the `:` and `.` rows of the look-ahead table ([E1](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode)); `ATTRIBUTE.parse`, which sets `defaultAtom` to its negation |
| `defaultAtom` | `isSingleAtomDefault`, for the look-ahead's `:` row ([E1](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode)) |

State the position keeps as it scans:

| State | Written by | Read by |
| --- | --- | --- |
| the group stack (depth) | the opening and closing bracket rows | steps 1, 3 and 4; the `?`, `:`, `=` and non-type `<` rows; the closing-bracket rows; end of input; the look-ahead's keyword row. `EXPRESSION.parse` step 1 and `EXPRESSION.return` also read it to set `hadUnguardedNewline` |
| `ternaryDepth` | the `?` row and the `:` row | the `:` row; the look-ahead's `:` row; the look-ahead's keyword row ([Ternary depth](#the-parser-grammar-dialect-rules-ternary-depth)) |
| `wasComment` | set when a `//` comment has just been read, cleared when a newline is passed | step 1 |
| `atomEnd`, where the last atom lexed in the position ends | `lexAtom` | `lookBehindForKeyword`, `isOperatorWord`, `isSingleAtomDefault` |
| the comments read so far; where the last regular expression ended | `EXPRESSION.return`, with `atoms` | `expectsExpression` |
| `hadUnguardedNewline` | step 1; `EXPRESSION.return` | `util/validators.ts`, which is outside this document |

`EXPRESSION.parse`, for each character:

| # | Character | Result | Probes |
| --- | --- | --- | --- |
| 1 | a newline (`\n`, `\r` or `\r\n`) | the value **ends before the newline** when all of these hold: depth is 0; the position has `terminatedByEOL` or `terminatedByWhitespace`; a `//` comment was just read (`wasComment`) or the continuation test fails for this newline; and it is not the case that the position has `consumeIndentedContent` and the next character is a space or tab. Otherwise the newline is consumed | g0307 g0442 g0443 g0290 g0499 g0783 |
| 2 | a word character | consumed | g0784 |
| 3 | whitespace at depth 0, in a position with `terminatedByWhitespace` | the value ends before it unless the continuation test succeeds | g0339 g0785 g0786 g0787 |
| 4 | a hard stop at depth 0 | the value ends before it. Exemption, in a position with `operators`: when the value so far has a non-whitespace character and the last one is an operator by the look-behind table, the stop is ignored and row 5 applies | g0415 g0788 g0789 g0790 |
| 5 | any other | the character table below | g0268 |

| Character | Effect | Probes |
| --- | --- | --- |
| `"`, `'` | a string, to the same quote; `\` escapes one character | g0241 |
| backtick | a template literal, to the closing backtick; `\` escapes one character; each `${` opens a nested position with the hard stop `}`, no flags but `atoms`, which it copies from the position the template literal is in (`TEMPLATE_STRING.parse`) | g0242 |
| `?` | first, with `operators` and `attrValue` at depth 0: when the next character is `?`, or is `.` not followed by a digit, both characters are consumed and nothing else happens ([E1 overrides](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode)). Otherwise, with `operators` at depth 0: `ternaryDepth` + 1, then **all whitespace after it is consumed, newlines included**. Otherwise a plain character | g0243 g0244 g0245 |
| `:` | first, with `atoms`, at any depth: `lexAtom` may consume it as `::` (the reserved-token error, which stops the parse) or as the start of an atom, in which case the atom is consumed and nothing else happens ([Atoms](#the-parser-grammar-atoms)). Otherwise, with `operators` at depth 0: if `ternaryDepth` > 0 it is decremented, otherwise the type context is entered (`inType`); then all whitespace after it is consumed. Otherwise a plain character | g0246 g0247 g0248 g0249 |
| `=` | with `operators`, at any depth: if the next character is `>` (an arrow), the type context is left when `inType` is set, `forceType` is not, and the previous non-whitespace character is not `)`; both characters are consumed. If the next character is not `>`, the type context is left unless `forceType` is set or a group is open. Then all whitespace after it is consumed. Without `operators` a plain character | g0250 g0251 g0252 g0253 |
| `/` | `//` is a comment to the end of the line; `/*` is a comment to `*/`. Otherwise it is a **division** when the previous non-whitespace character is a word character or one of backtick, `'`, `"`, `%`, `)`, `.`, `<`, `]`, `}`: it is consumed with all whitespace after it. Otherwise it starts a **regular expression**, which runs to the next `/` that is not escaped and not inside `[…]`. This row does not depend on `operators` or on depth | g0254 g0255 g0256 g0257 |
| `(`, `[` | opens a group | g0258 |
| `{` | opens a group. Before that, when `inType` is set and `forceType` is not, the type context is left unless the previous non-whitespace character is an operator by the look-behind table | g0259 g0260 |
| `<` | in a type context: opens a group that closes with `>`. Otherwise, with `operators` at depth 0, it is consumed with all whitespace after it. Otherwise a plain character | g0261 g0262 g0263 |
| `>` | a plain character when the position is not in a type context, or when the previous character is `=`. Otherwise it is a closing bracket | g0264 g0265 g0266 |
| `)`, `]`, `}`, and `>` as a closing bracket | closes the innermost group. With no open group, or when the innermost group expects a different closer, the error `Mismatched group. …` | g0267 g0224 g0225 |
| any other | consumed | g0268 |

Source: `EXPRESSION.parse`; `canFollowDivision` for the division test. What the
steps and the character table mean together, for some inputs:

| Case | Result | Probes |
| --- | --- | --- |
| a position with no flags | `?`, `:`, `=`, `<` and `>` are plain characters: `<div x(a ? b : c = d < e > f)/>` is one argument list | g0791 |
| inside a group | steps 1, 3 and 4 do not apply, and `?`, `:` and `as` do not touch the ternary counter or the type context: `<div x=(a as number > b)/>` is one value | g0792 g0793 |
| an atom inside groups | lexed: atom lexing runs at any depth | g0794 |
| whitespace after `?`, `:`, `=` or a non-type `<`, with `operators` at depth 0 | consumed by that row, newlines included | g0795 g0250 g0262 |
| the same characters in an attribute name, which has no `operators` | nothing is consumed: `<div a: b/>`, `<div a? b/>` and concise `div a: b` are the names `a:`/`a?` and `b` | g0733 g0734 g0796 |
| whitespace after a division `/` | consumed in a position with or without `operators` | g0254 g0732 |
| whitespace after an atom | not consumed by the atom's `:` row: `<div x=:a b/>` is the value `:a` and the attribute `b` | g0797 |
| a string, a template literal's text, a regular expression, a comment | opaque: a hard stop inside one is not examined; a template literal's `${…}` is its own position | g0798 g0799 g0800 g0801 |

#### The continuation test

`checkForOperators`, called at a newline (step 1) and at whitespace (step 3)
of the scan, at depth 0:

| # | Step | Result | Probes |
| --- | --- | --- | --- |
| 1 | the position has no `operators` flag | **fail** | g0802 |
| 2 | look behind: the character immediately before the whitespace or newline is an operator by the look-behind table | **succeed**; the whitespace that follows is consumed, newlines included | g0803 g0290 |
| 3 | this is a newline, and the position has `terminatedByEOL` or the parser is in concise mode | **fail** | g0456 g0506 |
| 4 | find the next character: with `terminatedByEOL` or in concise mode spaces and tabs are skipped; otherwise all whitespace, newlines included | continue with that character | g0804 g0805 g0806 |
| 5 | that character is `<` followed by `/` in HTML mode, or `<!--` in either mode | **fail** | g0807 g0808 g0809 |
| 6 | the position's `shouldTerminate` returns true for that character | **fail** | g0810 g0811 |
| 7 | look ahead: that character is an operator by the look-ahead table | **succeed**, and scanning resumes where that table says; otherwise **fail** | g0785 g0339 |

**Look-behind table** (`lookBehindForOperator`). `c` is the character
immediately before the whitespace:

| `c` | Operator? | Probes |
| --- | --- | --- |
| `&` `*` `^` `:` `=` `<` `%` `\|` `?` `~` | yes | g0269 g0270 g0271 g0272 g0273 g0274 g0275 g0276 g0277 g0278 |
| `!` | Skip back over the whole run of `!`. Let `o` be the character before the run. **No** when `o` is `)`, `]`, `"`, `'` or a backtick. **No** when `o` is a word character and the word ending at `o` is neither a unary keyword (last row) nor `in` or `instanceof` as a whole word. **Yes** in every other case, which includes `o` = `}` and `typeof!` | g0279 g0280 g0281 g0282 g0283 g0284 |
| `>` | yes when the character before it is `=` (an arrow). Otherwise yes outside a type context and no inside one | g0285 g0286 g0287 |
| `.` | yes when the first non-whitespace character after the whitespace is a word character | g0288 g0289 |
| `+`, `-` | when the character before it is the same character (`++`, `--`): the answer is this table applied to the nearest non-whitespace character before the pair. Otherwise yes | g0290 g0291 g0292 g0293 g0294 g0295 g0296 g0297 |
| a lowercase letter | **no** when `c` is the last character of an atom (the position's `atomEnd`): `:new` and `:delete` are names, not keywords. Otherwise yes when a unary keyword ends at `c` as a whole word. Outside a type context the keywords are `async` `await` `class` `function` `new` `typeof` `delete` `void`; inside one they are `async` `await` `class` `function` `new` `typeof` `asserts` `infer` `is` `keyof` `readonly` `unique`. "Whole word" means the keyword starts at the first character of the value, or the character before it is neither a word character nor `.` | g0298 g0299 g0300 g0301 g0302 g0303 g0304 g0305 g0306 |
| anything else | no | g0307 g0308 g0309 |

| Input | Result | Probes |
| --- | --- | --- |
| concise `div x=:new\n  span` | the value `:new` and a child tag `span`: the atom check is in `lookBehindForKeyword`. Stock: the single value `:new\n  span` | g0298 |
| `<div x=:typeof />` | the value `:typeof` and a self-closed tag: the operator exemption uses the same table. Stock: the value `:typeof /`, then `Missing ending "div" tag` | g0608 |
| concise `div x=return\n  b`, `div x=throw\n  b`, `div x=yield\n  b` | the value ends at the newline: these words are in neither keyword list | g0308 g0812 g0813 |
| concise `div x=a /* c */\n  b` | the value ends at the newline: a `/` is not in the table | g0814 |

**Look-ahead table** (`lookAheadForOperator`). `n` is the next character found
in step 4:

| `n` | Operator? | Scanning resumes | Probes |
| --- | --- | --- | --- |
| `&` `*` `^` `!` `<` `%` `\|` `~` `+` `-` | yes | after `n` | g0310 g0311 g0312 g0313 g0314 g0315 g0316 g0317 g0318 g0319 |
| `/` `{` `(` `>` `?` `:` `=` | yes | at `n`, which the character table then handles | g0320 g0321 g0322 g0323 g0324 g0325 g0326 |
| `.` | yes when the first non-whitespace character after the `.` is a word character | at that word character | g0327 g0328 g0329 g0330 |
| a lowercase letter | yes when one of `as` `extends` `instanceof` `in` `satisfies` starts at `n`, is followed by a whitespace character, and the first non-whitespace character after that exists and is not `:` `,` `=` `/` `>` or `;` | at that character | g0331 g0332 g0333 g0334 g0335 g0336 g0337 g0338 |
| anything else | no | — | g0339 g0340 g0341 g0342 |

What `as` and `satisfies` do to the type context is read 7 of
[The type context](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-the-type-context). MX changes the `:` and `.` rows for an
attribute value ([E1 overrides](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode)).

| Input | Result | Probes |
| --- | --- | --- |
| concise `div x=a in\n  b` | one value: once `n` is found on the line, the keyword row skips the whitespace after the keyword, newlines included, and scanning resumes at the operand | g0445 |
| concise `div x=a instanceof\nB` | one value, the operand at column 0 | g0446 |
| concise `div x=a .\nspan` | one value: the `.` row does the same | g0447 |

Source: `checkForOperators`, `lookBehindForOperator`, `lookAheadForOperator`,
`lookBehindForKeyword`, and the keyword tables at the top of
`states/EXPRESSION.ts` (`unaryKeywords`, `jsUnaryKeywords`, `tsUnaryKeywords`,
`binaryKeywords`, `relationalKeywords`).

#### The type context

The type context is the flag `inType`.

| How it is entered | `forceType` | Probes |
| --- | --- | --- |
| a `:` at depth 0 with `ternaryDepth` 0, in a position with `operators`, that `lexAtom` has not consumed | not set | g0349 g0383 |
| an `as` or `satisfies` found by the look-ahead while the position is not in a type context | set when `ternaryDepth` is 0 | g0348 g0815 |
| the position's flags at creation: a type list (E14 to E16), a statement or scriptlet that begins with a type keyword (E10, E11) | set | g0391 g0816 |

Leaving it is the `=` and `{` rows of the character table (reads 5 and 6
below).

The reads of `inType`
(`grep -nE "\.inType\b" states/*.ts | grep -v "inType = "` lists them), with
an input on each side:

| # | Read by | In a type context | Outside one | Observed | Probes |
| --- | --- | --- | --- | --- | --- |
| 1 | the `<` row of the character table | opens a group that `>` closes, at any depth, with or without `operators`; no whitespace is consumed after it | with `operators` at depth 0 it is consumed with the whitespace after it; otherwise a plain character | `x=a as Map<K, V> y` is the value `a as Map<K, V>`; concise `div x=a<b, c> d` is the value `a<b` | g0261 g0343 |
| 2 | the `>` row of the character table | a closing bracket unless the previous character is `=`: it closes a `<` group, and is `Mismatched group` when no group is open or the innermost group expects another closer | a plain character | concise `div x=a as T > b` is the error; concise `div x=a > b` is one value | g0266 g0264 |
| 3 | the `>` row of the look-behind table | not an operator (an arrow's `>` still is) | an operator | concise `div x=a as T<U>\n  b` ends at the newline; `div x=f<T>\n  b` is one value | g0287 g0286 |
| 4 | the last row of the look-behind table: the unary keyword list | `async` `await` `class` `function` `new` `typeof` `asserts` `infer` `is` `keyof` `readonly` `unique` | `async` `await` `class` `function` `new` `typeof` `delete` `void` | concise `div x=a as keyof\n  T` is one value and `div x=a as void\n  b` ends at the newline; `div x=void\n  b` is one value and `div x=keyof\n  b` ends at the newline | g0302 g0303 g0300 g0301 |
| 5 | the `=` row, at `=>` | left, unless `forceType` is set or the previous non-whitespace character is `)` | nothing to leave | `<div x=a: b => c<d> e/>` is the value `a: b => c<d` and the `>` ends the tag; `<div x=a: (b) => c<d> e/>` is the value `a: (b) => c<d>` | g0344 g0345 |
| 6 | the `{` row | left, unless `forceType` is set or the previous non-whitespace character is a look-behind operator (reads 3 and 4 apply to that test) | nothing to leave | concise `div x=a: T {b}<c> d` is one value (left at `{`, so the `>` is an operator); `div x=a: keyof {b}<c> d` is the value `a: keyof {b}<c>` and the attribute `d` | g0260 g0346 |
| 7 | the look-ahead's keyword row, at `as` or `satisfies` | nothing changes: `forceType` is **not** set | the context is entered, and `forceType` set when `ternaryDepth` is 0 | concise `div x=a: T as U = b<c> d` is one value (the `=` leaves the context); `div x=a as U = b<c> d` is the value `a as U = b<c>` and the attribute `d` | g0347 g0348 |
| 8, 9 | the tag variable's two stop functions, at `<` (E9) | not a hard stop | a hard stop | `<let/x: Map<K,V> = 1/>` is the variable `x: Map<K,V>`; `<let/x<T>=1/>` is the `Unexpected types. …` error | g0349 g0350 g0351 g0352 |

Reads 3 and 4 are in the look-behind table. Its callers
(`grep -n "lookBehindForOperator(" states/EXPRESSION.ts`), each with an input
inside and outside a type context:

| Caller | In a type context | Outside one | Probes |
| --- | --- | --- | --- |
| the continuation test, step 2 | `div x=a as keyof\n  T` one value; `div x=a as void\n  b` ends at the newline | `div x=void\n  b` one value; `div x=keyof\n  b` ends at the newline | g0302 g0303 g0300 g0301 |
| the operator exemption (scan step 4) | `<div x=a as keyof, y/>` is the value `a as keyof,`; `<div x=a as void, y/>` is the value `a as void`; concise `div x=a as T<U> ,y=1` stops at the `,` | `<div x=void, y/>` is the value `void,`; concise `div x=f<T> ,y=1` is one value | g0817 g0818 g0819 g0820 g0666 |
| the `{` row of the character table (read 6) | `div x=a: keyof {b}<c> d` stays in the context | `div x=a: T {b}<c> d` leaves it | g0346 g0260 |
| the look-behind table's own `!` row | `div x=a as void!\n  b` ends at the newline | `div x=void!\n  b` one value | g0821 g0822 |
| the look-behind table's own `++`/`--` row | `div x=a as keyof++\n  b` one value; `div x=a as void++\n  b` ends at the newline | `div x=keyof++\n  b` ends at the newline; `div x=void++\n  b` one value | g0294 g0297 g0295 g0296 |

Which positions enter the type context, and which reads each can reach, is the
last column of [the inventory](#the-parser-grammar-expression-boundaries-inventory-of-positions).

Consequences:

| Input | Result | Why | Probes |
| --- | --- | --- | --- |
| `x=a as Map<K, V> y` | value `a as Map<K, V>` | `<` is a group in a type context | g0261 |
| `x=f<T>(y)` | value `f<T`; the `>` ends the tag | not a type context, so `>` is E1's hard stop. **Recorded defect**, [below](#the-parser-grammar-open-questions-for-the-language-lead-recorded-defects-in-the-default). TODO `html-value-generic-call-cut-at-gt` | g0353 |
| `x=a: T<K> = f<K>(y)` | value `a: T<K> = f<K` | the `=` leaves the context (no `forceType`), then as the row above | g0354 |
| `x=a as T = b y`, `x=a as T < b y` | one value up to `b` | `forceType`: the context never ends inside the value. In the second the look-ahead resumes after the `<`, so no group is opened | g0355 g0356 |
| `x=a as T {k: T} y=1` | value `a as T {k: T}`, then `y=1` | the look-ahead continues at `{`; with `forceType` the `{` does not leave the context | g0357 |
| `x=(a): T => a` | one value | the `:` enters the context; the arrow follows `T`, not `)`, so `=>` leaves it | g0358 |
| concise `div x=a as T > b` | `Mismatched group. A closing ">" character was found but it is not matched …` | concise mode has no `>` hard stop, the look-ahead continues at `>`, and in a type context `>` is a closing bracket with no open group. **Valid TypeScript that the default rejects** (OQ 24). TODO `concise-as-type-gt-mismatched-group` | g0266 |
| HTML `<div x=a as T > b/>` | `Ambiguous ">" in attribute. …` | the `>` is E1's hard stop; then [the ambiguous `>` check](#the-parser-grammar-attributes-the-ambiguous-check) | g0359 |
| `<div x=a as T ? (b < c) : d/>`, `<div x=a: T ? (b < c) : d/>` | `Mismatched group. A ")" character was found when ">" was expected.` | reads 1 and 2 apply at any depth: the context entered before the group makes the `<` inside it a group, which the `)` fails to close. With `>` it is the mirror message (`(b > c)`, `[b > c]`). `<div x=(a as T) ? (b < c) : d/>` is one value: an `as` inside a group does not enter the context. Valid TypeScript that the default rejects. **A recorded limit, TODO `as-satisfies-type-context-any-depth`**: no action before MX2's TypeScript-aware expression boundary | g0360 g0361 g0362 g0363 g0364 |
| `<div x=a as T ? b < c : d/>` | one value | at depth 0 the look-ahead resumes after the spaced `<`, so no group is opened | g0365 |

#### End of input

`EXPRESSION.parse`, after its loop:

| # | Condition | Result | Probes |
| --- | --- | --- | --- |
| 1 | depth is 0, and the parser is in concise mode or the position has `terminatedByEOL` | the value ends silently. Depth counts the groups opened inside the position, not the delimiter that opened it | g0823 g0368 g0824 |
| 2 | otherwise | an error, chosen by the state that owns the position (next table) | g0199 g0366 |

| Owner | Message | Probes |
| --- | --- | --- |
| an attribute with no name and not a spread | `EOF reached while parsing attribute name for the "<tag>" tag` | g0198 |
| any other attribute | `EOF reached while parsing attribute value for the "<name>" attribute` (`...` for a spread) | g0199 g0203 |
| a tag name | `EOF reached while parsing tag name` | g0204 |
| a placeholder | `EOF reached while parsing placeholder` | g0206 |
| anything else | `EOF reached while parsing expression` | g0207 |

Per position:

| Input | Mode | Result | Probes |
| --- | --- | --- | --- |
| `<div x=(a`, `div x=(a` | HTML, concise | the attribute-value error in both: rule 1 needs depth 0 | g0199 g0366 |
| `<div x` | HTML | the attribute-name error: the name is not yet recorded while it is being read | g0197 |
| `<div =(a` | HTML | the attribute-name error | g0198 |
| `<div ...(` | HTML | the attribute-value error with `...` | g0367 |
| `<div onClick(a` | HTML | the attribute-value error for `onClick`: arguments share the owner | g0200 |
| `<div(a` | HTML | `EOF reached while parsing expression` | g0207 |
| `div(a` | concise | **no error**; tag arguments `a` are reported. TODO `concise-eof-open-delimiter-silent` | g0368 |
| `-- ${a` | HTML block | the placeholder error | g0369 |
| `static const x = (` | concise | `EOF reached while parsing expression` | g0209 |
| `$ {a` | concise | **no error**; the scriptlet `a` is reported | g0370 |
| `<${a` | HTML | the tag-name error | g0204 |
| `<div ${a` | HTML | the attribute-name error: after a space, `${` begins an attribute name | g0371 |
| `<foo<A` | HTML | `EOF reached while parsing expression` | g0208 |
| `` div x=`a `` | concise | `EOF reached while parsing template string expression` (the template literal's own error) | g0372 |
| `<div async(a` | HTML | the attribute-name error: with `async` pending, the attribute has no name yet | g0196 |
| `div onClick(a) {b`, `div\|a`, `div<A`, `div (a` | concise | **no error**; the method, parameters, type arguments or tag arguments are reported | g0373 g0374 g0375 g0376 |
| `script -- ${b`, `textarea\n  -- ${a` | concise text body | **no error**; the placeholder is reported (compare `div\n  -- ${a`, an HTML-mode block: the placeholder error) | g0377 g0378 g0379 |
| `div.a${b` | concise | **no error, and no shorthand event**: only the tag `div` is reported. TODO `concise-eof-interpolation-drops-event` | g0380 |
| `${x` | concise | **no error and no event at all** | g0381 |
| ``span\n  div x=`${a`` | concise | **no error, and no value event**: the tags and the name `x` are reported | g0382 |

`div(a` and `$ {a` end silently because their `(` and `{` were consumed by the
owning state (`OPEN_TAG.parse`, `INLINE_SCRIPT.parse`) and are not on the
position's group stack. The rows that lose an event are **recorded defects**
([below](#the-parser-grammar-open-questions-for-the-language-lead-recorded-defects-in-the-default); OQ 19).

### Inventory of positions

The `enterState(STATE.EXPRESSION)` calls in the parser's source
(`grep -rn "enterState(STATE.EXPRESSION)" states util`; the one in
`util/validators.ts` is a validation helper for callers of the parser's API
and is not a place in a template). For each: the flags and hard stop it sets,
and how the position can enter [the type context](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-the-type-context) with the
reads of that section it can then reach.

| Call site | Flags | Hard stop | Position | Type context | Probes |
| --- | --- | --- | --- | --- | --- |
| `ATTRIBUTE.parse`, value branch | `operators`, `terminatedByWhitespace`, `atoms`; `attrValue` for a named attribute or a spread, `defaultAtom` otherwise | per mode, see E1/E2 | E1, E2, E3 | entered by `:` and by `as`/`satisfies`; reads 1 to 7 | g0383 g0287 |
| `ATTRIBUTE.parse`, name branch | `terminatedByWhitespace` | per mode | [attribute name](#the-parser-grammar-attributes-attribute-names) | not entered: `div a:keyof\n  b` is the name `a:keyof` and a child | g0384 |
| `ATTRIBUTE.parse`, `(` branch | `atoms` | `)` | E4, and the parameters of E5 | not entered: `>` after a `:` is a plain character | g0385 |
| `ATTRIBUTE.parse`, `{` branch | `atoms` | `}` | E5, and the body of E17 | not entered | g0386 |
| `ATTRIBUTE.parse`, `<` branch | `inType`, `forceType` | `>` | E16 | in it from creation; reads 1 and 2 | g0387 |
| `OPEN_TAG.parse`, `/` case | `operators`, `terminatedByWhitespace` | per mode | E9 | entered by `:` and by `as`/`satisfies`; reads 1 to 9 | g0388 g0349 g0825 |
| `OPEN_TAG.parse`, `(` case | `atoms` | `)` | E6, and the parameters of E17 | not entered | g0389 |
| `OPEN_TAG.parse`, `\|` case | none | `\|` | E7 | not entered | g0390 |
| `OPEN_TAG.parse`, `<` case | `inType`, `forceType` | `>` | E14, E15 | in it from creation; reads 1 and 2 | g0391 |
| `TAG_NAME.parse`, `${` branch | `atoms` | `}` | E13 | not entered | g0392 |
| `TAG_NAME.exit`, statement branch (`prepareStatement`) | `operators`, `terminatedByEOL`, `consumeIndentedContent`; `inType` and `forceType` after a type keyword | none | E10 | after a type keyword: in it from creation, reads 1 to 4 (`static type A = void\nB` ends at the newline, `static type A = keyof\nB` continues). Otherwise entered by `:`, reads 1 to 6 (`static const x: void\ndiv` ends at the newline, `static const x: keyof\ndiv` continues; `static x = void\nB` continues, `static x = keyof\nB` ends) | g0395 g0396 g0393 g0394 g0397 g0398 g0399 g0400 g0401 g0402 |
| `INLINE_SCRIPT.parse`, line form (`prepareScriptlet`) | `operators`, `terminatedByEOL`; `inType` and `forceType` after a type keyword | none | E11, line form | as the statement: `$ type A = void\n<b/>` ends at the newline; `$ let x: keyof\n<b/>` is one scriptlet and `$ let x: void\n<b/>` ends at the newline; `$ let x = void\n<b/>` is one scriptlet; `$ let x: (b > c)` is `Mismatched group` | g0405 g0406 g0403 g0404 g0407 g0408 g0409 g0410 |
| `INLINE_SCRIPT.parse`, block form | none | `}` | E11, block form | not entered | g0411 |
| `checkForPlaceholder` (`PLACEHOLDER.ts`) | `atoms` | `}` | E8 | not entered | g0412 |
| `TEMPLATE_STRING.parse`, `${` case | `atoms` when the position holding the template literal has it | `}` | a template literal's `${…}`, inside a position or a text body | not entered | g0413 g0414 |

The positions with the `atoms` flag are where atoms are lexed (decision 156,
addendum 2; the AST catalogue's table "Where the atom lexer runs",
[ast.md §4.3](/architecture/ast/)). An attribute's `(` branch opens one
position whether the attribute turns out to have arguments or to be a method,
so a method's parameters lex atoms too (decision 163, addendum 1). Tag
shorthands and tag names are read by `TAG_NAME.parse`, not by a position.

### E1 — Attribute value, HTML mode

The value starts after the `=` or `:=` and the whitespace that follows it
(`ATTRIBUTE.parse`, rows 5–6 of [Attributes](#the-parser-grammar-attributes)). Hard stops
(`shouldTerminateHtmlAttrValue`):

| Character | Stop when | Probes |
| --- | --- | --- |
| `,` | always | g0415 |
| `/` | the next character is `>` | g0416 g0417 |
| `>` | the first of these that applies: (1) it is the value's first character: **stop**; (2) the previous character is `=` (an arrow): **no stop**; (3) the previous character is whitespace **and** the next character is `=` (a spaced `>=`): **no stop**; (4) otherwise: **stop** | g0418 g0265 g0419 g0420 g0421 |

| Input | Result | Probes |
| --- | --- | --- |
| `<div x= :b/>` | the value starts at `:b` | g0534 |
| `<div x=>a/>` | `Missing value for attribute` (`>` rule 1) | g0826 |
| `<div x=a => b>c</div>` | the value `a => b` (rule 2) | g0827 |
| `<if=count >= 10>a</if>`, `<div x=a >= b>c</div>` | one value (rule 3) | g0828 g0829 |
| `<div x=a>= b>c</div>` | the value `a` and the body text `= b>c` (rule 4: no whitespace before the `>`) | g0830 |
| `<div x=a>b>c</div>` | the value `a` (rule 4) | g0831 |
| `<div x=a + ,b/>` | the single value `a + ,b`: the operator exemption (scan step 4) | g0788 |
| `<div x=a +/>`, `<div x=a ? />` | `EOF reached while parsing regular expression`: the exempted `/` starts a regular expression (OQ 17). TODO `operator-exemption-consumes-hard-stop` | g0832 g0833 |
| `<div x=async/>` | the value `async/`, then `Missing ending "div" tag`: an identifier spelled like a unary keyword is a look-behind operator (OQ 17, OQ 24). TODO `operator-exemption-consumes-hard-stop` | g0664 |
| `<div x=async, y=1/>` | the value `async,`, then `y=1` | g0665 |
| `<div x=a\n  + b/>`, `<div x=a\n\n  + b/>` | one value: in HTML mode the look-ahead crosses newlines | g0804 g0805 |
| `<div x=a\n  <span/>` | the single value `a\n  <span` | g0633 |
| `<div x=a // c\n  y=1/>` | the value `a // c`, then `y=1`: a `//` comment ends the value at the end of its line | g0834 |
| `<div x=a + // c\n b/>` | the value `a + // c`, then `b` | g0835 |
| `<div x=a\n  // c\n  y/>` | the value `a\n  // c`, then `y`: `/` is a look-ahead operator, so the comment line is drawn in | g0836 |
| `<div x=a /* c */ + b/>` | one value | g0837 |
| `<div x=a + /* c */ b/>` | the value `a + /* c */`, then the attribute `b`: the comment's closing `/` is no look-behind operator (OQ 24). TODO `value-block-comment-after-operator` | g0674 |
| `<div x=a  y/>` | the value `a` and the name `y`: the whitespace between belongs to neither | g0838 |
| `<div x=(a` | an error at end of input ([End of input](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-end-of-input)) | g0199 |

**Overrides (MX).** The after-value rule of divergence row "The parser
after-value rule" (decision 146, divergence 3, with addendum 6) and decision
146, addendum 5. Condition (c) of the `:` row is addendum 6: after whitespace,
"a `:` starts a new attribute only when it is followed by an identifier start,
or is bare before `>`, `/>`, a newline or the end of input".

| Where | Stock (informative, not probed) | MX | Probes |
| --- | --- | --- | --- |
| look-ahead, `n` = `:` | operator | **not** an operator when (a) `attrValue` is set, **or** `isSingleAtomDefault` holds: `defaultAtom` is set, the value's first character is `:`, the last atom lexed in it is the one that starts there, and only whitespace lies between that atom's end and `n`; and (b) `ternaryDepth` is 0; and (c) the character after the `:` is `A`–`Z`, `a`–`z`, `$` or `_`, or is `>`, `/>`, `\n`, `\r` or end of input (`isBareColonEnd`). Otherwise an operator, as stock | g0422 g0423 g0424 g0425 g0426 g0427 g0428 |
| look-ahead, `n` = `.` | operator when the first non-whitespace character after the `.` is a word character | with `attrValue`: **not** an operator when the character directly after the `.` is a word character other than a digit (`isNameStartAt`); otherwise as stock | g0429 g0430 g0328 g0327 |
| character table, `?` with `operators` at depth 0 | opens a ternary | with `attrValue`: when the next character is `?`, or is `.` not followed by a digit, both characters are consumed and no ternary opens | g0431 g0432 g0433 g0434 |

The first two rows are look-ahead rows, so they apply at step 7 of the
continuation test: after whitespace whose preceding character is not a
look-behind operator. On stock, which has no after-value rule, the inputs of
the next table are one value, apart from `x=a :` before `/>` (the
regular-expression error) and before `>` (`Mismatched group`).

| Input | Result | Probes |
| --- | --- | --- |
| `x=a :b` | the value `a` and an attribute named `:b` | g0422 |
| `x=a.b .c` | the value `a.b` and an attribute named `.c` | g0429 |
| `x=a \| :b` | one value, in which `:b` is an atom: the `\|` before the whitespace is a look-behind operator | g0839 |
| `x=a ? b :c` | one value: a `?` is open | g0424 |
| `x=a ? b : c :d` | splits at `:d` | g0840 |
| `<div x=a :/>`, `<div x=a :>` | the value `a` and an attribute named `:` | g0426 g0841 |
| `x=a : b`, `x=(a) : T => a` | one value: a space follows the colon | g0425 g0611 |
| `x=a . b`, `x=a .2xl` | one value | g0842 g0626 |
| `x=a ?? b :c`, `x=a ?.b :c` | split at `:c` (OQ 3) | g0431 g0432 |
| `x=a ?:b` | one value, in which `:b` is an atom: `?:` opens a ternary (OQ 3) | g0628 |
| `<div x=a\n  .b/>` | the split across a newline, in HTML mode | g0843 |
| `<div ...a :b/>`, `<div ...a .b/>` | a spread's value splits too (OQ 5) | g0844 g0845 |

The digit exclusion is OQ 4.

**Default attribute.** A value with no name has `attrValue` off (decision 151,
ruling 2; divergence row "The parser after-value rule"); core reports `:name`
after such a value as an error (spec §4 "Name sugar", "Left alone"). A default
value that is one single atom splits at ` :name` (decision 146, addendum 5).
On stock the inputs of this table are one value.

| Input | Result | Probes |
| --- | --- | --- |
| `<if=a .b>`, `<if=a :b>` | one value | g0327 g0428 |
| `<if=:a :b>`, `<if= :a :b>`, `<if=:a\n :b>`, concise `if=:a :b`, `<const/x=:a :b/>` | the value `:a` and an attribute named `:b` | g0423 g0846 g0847 g0848 g0849 |
| `<if=:a :b :c>` | the value `:a` and attributes `:b` and `:c` | g0850 |
| `<if=:a :>` | the value `:a` and an attribute named `:` | g0851 |
| `<if=:a .b>` | one value: addendum 5 covers `:` | g0630 |
| `<if=:a.b :c>`, `<if=:a + :b :c>`, `<if=(:a) :b>` | one value: the value is not one atom | g0852 g0853 g0854 |
| `<if=:a ? :b :c>` | one value: a `?` is open | g0855 |

### E2 — Attribute value, concise mode

The value starts as in E1. Hard stops:

| Where | Character | Stop when | Probes |
| --- | --- | --- | --- |
| outside `[ … ]` (`shouldTerminateConciseAttrValue`) | `,` | always | g0435 |
| | `;` | always | g0436 |
| | `-` | the next character is `-` **and** the previous character is whitespace, ASCII or Unicode (decision 156, addendum 12) | g0437 g0438 g0439 g1680 |
| inside `[ … ]` (`shouldTerminateConciseGroupedAttrValue`) | `,` | always | g0440 |
| | `]` | always | g0441 |

| Input | Result | Probes |
| --- | --- | --- |
| `div x=\n  a` | the value `a`: the whitespace after the `=` includes newlines | g0856 |
| `div x=a > b`, `div x=a/>` | one value: `>` and `/>` are no stops in concise mode | g0264 g0857 |
| `div x=a + ,b` | one value: the operator exemption applies as in E1 | g0858 |
| `div x=1\u00a0-- text`, `div x=1 -- text` | the value `1\u00a0` and a text block; with a space, the value `1` and a text block. The value keeps the Unicode space, which is no soft stop (decision 156, addendum 12) | g1680 g1688 |

Soft stops are as in E1 with the concise-mode steps 3 and 4 of
[the continuation test](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-the-continuation-test). A value continues onto the
next line in these cases:

| Case | Mechanism | Probes |
| --- | --- | --- |
| a group is open | step 1.1 of the scan | g0442 |
| the character immediately before the newline is a look-behind operator, and no `//` comment precedes the newline | step 1.3 | g0290 g0443 |
| whitespace before the newline follows a look-behind operator | step 3 of the scan: the continuation test consumes that whitespace and the newline together | g0444 |
| whitespace, then on the same line `as`, `extends`, `instanceof`, `in` or `satisfies` followed by whitespace that contains the newline, then an operand that is not `:` `,` `=` `/` `>` or `;` | step 7, the keyword row: the scan resumes at the operand, on a later line, at any indentation, column 0 included | g0445 g0446 |
| whitespace, then on the same line a `.` followed by whitespace that contains the newline, then a word character | step 7, the `.` row: the scan resumes at that word character | g0447 |
| the newline is in the whitespace after `?`, `:`, `=`, a non-type `<` or a division `/` | the character table consumes it (the look-ahead hands `n` = `?`, `:`, `=` or `/` to the character table) | g0277 g0274 g0448 g0273 g0272 |
| the newline is inside a string, a template literal or a `/* */` comment | an opaque span; the scan does not see it | g0449 g0450 |

Otherwise the newline ends the value and the attribute; the open tag then ends
too, unless the next line begins with `,` or the tag is inside `[ … ]` (rows
1–2 of [The open tag](#the-parser-grammar-tags-the-open-tag)). The inputs are concise:

| Input | Result | Probes |
| --- | --- | --- |
| `div x=a\n  b` | value `a`; child tag `b` | g0307 |
| `div x=a\n  <span/>` | value `a`; child tag `span` | g0451 |
| `div x=a\n  .b` | value `a`; an unnamed child tag with class `b` | g0452 |
| `div x=a\n  :b` | value `a`; child tag `:b` | g0453 |
| `div x=a\n  (b)` | value `a`; an unnamed child tag with tag arguments `b` | g0454 |
| `div x=a\n  !b`, `\n  + b`, `\n  ? b : c`, `\n  in b`, `\n  {b}` | value `a`; child tags `!b`, `+`, `?`, `in`, `{b}` | g0455 g0456 g0457 g0458 g0459 |
| `div x=a   \n  b`, `div x=a as T\n  b` | value ends at the line's end; child tag `b` | g0460 g0461 |
| `div x=a +\n  b`, `div x=a + \n  b` | one value | g0290 g0444 |
| `div x=a ?\n  b : c`, `div x=a <\n  b`, `div x=a /\n  b` | one value | g0277 g0274 g0448 |
| `div x=(a,\n  b)` | one value | g0442 |
| ``div x=`a\nb` c``, `div x=a /* \n */ + b` | one value (then the attribute `c` in the first) | g0449 g0450 |
| `div x=a.\n  b` | one value: the look-behind `.` row | g0288 |
| `div x=a in\n  b`, `div x=a as\n  T`, `div x=a extends\n  b`, `div x=a in \n  b` | one value: the keyword row | g0445 g0462 g0463 g0464 |
| `div x=a instanceof\nB` | one value `a instanceof\nB`: the column-0 line is drawn into it | g0446 |
| `div x=a satisfies\n  T y=1` | value `a satisfies\n  T`, then `y=1` | g0465 |
| `div [x=a in\n  b]` | one value `a in\n  b` | g0466 |
| `div x=a .\nspan`, `div x=a . \n  b` | one value: the `.` row | g0447 g0467 |
| `div x=a in\n  ,b`, `div x=a in\n  =b` | value `a`, then an attribute `in`: the operand is `,` or `=`. With `,` the open tag continues with `b`; with `=` the line `=b` is a child, an unnamed tag with a default value | g0468 g0469 |
| `div x=a in`, `div x=a in\n` | value `a`, then an attribute `in`: no operand before end of input | g0470 g0471 |
| `div x=a .\n  .b` | value `a`, an attribute `.`, then an unnamed child tag with class `b`: after the `.` the next word character is not found | g0472 |
| `div x=a\n  ,y=b` | value `a`; the open tag continues with `y=b` | g0473 |
| `div x=a + // c\n  b` | value `a + // c`; child tag `b` | g0443 |
| `div [x=a\n  .b]` | value `a`; attribute `.b` | g0474 |
| `div [x=a +\n  b]` | one value | g0475 |

A TypeScript parser continues across the newline where the next line begins
with `<`, `.`, `(`, a binary operator, `?` or `in`; the default continues where
the current line ends with a keyword operator or a lone `.`, even onto a line
at column 0, which spec §3 "Concise mode" calls a sibling (OQ 18).

| Input | Result | Probes |
| --- | --- | --- |
| `div x=a` | the value ends silently at end of input | g0823 |
| `div x=(a` | an error: a group is open ([End of input](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-end-of-input)) | g0366 |
| `div x=a :b` | the value `a` and an attribute named `:b` (the overrides of E1). Stock: one value | g0859 |
| `div x=a :` | the value `a` and an attribute named `:` | g0860 |
| `if=:a :b` | the default value `:a` and an attribute named `:b` | g0848 |

### E3 — Spread attribute

The value starts at the character immediately after `...`, with no whitespace
skipped (`ATTRIBUTE.parse`, row 7), so whitespace there is the first thing the
scan sees, with the third dot before it. It is the same call site as E1 and
E2.

| Input | Result | Row | Probes |
| --- | --- | --- | --- |
| `<div ... props/>` | spread ` props` (the range includes the space) | look-behind `.` | g0015 |
| `<div ...  (a)/>`, `<div ... {a}/>`, `<div ... -a/>` | spread, range including the whitespace | look-ahead `(`, `{`, `-` | g0476 g0477 g0478 |
| `<div ... [a]/>`, `<div ... "s"/>` | `Missing value for attribute` | neither table: **valid TypeScript that the default rejects** (OQ 24). TODO `spread-value-starting-with-bracket-or-string` | g0479 g0480 |

| Input | Result | Probes |
| --- | --- | --- |
| `<div ...a, b/>`, concise `div ...a\n  b` | the spread `a`: the stops of E1 and of E2 | g0861 g0862 |
| `<div ...:a/>` | the atom `a` | g0863 |
| `<div ...a .b/>`, `<div ...a :b/>` | the spread `a` and an attribute named `.b` / `:b`: the after-value rule applies (OQ 5) | g0845 g0844 |

### E4 — Attribute arguments

`onClick(a, b)`: from the character after `(` to the `)` at depth 0.

| Input | Result | Probes |
| --- | --- | --- |
| `<div onClick( a )/>` | the arguments ` a `: no whitespace is skipped | g0864 |
| `<div onClick(a,\n b > c)/>` | one argument list: whitespace, a newline, `,` and `>` do not end it | g0865 |
| `<div onClick(a` | an error ([End of input](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-end-of-input)) | g0200 |
| concise `div onClick(a` | the arguments `a`, no error | g0866 |
| `<div x(a :b)/>` | one argument list: the after-value rule belongs to the value position | g0867 |
| `<div x(:a)/>`, `<div x(a = :b) { c }/>` | the atoms `a` and `b`: arguments and a method's parameters lex atoms (decision 163, addendum 1) | g0868 g0869 |

### E5 — Attribute method body

`onClick(a) { … }`: from the character after `{` to the `}` at depth 0; the
content is a statement list.

| Input | Result | Probes |
| --- | --- | --- |
| `<div x(a) { if (b > c) { d } }/>` | one body: nested braces and `>` do not end it | g0870 |
| `<div x(a) { return :c }/>` | the atom `c`: a method body is an attribute value (lead ruling 2026-10-05, `PROVENANCE.md`; [ast.md §4.3](/architecture/ast/)) | g0871 |

### E6 — Tag arguments

`<Tag(expr)>`: from the character after `(` to the `)` at depth 0
(`OPEN_TAG.return` decides what follows).

| Input | Result | Probes |
| --- | --- | --- |
| `<foo( a )/>` | the arguments ` a ` | g0872 |
| `<foo(a) { b }/>` | `{` follows: the default method of [E17](#the-parser-grammar-expression-boundaries-e17-tag-level-default-method) | g0120 |
| `<foo <A>(a)/>` | type parameters before the `(` and no `{`: `Unexpected types. …` | g0230 |
| `<foo(:a)/>` | the atom `a` (decision 156.1) | g0873 |

### E7 — Tag parameters

`<Tag|a, b|>`: from the character after `|` to the next `|` at depth 0. The
content is a parameter list (spec §8 "Tag params").

| Input | Result | Probes |
| --- | --- | --- |
| `<foo\| x \|/>` | the parameters ` x ` | g0874 |
| `<foo\|a: b = c, d\|/>` | one list: `:`, `=` and `,` are plain characters | g0875 |
| `<foo\|a = (b \| c)\|/>` | one list: a group shields the `\|` | g0876 |
| `<foo\|x: A \| B\|/>` | the parameters `x: A ` and then an attribute named `B\|`: a union type at depth 0 ends the list. **Not settled** (OQ 6) | g0676 |
| `<foo\|a = :b\|/>`, `<foo\|a::b\|/>` | no atom and no reserved-token error (spec §4 "Atoms": not in tag params) | g0877 g0878 |

### E8 — Placeholder

`${expr}`, `$!{expr}`: from the character after `${` or `$!{` to the `}` at
depth 0.

| Input | Result | Probes |
| --- | --- | --- |
| `<p>${ a }</p>` | the value ` a ` | g0018 |
| `<p>${{a: 1}} ${a > b, c}</p>` | one value each: a group shields the `}`; `>` and `,` do not end it | g0879 |
| `<p>${:a}</p>`, `<script>${:a}</script>` | the atom `a` (decision 156.1 and addendum 2) | g0880 g0750 |
| `<p>${a::b}</p>` | the reserved-token error | g0881 |

### E9 — Tag variable

`<Tag/x>`: from the character after `/`. Hard stops
(`shouldTerminateHtmlTagVar`, `shouldTerminateConciseTagVar`):

| Character | HTML mode | Concise mode | Probes |
| --- | --- | --- | --- |
| `\|` `,` `=` `(` | stop | stop | g0481 g0482 g0006 g0483 g0484 g0485 g0486 g0487 |
| `:` | stop when the next character is `=` | same | g0488 g0489 |
| `<` | stop **unless** the position is in a type context | same | g0350 g0349 g0352 g0351 |
| `>` | stop | not a stop | g0490 g0491 |
| `/` | stop when the next character is `>` | not a stop | g0054 g0492 |
| `;` | not a stop | stop | g0493 g0494 |
| `-` | not a stop | stop when the next character is `-` (no whitespace needed before it, unlike E2) | g0495 g0496 |

The flags are E1's ([Inventory](#the-parser-grammar-expression-boundaries-inventory-of-positions)), so the scan, the
continuation test and the type context apply as there.

| Input | Result | Probes |
| --- | --- | --- |
| `<div/ x/>`, `<div/=1/>` | `A slash was found that was not followed by a variable name or lhs expression`: whitespace after the `/`, or an empty variable | g0231 g0232 |
| `<div/x y=1/>` | the variable `x` | g0882 |
| `<div/x + 1 y=1/>` | the variable `x + 1` | g0883 |
| `<let/x + ,y/>` | the variable `x + ,y`: the operator exemption | g0884 |
| `<let/foo : string/>`, concise `let/foo : string` | the variable `foo : string` | g0675 g0885 |
| `<let/x\n  + 1/>` | the variable `x\n  + 1` | g0886 |
| concise `let/x\n  + 1` | the variable `x` and a child tag `+` | g0887 |
| concise `let/x as\n  T` | the variable `x as\n  T` (the keyword row) | g0888 |
| `<let/x: Map<K,V> = 1/>` | the variable `x: Map<K,V>` and the default value `1`: after the `:`, `<` is no hard stop and opens a group | g0349 |
| concise `let/x: keyof\n  T`, `let/x: void\n  T` | one variable; the variable `x: void` and a child tag `T`: the unary keyword list is the type list | g0388 g0889 |
| `<let/x<T>=1/>` | `Unexpected types. …`: outside a type context `<` is a hard stop and the open tag reads a type list | g0350 |
| `<let/x: A \| B = 1/>` | the variable `x: A`, then tag parameters to the end of the input: `EOF reached while parsing expression`. A `\|` is a hard stop inside a type too (OQ 6) | g0890 |
| `<const/x=items\n .filter(Boolean)/>` | one default value: the value after the variable is the default attribute, exempt from the after-value rule (divergence row "The parser after-value rule") except after a single atom ([E1](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode)) | g0657 |
| `<let/a::b/>` | the variable `a::b`: no atom lexing in the variable | g0891 |
| `<let/x=:a/>`, `<let/a = :b/>` | the atom: the default value is E1 | g0892 g0948 |

### E10 — Statement tags

A tag whose name the consumer types `TagType.statement`
([Scriptlets and statement tags](#the-parser-grammar-scriptlets-and-statement-tags);
`TAG_NAME.exit`, `prepareStatement`, `prepareScriptlet`). The position begins
at the character that ended the tag name and has no hard stop; no event
carries the statement's text, and the open tag ends where the position ends.
It ends at a newline by step 1 of [the scan](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned) with
the flags of [the inventory](#the-parser-grammar-expression-boundaries-inventory-of-positions), or at end of input:

| Input | Result | Probes |
| --- | --- | --- |
| `static x = 1\ndiv` | ends at the newline; `div` is a tag | g0497 |
| `static x = (\n  a)\ndiv` | continues: a group is open | g0498 |
| `static x = 1\n  y\nz` | continues onto the indented line; `z` is a tag | g0499 |
| `static x = 1 // c\n  y\nz` | continues: indentation wins over the comment | g0500 |
| `static x = 1 // c\ny` | ends at the newline | g0501 |
| `static a = b\n  && c\ndiv` | continues: indented | g0502 |

| Input | Result | Probes |
| --- | --- | --- |
| `<static x = 1/>` | `The "static" tag is reserved and cannot be used as an HTML tag.` | g0234 |
| `div\n  static x = 1` | `"static" can only be used at the root of the template.` | g0235 |
| `static x = 1 + \ny` | ends at the newline: the look-behind reads the character immediately before it, here a space | g0893 |
| `static x = 1 +\ny` | continues: `+` is immediately before the newline | g0894 |
| `static const x = 1\n, y` | an attribute `y`: after the statement, row 1 of [The open tag](#the-parser-grammar-tags-the-open-tag) still runs (OQ 24). TODO `statement-tag-comma-line-adds-attributes` | g0895 |
| `static type A = B<C>\ndiv`, `export type X = { a: 1 }\ndiv`, `static declare const x: A<B>\ndiv`, `static interface A<T> {}\ndiv` | each ends at the newline: after `declare`, `interface` or `type` and a type name, the position is in the type context from its start | g0816 g0896 g0897 g0898 |
| `import type { A } from "x"\ndiv` | ends at the newline: after `type`, `{` and `*` count as a type name | g0899 |
| `static x = f<T>\ndiv`, `static type = f<T>\ndiv` | each continues onto the `div` line: not a type, so the `>` is a look-behind operator | g0900 g0901 |
| `static type A = (b > c)` | `Mismatched group. A ">" character was found when ")" was expected.` | g0902 |
| `static x = :a` | no atom (decision 156.1: "never inside `static`/`import`/script blocks") | g0903 |

The other type-context inputs are in
[the inventory](#the-parser-grammar-expression-boundaries-inventory-of-positions).

### E11 — Scriptlets

`$ statement`, `$ { … }` (`HTML_CONTENT.parse`, `isBeginningOfLine`,
`INLINE_SCRIPT.parse`, `INLINE_SCRIPT.return`). After the `$` the whitespace is
consumed; `{` then begins the block form, which runs to its `}` at depth 0,
and anything else the line form, which has the flags of
[the inventory](#the-parser-grammar-expression-boundaries-inventory-of-positions) and no hard stop. The line form:

| Input | Result | Probes |
| --- | --- | --- |
| `$ const a = 1 +\n  2` | one scriptlet | g0503 |
| `$ const a = 1 + \n  2` | ends after `+ ` (a space precedes the newline); the next line is then a concise line of its own. TODO `scriptlet-trailing-space-after-operator` | g0504 |
| `$ a = b &&\n  c` | one scriptlet | g0505 |
| `$ a = b\n  && c` | ends at the newline | g0506 |
| `$ a =\n  1`, `$ a = b ?\n  c : d`, `$ a = b /\n  c` | one scriptlet: the character table consumes the newline | g0507 g0508 g0509 |
| `$ foo(\n  a\n)` | one scriptlet: a group is open | g0510 |
| `<p>\n$ a</p>` | the scriptlet `a</p>`, then `Missing ending "p" tag`: no hard stop, so the close tag on the line is part of it | g0511 |
| `$ const a = 1 // c\n  2` | ends at the newline | g0512 |

The second row is OQ 24.

| Input | Result | Probes |
| --- | --- | --- |
| `<p>x $ y</p>`, `<p>$ x</p>` | text: in HTML content a scriptlet's `$` has only whitespace between it and the previous newline | g0904 g0905 |
| `<p>\n$ x\n</p>` | a scriptlet | g0906 |
| `$ { a; b };\ndiv`, `$ { a } ;\ndiv` | the block form; a `;` after the `}`, directly or after whitespace, is consumed | g0907 g0908 |
| `$ a +` | the line form ends silently at end of input | g0909 |
| concise `$ {a` | the block form ends silently | g0370 |
| `<p>\n$ {a` | `EOF reached while parsing expression`: the block form in HTML content | g0910 |
| `$ {(a`, `$ (a` | the same error: a group is open | g0911 g0912 |
| `$ x = :a`, `$ { x = :a }` | no atom (decision 156.1 and addendum 2) | g0913 g0914 |

### E12 — Delimited HTML blocks

A delimited block begins with a run of hyphens (`--`, `---`), as a concise line
of its own or after a concise open tag (row 4 of [The open tag](#the-parser-grammar-tags-the-open-tag)).
`BEGIN_DELIMITED_HTML_BLOCK.parse`, `Parser.beginHtmlBlock`:

| Case | Result | Probes |
| --- | --- | --- |
| the run of hyphens | is the delimiter (`--`, `---`, …) | g0915 |
| the run is followed directly by a newline | a multi-line block | g0916 |
| otherwise | the one character after the run is skipped without being examined. When only whitespace remains on the line the block is multi-line (`--x\n  a`: the `x` is discarded); otherwise it is single-line, its content starts after the skipped character (`--abc` is the text `bc`) and it ends at the end of its line (OQ 27). TODO `delimiter-next-character-skipped` | g0181 g0917 g0918 g0777 |
| the content | HTML content: tags and placeholders are parsed | g0919 g0920 |
| the content, under a text tag | text content | g0921 |
| a multi-line block's `indent`, hyphens on a line of their own | that line's indentation | g0922 |
| a multi-line block's `indent`, hyphens after an open tag | the next line's indentation when it is longer than the tag line's, otherwise the tag line's | g0515 g0923 |

At each newline inside a multi-line block the following line is tested
(`handleDelimitedBlockEOL`):

| # | The next line | Result | Probes |
| --- | --- | --- | --- |
| 1 | begins with `indent` + the delimiter | the block ends. Only whitespace may follow the delimiter on that line, otherwise `A concise mode closing block delimiter can only be followed by whitespace.` | g0513 g0240 |
| 2 | begins with `indent`, and `indent` is not empty | the block continues; the `indent` is not part of the text | g0514 |
| 3 | does not begin with `indent`, `indent` is not empty, and the line is not blank | the block ends and the line is read as concise content | g0515 |
| 4 | anything else: a blank line, or any line when `indent` is empty | the block continues | g0516 g0517 |

| Input | Result | Probes |
| --- | --- | --- |
| `--\na\nb` | the text `a\nb`: at indentation zero the block runs to its delimiter or the end of input | g0924 |
| `----\na\n--\nb\n----` | the text `a\n--\nb`: a longer delimiter lets a shorter one appear inside | g0925 |

A line that ends the block by row 3 is then read by the concise indentation
rules:

| Input | Result | Probes |
| --- | --- | --- |
| `div --\n    a\n  b\nspan` | text `a`; child tag `b`; tag `span`. The `indent` is the four spaces of the `a` line, so `  b` ends the block (row 3) | g0515 |
| `div\n  --\n    a\n  span\nb` | text `  a\n`; text `span`; `div` closes; tag `b`. The `indent` is the two spaces of the `--` line, so `  span` stays in the block (row 2) | g0514 |
| `div\n  --\n    a\n span` | `Line indentation does match indentation of previous line` | g0239 |

### E13 — Interpolation in a tag name or shorthand

`<${expr}>`, `<div.${x}>`, `<div#${x}>`: from the character after `${`
(`TAG_NAME.parse`, row 2) to the `}` at depth 0.

| Input | Result | Probes |
| --- | --- | --- |
| `<${a}/>`, `<div.${x}/>`, `<div#${x}/>` | the interpolation in a name, a class part, an id part | g0926 g0927 g0928 |
| `<a${b}c/>` | the name continues after the `}` | g0059 |
| `<${a > b}/>` | one value: `>` does not end it | g0929 |
| `<${}/>` | `Invalid placeholder, the expression cannot be missing` | g0191 |
| `<${:a}/>`, `<div.${:a}/>` | the atom `a`, reported before the name or shorthand event (decision 156, addendum 2) | g0930 g0931 |

### E14 — Tag type arguments

`<Tag<A, B>>`: the character after a `<` read at row 14 of
[The open tag](#the-parser-grammar-tags-the-open-tag), to the `>` at depth 0 (`OPEN_TAG.return`). The
flags and the type-context reads are in
[the inventory](#the-parser-grammar-expression-boundaries-inventory-of-positions).

| Input | Result | Probes |
| --- | --- | --- |
| `<foo<A, B>/>` | type arguments: the `<` is directly after the tag name | g0745 |
| `<foo.a<A>/>` | `Unexpected types. …`: after a shorthand the list is E15's | g0228 |
| `<foo<Map<K, V>>/>` | nested `<…>` are groups | g0391 |
| `<foo<() => void>/>` | the type arguments `() =`: with no `operators` flag the `>` of an arrow is the hard stop. **Valid TypeScript that the default cuts** (OQ 24). TODO `type-list-arrow-cut` | g0677 |
| `<foo<(() => void)>/>` | whole | g0932 |
| `<foo<A> x=1/>`, `<foo<A>>y</foo>`, `<foo<A> \|x\|/>` | type arguments, then an attribute, the body, parameters | g0933 g0934 g0935 |
| `<foo<A><B>/>` | the second list is read as E15: here `Unexpected types. …` | g0936 |

### E15 — Tag type parameters

`<Tag <A, B>|x|>`, `<Tag <A, B>(x) { … }>`: as E14, for a `<` that is not
directly after the tag name. After it (`OPEN_TAG.return`), whitespace is
skipped and then:

| Next character | Condition | Result | Probes |
| --- | --- | --- | --- |
| `\|` | the tag has no parameters yet | the list is reported as type parameters; E7 follows | g0008 |
| `(` | the tag has no type parameters, parameters or arguments yet | the list is held for a tag-level method; E6 follows, and its `)` **must** be followed by `{` (E17), otherwise `Unexpected types. …` | g0518 g0230 |
| anything else, or a row whose condition fails | — | `Unexpected types. Type arguments must directly follow a tag name and type paremeters must precede a method or tag parameters.` | g0519 g0520 |

### E16 — Attribute-method type parameters

`<div onClick<T>(a) { … }>`: the character after a `<` read at row 9 of
[Attributes](#the-parser-grammar-attributes); flags and stop as E14.

| Input | Result | Probes |
| --- | --- | --- |
| `<div onClick<T>(a) {x}/>`, `<div onClick <T>(a) {x}/>`, `<div async <T>(a) {b}/>` | a method with type parameters: the `<` directly after the name, after whitespace, after a pending `async` | g0937 g0938 g0091 |
| `<div onClick<T>/>` | `Attribute cannot contain type parameters unless it is a shorthand method` | g0939 |
| `<div onClick<T>(a)/>` | `An attribute cannot have both type parameters and arguments` | g0940 |
| `<div onClick<T extends () => void>(a) {x}/>` | an error: the arrow cut of E14 (OQ 24) | g0941 |

### E17 — Tag-level default method

`<Tag(a) { … }>`: parameters are position E6 and the body position E5
(`OPEN_TAG.return`).

| Input | Result | Probes |
| --- | --- | --- |
| `<foo(a) { b }/>`, `<foo(a)\n  { b }/>` | a method with a zero-width name: `{` follows the `)`, after whitespace | g0120 g0942 |
| `<input:email(a) { return a; }/>` | the tag `input:email` and a default method. Decision 146, addendum 4 gives it its meaning, in core ([dialect rule 5](#the-parser-grammar-dialect-rules)) | g0651 |

### Types inside the other positions

TypeScript's own type syntax (`as`, `satisfies`, annotations, generic
arguments) is not a separate MX position. In the default it is handled by
[the type context](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-the-type-context). In the planned design the TypeScript
parser reads it and returns the end offset, and each position's hard stops
still bound the value.

## Atoms

An **atom** is `:name` written where an expression is expected, in a position
that lexes atoms (decision 156; spec §4 "Atoms"). The template parser finds
atoms, reports them and reserves `::`; it gives them no meaning. The catalogue
node is `MxAtom` ([ast.md §4.3](/architecture/ast/)).

### Where atoms are lexed

In the positions whose `EXPRESSION` has the `atoms` flag
([Inventory of positions](#the-parser-grammar-expression-boundaries-inventory-of-positions); decision 156.1 and
addendum 2; [ast.md §4.3](/architecture/ast/) states it per catalogue field):

| Where | Atoms | Probes |
| --- | --- | --- |
| an attribute value: named, bound, default, spread (E1 to E3) | lexed | g0529 g0943 g0944 g0863 |
| attribute arguments and method parameters (E4) | lexed | g0868 g0869 |
| a method body (E5) | lexed | g0871 |
| tag arguments (E6; E17 uses E6 and E5) | lexed | g0873 g0945 |
| a placeholder, in a text body too (E8) | lexed | g0880 g0750 |
| the `${…}` of a tag name or shorthand (E13) | lexed | g0930 g0931 |
| the `${…}` of a template literal inside one of those | lexed | g0946 |
| an attribute name | not lexed: `<div :a/>` is the name `:a` | g0947 |
| the tag variable (E9) | not lexed | g0891 |
| tag parameters (E7) | not lexed | g0877 |
| a statement tag (E10), a scriptlet (E11) | not lexed | g0903 g0913 g0914 |
| a type list (E14 to E16) | not lexed | g0949 |
| a string, a template literal's text, a regular expression, a comment | not lexed | g0950 g0951 g0952 g0953 |

### At a `:` (`lexAtom`)

In a position with `atoms`, a `:` the scan reaches in its character table goes
to `lexAtom` before the ternary and type handling:

| # | At the `:` | Result | Probes |
| --- | --- | --- | --- |
| 1 | the next character is `:` | the **reserved-token error** (`INVALID_EXPRESSION`): `` `::name` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:name` for an atom ``, with the name read after `::` (with none, the message names `` `::` `` and suggests `:name`), ranged from the first `:` to the end of that name. The parse stops. This row does not look at what precedes the `:`, so `x=a :: b` and `x=(a ? b::c : d)` are the error too (observed) | g0193 g0521 g0522 g0523 |
| 2 | no name follows: the next character is not `A`–`Z`, `a`–`z`, `$` or `_` | no atom; the `:` is handled by the rest of the character table | g0524 g0525 |
| 3 | a character at or above U+0080 directly follows the name | no atom (`:aé`) | g0526 |
| 4 | a `-` directly follows the name, then a character at or above U+0080 | no atom (`:a-é`) | g0527 |
| 5 | an expression is not expected here (`expectsExpression`, below) | no atom | g0528 |
| 6 | otherwise | an **atom**, from the `:` to the end of the name. It is recorded, `onAtom` reports it, the position's `atomEnd` is set to its end, and the scan resumes after it. The `:` touches neither `ternaryDepth` nor the type context, and the whitespace after the atom is not consumed | g0529 g0530 g0531 g0532 g0533 |

A **name** (`atomNameEnd`) is `[A-Za-z_$][\w$]*(-[\w$]+)*`:

| Input | Result | Probes |
| --- | --- | --- |
| `<div x=:rename-all y/>` | the atom `:rename-all`: a `-` belongs to the name when a word character follows | g0530 |
| concise `div x=:a-` | the value `:a-` with the atom `:a` | g0531 |
| `<div x=:a--b/>` | the value `:a--b` with the atom `:a` | g0532 |
| `<div x=:a-/>` | `EOF reached while parsing regular expression`: the `/` of `/>` follows the operator `-` (the exemption of scan step 4, OQ 17) | g0954 |

### Is an expression expected? (`expectsExpression`)

Word characters here are those of [Vocabulary](#the-parser-grammar-status-sources-of-truth-and-method-vocabulary), so a non-ASCII
identifier is an operand and a symbol is not (decision 156, addendum 13). An atom's own name is
ASCII (`lexAtom`, rows 3 and 4).

`expectsExpression` scans backwards from the character before the `:`,
skipping whitespace and each comment already read in this position, and stops
at the position's start. `p` is the character reached:

| # | `p` | Expected? | Probes |
| --- | --- | --- | --- |
| 1 | none: only whitespace and comments lie between the position's start and the `:` | **yes** (`x=:a`, `x= :b`, `${ :a}`) | g0529 g0534 g0535 g0536 |
| 2 | `)`, `]`, `}`, `"`, `'` or a backtick | **no**: an expression ended | g0537 g0538 g0539 g0540 g0541 g0542 |
| 3 | `.` | **yes** only when it is the third of `...` (`[...:a]`); otherwise **no** (`a.:b`) | g0543 g0544 |
| 4 | `?` | if the `?` is the position's first character: **yes**. Otherwise let `o` be the character directly before the `?`. If `o` is a word character: **yes** only when the word ending at `o` starts with a digit (`n === 1? :a : :b`); otherwise **no**, it is TypeScript's optional marker (`(a? :T) => a`, `(é? :T) => a`). If `o` is `]`, `-` or `+`: **no**. Otherwise **yes** (`c ? :a`) | g0545 g0546 g0547 g0548 g0549 g0550 |
| 5 | `!` | skip back over every `!` and whitespace. If nothing is left: **yes**. Let `o` be the character reached. If `o` is `)`, `]`, `-` or `+`: **no** (postfix). If `o` is not a word character: **yes** (`(!:a)`). Otherwise **yes** only when the word ending at `o` is an operator word (below; `typeof!:a`), otherwise **no** (`a! :b`, `é! :b`) | g0551 g0552 g0553 g0554 g0555 g0556 |
| 6 | `>` | **yes** when the character before it is `=` (`a => :b`). Otherwise **no** when the `>` closes a type argument list (below; `y as Array<T> :z`), otherwise **yes** (a comparison or a shift) | g0557 g0558 g0559 g0560 g0561 |
| 7 | `+` or `-` | **no** when the character before it is the same (`a++ :b`); otherwise **yes** | g0562 g0563 g0564 |
| 8 | `/` | **no** when it is the last character of a regular expression read in this position (`/re/ :b`); otherwise **yes** (`a / :b`) | g0565 g0566 |
| 9 | any other character that is not a word character | **yes**: an operator or punctuator (`(:a`, `[:a, :b]`, `a + :b`, `{ k: :a }`). | g0567 g0568 g0569 g0570 |
| 10 | a word character directly before the `:`, with no whitespace or comment between | **no**: an object key or a label, keyword or not (`{ new:a }`, `{ é:a }`) | g0571 g0572 |
| 11 | a word character, with whitespace or a comment between | **yes** only when the word ending at `p` is an operator word; otherwise **no** (`c ? b :c`, `(é :b)`) | g0573 g0574 g0575 g0576 |

**Unicode whitespace** (decision 156, addendum 10; `isUnicodeWhitespaceCode`): in the atom
look-behind the characters excepted from the word characters behave as ASCII
whitespace. In this table ` ` stands for the character U+00A0 at that
place in the input; the second probe of a row is the same input with a space
there.

| Input | Result, with U+00A0 and with a space | Probes |
| --- | --- | --- |
| `x=({ é :a })` | no atom | g0955 g0956 |
| `x=({ a :b })` | no atom | g0957 g0958 |
| `x=(a! :b)` | no atom | g0959 g0555 |
| `x=(a? :b : c)` | no atom | g0960 g0961 |
| `x=(Array<T> :b)` | no atom | g0962 g0963 |
| `x=(a, yield :b)` | no atom | g0964 g0591 |
| `x=(x of :a)` | the atom lexes | g0965 g0966 |
| `x=[a,` + an excepted character + `:b]`, for U+00A0 and each of the others | the atom lexes | g0967 g0968 g0969 g0970 g0971 g0972 g0973 g0974 g0975 g0976 g0977 g0978 g0979 g0980 g0981 g0982 g0983 g0984 g0985 g0986 |

**Operator words** (`isOperatorWord`), for rows 5 and 11. The word is the run
of word characters ending at `p`, within the position:

| # | The word | Operator word? | Probes |
| --- | --- | --- | --- |
| 1 | ends where the position's last atom ends (an atom's own name) | no: `(:delete :b)` lexes `:delete` alone | g0585 |
| 2 | is directly preceded by a `.` | no: `(a.new :b)` | g0587 |
| 2 | the same, when the `.` is the third dot of a spread (`isSpreadEnd`) | the rule does not apply: `[...await :b]` and `[...new :a]` lex the atom (decision 156, addendum 8) | g0987 g0988 |
| 3 | is not one of `await` `case` `delete` `do` `else` `extends` `in` `instanceof` `new` `of` `return` `throw` `typeof` `void` `yield` (`atomKeywords`) | no: `(c ? b :c)`; in `(éin :b)` the word is `éin` | g0573 g0576 |
| 4 | is `of` | yes when the character before it, skipping whitespace, is a word character, `)`, `]` or `}`; otherwise no | g0580 g0989 g0990 g0588 |
| 5 | is `yield` or `await` | no when the character before it, skipping whitespace, is `?`, `:`, `,` or `(`; otherwise yes, at the position's start too. Decision 156, addendum 8: after `(` or `,` the word can be a parameter name with a type annotation, and after `?` or `:` a ternary operand | g0589 g0591 g0991 g0581 g0992 |
| 6 | is another word of the list | yes | g0575 g0579 g0993 g0994 g0995 g0996 g0997 g0998 g0999 g1000 g1001 g1002 |

| Input | Result | Probes |
| --- | --- | --- |
| `<div x=yield :b/>` | the value `yield` and an attribute `:b`: the after-value rule splits before `lexAtom` is asked, because `yield` is no look-behind keyword | g1003 |
| `<div x=await :b/>` | one value with the atom `b` | g0581 |

**A type argument list's closing `>`** (`closesTypeArguments`), for row 6. It
scans backwards from the `>`, counting each `>` not preceded by `=` up and
each `<` down, and each closing bracket `)` `]` `}` up and each opening one
down:

| # | At | Closes type arguments? | Probes |
| --- | --- | --- | --- |
| 1 | a `<` that brings the angle count to 0 | yes when no bracket is open between them and the `<` directly follows a word character (`Array<T>`, `É<T>`, `Map<K, Array<V>>`, `Array<() => T>`, `a<b >`); otherwise no (`a < b >`) | g0558 g0561 g1004 g1005 g1006 g0631 |
| 2 | an opening bracket with no closing one after it | no | g0559 |
| 3 | `;` | no | g1007 |
| 4 | `?` or `:` with no bracket open between it and the `>` | no | g1008 |
| 5 | `&&` or `\|\|` | no | g1009 g1010 |
| 6 | the position's start | no | g1011 |

| Input | Result | Probes |
| --- | --- | --- |
| `x=(c ? a < b > :z)`, concise `div x=c ? a < b > :z` | the atom lexes | g0631 g0632 |
| `<div x=c ? a < b > :z/>` | the ambiguous-`>` error: unparenthesised in HTML mode the `>` is E1's hard stop | g1012 |
| `x=(a<b> :c)` | no atom: a known limit of a lexer without a type parser (decision 156, addendum 4) | g1013 |

More inputs:

| Input | Atoms | Probes |
| --- | --- | --- |
| `x=:a`, `x= :b`, `x=(:a)`, `x=[:a, :b]`, `x=a + :b`, `x=a / :b`, `x=a => :b`, `x=c ? ...:a`, `x=[...:a]`, `x=(!:a)`, `x=(typeof!:a)`, `x=c ? 1? :a : :b`, `x=(return :a)`, `x=(x in :a)`, `x=(for (x of :a))`, `x=await :b`, `x=({ new :a })`, `x=(a ?? :b)`, `x=:a-b` | lexed | g0529 g0534 g0567 g0568 g0569 g0566 g0557 g0577 g0543 g0553 g0554 g0578 g0575 g0579 g0580 g0581 g0582 g0583 g0584 |
| `x=(:delete :b)` | only `:delete` | g0585 |
| `x=a.:b`, `x=(a? :T) => a`, `x=(a?:b)`, `x=(a! :b)`, `x=(a++ :b)`, `x=(/re/ :b)`, `x=({ new:a })`, `x=(a.new :b)`, `x=c ? of :b`, `x=f(await :b)`, `x=(yield :b)`, `x=(a, yield :b)`, `x=c ? a[0] :b`, `x=c ? "s" :b`, `x=:aé`, `x=:a-é`, `x=:1`, `x=: a`, `x=(a /* c */ :b)`, `x=(a // c\n :b)` | none | g0544 g0547 g0586 g0555 g0562 g0565 g0571 g0587 g0588 g0589 g0590 g0591 g0592 g0593 g0526 g0527 g0524 g0525 g0594 g0595 |

### The reserved `::` outside expressions

`rejectReservedName` reserves `::` in the static text of a tag name and
shorthand part ([Tag names](#the-parser-grammar-tags-tag-names)) and in an attribute name's range
([Attributes](#the-parser-grammar-attributes)):

| Input | Result | Probes |
| --- | --- | --- |
| `<a::b/>`, `<div.a::b/>`, `<div a::b/>`, `<div ::b/>` | the reserved-token error | g0194 g0195 g0097 g0096 |
| `<let/a::b/>`, `<foo\|a::b\|/>` | accepted: a position that lexes no atom reserves nothing | g0891 g0878 |
| `<div x="a::b"/>` | a string | g1014 |

### How atoms interact with the other rules

Lexing an atom changes where a value ends through the code paths of this
table. The last text column is the same input read without atom lexing, run
on a probe build: main's source with its `atoms = true` assignments set to
`false`, which keeps the after-value rule. Where stock, which has neither,
differs from the probe build, the cell gives stock too. The probes pin main.

| Code path | Effect | Observed on main | Without atoms (probe build; informative, not probed) | Probes |
| --- | --- | --- | --- | --- |
| `lexAtom` runs before the ternary counter (`EXPRESSION.parse`, `case CODE.COLON`) | an atom's `:` does not close a `?`, so a later ` :name` is the ternary's `:` | `x=a ? :b :c` is one value | the first `:` closes the `?`, so `x=a ? :b :c` is the value `a ? :b` and the attribute `:c`. Stock: one value, because it has no after-value rule to split at `:c` | g0533 |
| the same, at `ternaryDepth` 0 | an atom's `:` does not enter [the type context](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned-the-type-context), so each of its reads that an attribute value can reach takes its other side. (1) `<` is no group. (2) `>` is a plain character. (3) A `>` before whitespace is a look-behind operator. (4) The unary keyword list is JavaScript's, with `delete` and `void` and without `asserts` `infer` `is` `keyof` `readonly` `unique`, in the continuation test, the operator exemption and the `!` row alike. (7) An `as` or `satisfies` after the atom enters the context, and sets `forceType` when `ternaryDepth` is 0. Reads 5 and 6 have nothing to leave, and 8 and 9 belong to the tag variable, which lexes no atom | (1) concise `div x=:a<b, c> d`: value `:a<b`, then attributes `c>` and `d`; `<div x=:a<b>(c) y/>`: value `:a<b` and the `>` ends the tag. (2) concise `div x=:a > b`, `div x=:a <b> c`: one value. (3) concise `div x=:a<b>\n  c`: one value. (4) concise `div x=:a + void\n  b` and `div x=:a + void!\n  b`: one value; `div x=:a + keyof\n  b`: value `:a + keyof` and a child `b`; `<div x=:a + void, y/>`: value `:a + void,`. (7) concise `div x=:a as T = b<c> d`: value `:a as T = b<c>`, then attribute `d` | the `:` enters the type context. (1) value `:a<b, c>`, then `d`; value `:a<b>(c)`, then `y`. (2) `Mismatched group` for both. (3) value `:a<b>` and a child `c`. (4) value `:a + void` and a child `b`, and the same with `void!`; one value `:a + keyof\n  b`; value `:a + void`. (7) one value `:a as T = b<c> d`: the `as` does not set `forceType`, so the `=` leaves the context | g0596 g0597 g0598 g0599 g0600 g0601 g0602 g0603 g0604 g0605 |
| the atom guard in `lookBehindForKeyword` (continuation test step 2, and the step-4 exemption) | an atom named like a unary keyword is no operator | `x=:new :b` and `x=:typeof :b` split at `:b`; concise `div x=:new\n  span` ends at the newline; `<div x=:typeof />` ends before `/>` | `new`/`typeof` continue the value: `:new :b`, `:new\n  span`, `:typeof /` then `Missing ending "div" tag` | g0606 g0607 g0298 g0608 |
| `lexAtom` row 1 | `::` is the reserved-token error and the parse stops | `x=::a`, `x=a :: b` | one value | g0193 g0522 |
| `isSingleAtomDefault` (decision 146, addendum 5) | a default value that is one atom splits at ` :name` | `<if=:a :b>` | one value (decision 151, ruling 2) | g0423 |

### What the parser reports

| What | Result | Probes |
| --- | --- | --- |
| `onAtom` (`util/constants.ts`) | one event per atom, in source order, before the event for the range that holds it; its range is the whole atom, `:` included, and its `value` is the name | g1015 |
| `read(range)` (`Parser.read`) | the source of `range` with each atom wholly inside it replaced by a numeric literal of the same length, `0.` followed by zeros: `[0., 0.000000000]` | g1015 |

The stand-in exists for consumers that hand
`read()` text to Babel (today `@marko/compiler`); the catalogue's front end
builds the atom's `StringLiteral` with `extra.mxAtom` itself
([ast.md §4.3](/architecture/ast/), §7).

## Dialect rules

MX's own rules, with the layer that applies each: the template parser or
core, after the parse. The list summarises the sources it cites; what the
parser reports for each form is the table after it.

1. **Tag-adjacent sugar.** `#x` sets an id, `.x` a class and `:x` a name, on a
   named tag or the unnamed tag (decision 146 and its addendum of 23:23; spec
   §4 "Name sugar"). *Layer:* the parser reports the written head
   ([Tag names](#the-parser-grammar-tags-tag-names), [Shorthand](#the-parser-grammar-tags-shorthand-id-and-class)); core splits
   it.
2. **Attribute-position sugar, first or after a boolean attribute.** The parser
   reports attributes named `#x`, `.x`, `:x`; core rewrites them to `id`, class
   and `name` (spec §4 "Name sugar", "In attribute position").
3. **Attribute-position sugar after a value.** `:x` and `.x` after a value are
   new attributes through MX's after-value rule
   ([E1 overrides](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode); decision 146, divergence
   3). The default attribute's value is exempt (decision 151, ruling 2), except
   when it is a single atom (decision 146, addendum 5).
4. **The sugar's value.** `:name` takes an identifier, `[A-Za-z_$][\w$-]*`;
   `#x` and `.x` take what a shorthand part takes (spec §4 "Name sugar"). The
   after-value rule tests the character right after the sigil
   ([E1 overrides](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode); OQ 4).
5. **A sugar followed by `=value` or `(params) { body }`** sets the tag's
   default attribute (decision 146, addendum 4). *Layer:* core
   (`packages/core/src/name-sugar.ts`). The catalogue records the result as
   `MxShorthand.operator` and `default` ([ast.md §3.6](/architecture/ast/)).
6. **Left alone** (spec §4 "Name sugar", "Left alone"; decision 146, divergence
   2 and addendum 3): the named forms `class:x`, `style:x`, `value:fn:=x` and the
   explicit `value:x`; a dynamic tag name; a bound attribute; the default
   attribute; an attribute tag's own name.
7. **Repeated sugars** follow the duplicate rule: the later one wins, with a
   warning (decision 135; spec §4 "Name sugar").
8. **A bare `:`** in attribute position is a positioned error from core
   (divergence row "Bare `:x` is `name="x"`").
9. **The unnamed tag and `defaultTag` (decision 145).** The parser reports an
   empty name range; by design it writes no tag name there. Core resolves the
   name afterwards: parent contract `defaultTag`, then user config
   `package.json#mx.<target>.defaultTag`, then the host override, then the
   target's built-in (decision 145, addendum 2). An invalid `defaultTag` value
   is an error at its declaration (decision 145 and its addendum 1).
10. **Wildcard children (decision 147)** add no syntax: a child keeps its
    authored tag name, and `<:att>` yields a child whose `name` is `att`.
11. **Atoms (decision 156 and its addenda 1 to 4 and 8 to 10).** `:name` in an MX
    expression position is a value that represents itself; its runtime value
    is the name as a string (156.1, 156.2). *Layer:* the template parser lexes
    it and reserves `::` ([Atoms](#the-parser-grammar-atoms)); core gives it meaning and raises
    the misuse errors of spec §4 "Atoms".

| Rule | Input | What the parser reports | Probes |
| --- | --- | --- | --- |
| 2 | `<input :email type="email"/>`, `<input :email :other/>`, `<div a .b/>` | attributes named `:email`, `:other`, `.b` | g0646 g1016 g1017 |
| 3 | `<div x=1 #y/>` | the value `1` and an attribute `#y`: `#` is in neither operator table | g1018 |
| 4 | `x=a .2xl` | one value | g0626 |
| 4 | `x=a :b%c` | the value `a` and an attribute named `:b%c`, which core rejects | g1019 |
| 4 | `x=a .é` | the value `a` and an attribute `.é` | g1020 |
| 5 | `<input:email=1/>` | the tag `input:email` with a default value | g0649 |
| 5 | `<input :email=1/>` | an attribute named `:email` with the value `1` | g0650 |
| 5 | `<input #main(a) {}/>` | a method named `#main` | g0652 |
| 7 | `x=a :b :c` | the value and attributes `:b` and `:c`. Stock: one value | g0627 |
| 8 | `<input :/>`, `<input x=1 :/>` | an attribute named `:`; the after-value rule ends the value before it | g0654 g0653 |
| 9 | `<.a/>` | an empty name range | g1021 |
| 10 | `<:att/>` | the name `:att` | g1022 |

### Ternary depth

The counter is the `?` and `:` rows of
[the character table](#the-parser-grammar-expression-boundaries-how-a-position-is-scanned).

| Case | Result | Probes |
| --- | --- | --- |
| a `?` at depth 0 opens a ternary and a `:` at depth 0 closes one | `x=a ? b : c :d` is the value `a ? b : c` and an attribute `:d` | g0840 |
| a `:` with no ternary open | enters the type context | g0383 |
| an atom's `:` | does neither: `x=a ? :b :c` is one value (spec §4 "Atoms": "an atom's own `:` is never the ternary's") | g0533 |
| a `?` or `:` inside a group or a string | does not count: the ` :c` after it splits | g1023 g1024 |
| the after-value `:` split | needs no ternary open: `x=a ? b :c` is one value | g0424 |
| `as` or `satisfies` found by the look-ahead | sets `forceType` when no ternary is open | g0348 g0815 |
| `??` and `?.` in a named or spread attribute's value | do not open a ternary; `?.` followed by a digit does | g0431 g0432 g0433 |
| `?:` | opens a ternary: `x=a ?:b` is one value, in which `:b` is an atom (OQ 3) | g0628 |
| `??` in a default attribute's value | opens a ternary: `<if=a ?? b :c>` is one value | g0434 |

## Ambiguous inputs

Each row gives an input and the parse the grammar requires. Where the parser
reports a name and core gives it meaning, both are given.

| Input | Required parse | Settled by | Probes |
| --- | --- | --- | --- |
| `x=a ? b : c` | one value | default (observed) | g0609 |
| `x=a :b` | value `a`, then an attribute named `:b` (core: `name="b"`). Stock: one value | decision 146, divergence 3 (observed) | g0422 |
| `x=a.b .c` | value `a.b`, then an attribute named `.c` (core: class `c`). Stock: one value | decision 146, divergence 3 (observed) | g0429 |
| `x=(a) :T => a` | value `(a)`, then an attribute named `:T` whose value is empty: `Missing value for attribute`. Stock: one value | decision 151, ruling 3; divergence row "The parser after-value rule" (observed) | g0610 |
| `x=(a): T => a` | one value | default (observed) | g0358 |
| `x=(a) : T => a` | one value: a space follows the `:` | decision 146, addendum 6 (observed) | g0611 |
| `x=a ?? b` | one value | default (observed) | g0612 |
| `x=a?.b` | one value | default (observed) | g0613 |
| `x=a?.b :c` | value `a?.b`, then an attribute named `:c`. Stock: one value | decision 146, divergence 3 for the split; the `?.` handling is MX's, **not settled** (OQ 3) | g0614 |
| `x=a < b` | one value | default (observed) | g0615 |
| `x=f<T>(y)` | observed: value `f<T`; the `>` ends the tag; `(y)/>` is body text. A recorded defect; the required parse is **not settled** | OQ 7 | g0353 |
| `<div x=a > b</div>` | value `a`; the tag ends at `>`; body text ` b` | default: E1's `>` stop (observed) | g0143 |
| `<div x=a > b/>`, `<div x=a > b>` | `Ambiguous ">" in attribute. …` | default: the ambiguous `>` check (observed); OQ 8 | g0135 g0616 |
| concise `div x=a > b` | one value | default: `>` is not a concise stop (observed) | g0264 |
| `x=a as T` | one value | default (observed) | g0617 |
| `x=a satisfies T` | one value | default (observed) | g0618 |
| `x=a! .c` | value `a!`, then an attribute named `.c`. Stock: one value | decision 146, divergence 3 (observed) | g0619 |
| `x=/re/ .c` | value `/re/`, then an attribute named `.c`. Stock: one value | decision 146, divergence 3 (observed) | g0620 |
| `x=a as Map<K, V>` | one value | default: the type context (observed) | g0621 |
| `x=a [0]` | value `a`, then an attribute named `[0]` | default (observed); **not settled**, OQ 2 | g0622 |
| `x=a {b}` | one value | default (observed); **not settled**, OQ 2 | g0623 |
| `x=a: b` | one value | default (observed); OQ 2 | g0624 |
| `` x=a `t` `` | value `a`, then an attribute named `` `t` `` | default (observed); **not settled**, OQ 2 | g0625 |
| `x=a .2xl` | one value | the after-value rule's digit exclusion (observed); **not settled**, OQ 4 | g0626 |
| `x=a :b :c` | value `a`, then attributes named `:b` and `:c`; core: the later name wins, with a warning. Stock: one value | decision 146, divergence 3; decision 135; spec §4 "Name sugar" (observed) | g0627 |
| `x=a ?:b` | one value; `:b` is an atom | default for the extent (observed); OQ 3. The atom: decision 156 ([Atoms](#the-parser-grammar-atoms), row 4) | g0628 |
| `x= :b` | the value `:b`, which is the atom `b` | decision 156.1; spec §4 "Atoms" (observed) | g0534 |
| `x=:a :b` | the atom value `:a`, then an attribute named `:b` (core: `name="b"`). Stock: one value | decision 146, divergence 3; spec §4 "Atoms" (observed) | g0629 |
| `x=a ? :b :c` | one value, `a ? :b : c`, with the atom `b`. Stock: one value, no atom | decision 156; spec §4 "Atoms" (observed) | g0533 |
| `<if=:a :b>` | the default value `:a` (an atom), then an attribute named `:b`. Stock: one value | decision 146, addendum 5 (observed) | g0423 |
| `<if=:a .b>` | one value | decision 151, ruling 2: addendum 5 covers `:` only (observed) | g0630 |
| `x=a :: b`, `x=::a`, `x=(a ? b::c : d)` | the reserved-token error at the `::`. Stock: one value | decision 156.5 and addendum 2 (observed) | g0522 g0193 g0523 |
| `x=(c ? a < b > :z)`, concise `div x=c ? a < b > :z` | one value with the atom `z` (a spaced `< >` is a comparison). Unparenthesised in HTML mode, `<div x=c ? a < b > :z/>` is the ambiguous-`>` error: the `>` is E1's hard stop first | decision 156, addendum 4: a known limit (observed) | g0631 g0632 |
| `div x=a\n  <span/>` (concise) | value `a`, then the child tag `span` | default: [E2](#the-parser-grammar-expression-boundaries-e2-attribute-value-concise-mode) (observed); OQ 18 | g0451 |
| `div x=a\n  .b` (concise) | value `a`, then an unnamed child tag with class `b` | same | g0452 |
| `div x=a\n  (b)` (concise) | value `a`, then an unnamed child tag with tag arguments `b` | same | g0454 |
| `div x=a\n  + b` (concise) | value `a`, then the child tag `+` | same | g0456 |
| `div x=a +\n  b` (concise) | one value | default: the look-behind (observed) | g0290 |
| `<div x=a\n  <span/>` (HTML) | observed: the single value `a\n  <span`. **Not settled** | OQ 2, OQ 18 | g0633 |
| `<input type="email" :email>` | `type="email"`, then an attribute named `:email` (core: `name="email"`). Stock: one value | decision 146, divergence 3; spec §4 "Name sugar" (observed) | g0634 |
| `<:email/>` | parser: tag name `:email`. Core: the unnamed tag with `name="email"` | decisions 145 and 146 | g0635 |
| `<input:email/>` | parser: tag name `input:email`. Core: tag `input`, `name="email"` | decision 146, divergence 1 | g0636 |
| `<input :email/>` | parser: an attribute named `:email`. Core: `name="email"` | decision 146; spec §4 "Name sugar" | g0637 |
| `<input#main:email.big/>` | parser: id part `main:email`, class part `big`. Core: id `main`, name `email`, class `big` | decision 146, addendum of 23:23 | g0638 |
| the six orders of the three tag-adjacent sugars: `<input:email.big#main/>`, `<input:email#main.big/>`, `<input.big:email#main/>`, `<input.big#main:email/>`, `<input#main:email.big/>`, `<input#main.big:email/>` | parser: the `:name` stays in the tag name (first two) or in the shorthand part it follows (`.big:email`, `#main:email`). Core: each sugar keeps its meaning | decision 146, addendum of 23:23 (observed) | g0639 g0640 g0641 g0642 g0638 g0643 |
| `<input #main/>`, `<input .big/>` | parser: attributes named `#main`, `.big`. Core: id, class | decision 146; spec §4 "Name sugar" | g0644 g0645 |
| `<input :email type="email"/>` | parser: attributes `:email`, then `type`. Core: `name` first | decision 146 | g0646 |
| `<input x=1 #main .big :email/>` | parser: `x=1`, then attributes named `#main`, `.big`, `:email` | decision 146 (observed) | g0647 |
| `<input x=a.b .c/>` | as `x=a.b .c` | decision 146, divergence 3 | g0648 |
| `<input:email=1/>` | parser: tag `input:email` with a default value `1`. Core: `name="email"` and the default value | decision 146, addendum 4 | g0649 |
| `<input :email=1/>` | parser: an attribute named `:email` with the value `1`. Core: `name="email"` and the default value `1` | decision 146, addendum 4; spec §4 "Name sugar" | g0650 |
| `<input:email(a) { return a; }/>` | parser: tag `input:email` with a default method. Core: `name="email"` and a default value that is the function | decision 146, addendum 4 | g0651 |
| `<input #main(a) {}/>` | parser: a method named `#main`. Core: id `main` and a default value that is the function | decision 146, addendum 4 | g0652 |
| `<input x=1 :/>`, `<input :/>` | parser: an attribute named `:` (the first not on stock). Core: positioned error, bare `:` | divergence row "Bare `:x` is `name="x"`" | g0653 g0654 |
| `<a:b:c/>` | parser: tag name `a:b:c`. Core: positioned error, one name per tag | divergence row "A static tag name may not contain `:`"; spec §4 "Name sugar" | g0655 |
| `<if=a\n .b>x</if>` | one value: the default attribute is exempt | decision 151, ruling 2 (observed) | g0656 |
| `<const/x=items\n .filter(Boolean)/>` | one value | decision 151, ruling 2 (observed) | g0657 |
| `<div class:x=1/>`, `<div style:x=1/>` | parser: an attribute named `class:x` / `style:x`. Reserved on native elements | spec §4 "`class:foo` / `style:foo` modifiers" | g0658 g0659 |
| `<input value:fn:=x/>` | parser: a bound attribute named `value:fn` | decision 146, divergence 2 (observed) | g0660 |
| `<div><@svg:rect/></div>` | parser: a tag named `@svg:rect`, not split. An attribute tag on a native element is then an error | decision 146, addendum 3; spec §8 "Deferred to MX 2" | g0661 |
| `x=a ? b :c` | one value | default: `ternaryDepth` is 1 at the `:` (observed) | g0424 |
| `x=a ?? b :c` | value `a ?? b`, then an attribute named `:c`. Stock: one value | the after-value rule's `??` case (observed); **not settled**, OQ 3 | g0431 |
| `x=a ?.b :c` | value `a ?.b`, then an attribute named `:c`. Stock: one value | the after-value rule's `?.` case (observed); **not settled**, OQ 3 | g0432 |
| `div x=a in\n  b` (concise) | one value | default: the look-ahead keyword row (observed); OQ 18 | g0445 |

## Open questions for the language lead

The numbers are stable across drafts, because the text cites them. An item
that has been settled says so in place, with the decision or ruling that
settled it. The list is informative: where an item says what the parser does
with an input, it restates a row of the table after the list, and that row is
the normative one.

1. **End offset from the expression parser.** The vendored `@babel/parser` has
   no entry point that returns where an expression stopped; `startIndex` fixes
   only the start. *Recommendation:* a thin wrapper, owned by the parser lead,
   that returns the node and its end index, built first.
2. **Where the default and a TypeScript parser end a value differently.** The
   cases are in [the table below](#the-parser-grammar-open-questions-for-the-language-lead-where-a-real-typescript-parser-would-end-the-value-differently),
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
   ([Ternary depth](#the-parser-grammar-dialect-rules-ternary-depth)).
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
14. **Atoms outside the first ruled positions.** *Settled*: decision 156,
    addendum 2 (every `${}`; "script blocks" are statement blocks), decision
    163 (ruling C11 and addendum 1: attribute arguments and method parameters,
    method bodies, and never the tag variable, tag parameters or type lists)
    and the lead ruling of 2026-10-05 on method bodies. The positions are in
    [Atoms](#the-parser-grammar-atoms).
15. **Spec §4 "Consumers on a stock parser"** and divergence row "The parser
    after-value rule" describe the stock-parser diagnostic of decision 151,
    ruling 1. Decision 157 addendum 3 removed it, 158.2 kept it for the
    interim, and decision 159 makes core bundle the in-repo template parser,
    so a published core no longer reaches it. *Recommendation:* the paragraphs
    lapse now (decision 159), not at the drop of `@marko/compiler`; keep only
    the sentence for a caller that bypasses the bundle, as spec §4 "Atoms"
    already does.
16. **A tag name's first character.** A leading digit is accepted (`<1abc/>`). *Recommendation:* state the
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
    only in the cases E2 lists. Some of them reach a line that spec §3 "Concise
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
    delimiter is not on the position's group stack. These lose an event
    entirely: `div.a${b` (no shorthand event), `${x` (no event at all) and a
    template literal's `${` in a concise value (``span\n  div x=`${a``: no value
    event). *Recommendation:* an error in each case.
20. **`::` followed by whitespace.** *Settled* by decision 156, addendum 2
    ("`::` is the reserved token in every position MX lexes"): on main
    `x=a :: b` is the reserved-token error ([Atoms](#the-parser-grammar-atoms)).
21. **Agreement with the AST catalogue.** *Settled* by decision 163, ruling
    Q10: field names follow the AST; a container's span is the parser's `value`
    range and `outer` its event range. This document adopts both
    ([Ranges](#the-parser-grammar-status-sources-of-truth-and-method-ranges-and-the-names-the-ast-catalogue-gives-them)).
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
    value ([E1](#the-parser-grammar-expression-boundaries-e1-attribute-value-html-mode)).
29. **`await :name`.** *Settled* by decision 156, addendum 8: addendum 3's rule
    restated by addendum 2's principle, "a `:` TypeScript could own is
    TypeScript's" ([Atoms](#the-parser-grammar-atoms), operator words, rule 5).
30. **Statement tags and their "attributes".** Spec §2 "Syntax" says `import`,
    `static` and `export` parse as tags whose "attributes are the remaining
    words". With the statement set supplied, the parser reports no attributes
    for them ([E10](#the-parser-grammar-expression-boundaries-e10-statement-tags)); without the set the words are
    attributes. *Recommendation:* correct spec §2 when MX1
    TODO `statement-tags-not-declared-on-five-hosts` lands.
31. **A template literal's `${}` in a text body.** Decision 156, addendum 2
    makes "every `${}` placeholder" an atom position, `<script>` bodies
    included. A template literal inside a text body is text to the parser, so
    its `${…}` is no placeholder and lexes no atom
    (``<script>`${:a}`</script>``). *Recommendation:* confirm that addendum 2
    means placeholders only.
32. **Non-ASCII identifiers before an atom.** *Settled* by decision 156,
    addendum 13 (which corrected addendum 9): the atom look-behind treats as a
    word character a code point at or above U+0080 that is `ID_Continue`, or
    U+200C or U+200D, and decision 156, addendum 10: the characters excepted
    from the word class (U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029,
    U+202F, U+205F, U+3000, U+FEFF) are skipped as ASCII whitespace is. Main
    implements both (`isUnicodeWordCode`, `isUnicodeWhitespaceCode`;
    [Atoms](#the-parser-grammar-atoms-is-an-expression-expected-expectsexpression)).

The inputs the open questions mention:

| OQ | Inputs | Probes |
| --- | --- | --- |
| 3 | `x=a ?:b`, `x=a ?? b :c`, `x=a ?.b :c` | g0628 g0431 g0432 |
| 4 | `x=a .2xl` | g0626 |
| 5 | `<div ...props .b/>` | g1025 |
| 6 | `<foo\|x: A \| B\|/>`, `<let/x: A \| B = 1/>` | g0676 g0890 |
| 7 | `x=f<T>(y)`, `x=<T,>(a) => a`. TODO `html-value-generic-call-cut-at-gt` | g0353 g0670 |
| 8 | `<div x=a > b/>` | g0135 |
| 9 | `x=a ? :b :c` | g0533 |
| 10 | `div a; b`, `<div a <!-- c -->/>` | g0236 g0049 |
| 12 | `<div x=$!{a}/>` | g0755 |
| 13 | `<textarea>don't</textarea>`, `<script>var s = "a\"b";</script>`. TODO `text-body-string-backslash-escape` | g0763 g0176 |
| 16 | `<1abc/>` | g0704 |
| 17 | `<div x=a + ,b/>`, `<div x=a +/>`, `<div x=async/>`, `<div x=async, y=1/>`, concise `div x=async\n  span`, `div x=f<T> ,y=1`. TODO `operator-exemption-consumes-hard-stop` | g0788 g0832 g0664 g0665 g0306 g0666 |
| 18 | concise `div x=a instanceof\nB`, `div x=a +\nspan`; `<div x=a\n  <span/>` | g0446 g1026 g0633 |
| 19 | `div x=(a`, `div(a`, `$ {a`, `div\|a`, `div<A`, `div (a`, `div onClick(a) {b`, `script -- ${b`, `div.a${b`, `${x`, ``span\n  div x=`${a``. TODO `concise-eof-open-delimiter-silent`, `concise-eof-interpolation-drops-event` | g0366 g0368 g0370 g0374 g0375 g0376 g0373 g0377 g0380 g0381 g0382 |
| 20 | `x=a :: b` | g0522 |
| 23 | `x=a !b`, `x=a ++b` | g0668 g0669 |
| 24 | concise `div x=a as T > b`; `<foo<() => void>/>`; `<div onClick<T extends () => void>(a) {x}/>`; `x=a + /* c */ b`; `$ const a = 1 + \n  2`; `<div ... [a]/>`, `<div ... "s"/>`; `<div x=/* c */ a/>`; `static const x = 1\n, y`. TODO `concise-as-type-gt-mismatched-group`, `type-list-arrow-cut`, `value-block-comment-after-operator`, `scriptlet-trailing-space-after-operator`, `spread-value-starting-with-bracket-or-string`, `statement-tag-comma-line-adds-attributes` | g0266 g0677 g0941 g0674 g0504 g0479 g0480 g0667 g0895 |
| 25 | `<.a></div>`. TODO `unnamed-tag-close-compares-literal-div` | g0686 |
| 26 | `div\n  </div>`. TODO `concise-close-tag-closes-concise-tag` | g0690 |
| 27 | `--abc`. TODO `delimiter-next-character-skipped` | g0917 |
| 28 | `x=(a) : T => a` | g0611 |
| 29 | `x=await :b`, `x=f(await :b)` | g0581 g0589 |
| 30 | `static const a = 1`, with `static` in the supplied statement set and without | g0758 g0759 |
| 31 | ``<script>`${:a}`</script>`` | g0751 |
| 32 | `x=({ é:a })`; `x=({ é\u00A0:a })` (U+00A0 before the colon) | g0572 g0955 |

### Where a real TypeScript parser would end the value differently

"Default" is main's result. The class is assigned from the spec text and
decision 146 under the 2026-10-05 ruling:

- **(a)** the spec's rule applies and its outcome turns on a fact only
  TypeScript's grammar supplies; a TypeScript-aware boundary **may** make the
  case exact;
- **(b)** the spec's rule, in text that exists, decides the input; that result
  stands and the boundary **must not** change it;
- **(c)** the spec is silent; the default stands under decision 157.3 until
  the language lead rules. The last column notes whether TypeScript's reading would
  accept anything the spec rejects.

| Input | Default | TypeScript | Class | Basis | Probes |
| --- | --- | --- | --- | --- | --- |
| `x=a.b .c`, `x=fn(a) .b` | split before `.c` / `.b` | member access, one expression | **(b)** | divergence row "The parser after-value rule" names both spellings | g0429 g0662 |
| `x=(a) :T => a` | split before `:T`, then `Missing value for attribute` | an arrow function with a return type | **(b)** | the same row names this input; decision 151, ruling 3 | g0610 |
| `<if=a .b>`, `<const/x=items\n .filter()/>` | one value | one expression | **(b)**, no difference | the same row: the default attribute is exempt | g0327 g0663 |
| `x=a ?? b :c`, `x=a ?.b :c` | split before `:c` | `??` and `?.` are not ternaries; the expression ends before `:c` | **(a)** | the rule says "`:` … with no open `?`"; whether `??` or `?.` opens one is a fact of TypeScript's grammar. OQ 3 | g0431 g0432 |
| `x=a ? :b :c` | one value, with the atom `b` | `a ? :b : c` is no TypeScript; with atoms read as values it is one expression | **(b)**, no difference | spec §4 "Atoms": "an atom's own `:` is never the ternary's, so `a ? :b :c` is `a ? "b" : c`"; divergence row "`a ? :b :c` is one value" | g0533 |
| concise `div x=a\n  .b` | value `a`, then an unnamed child tag with class `b` | member access across the newline | **(b)** | divergence row "The parser after-value rule": `.` followed by an identifier after whitespace starts a new attribute, "and across a newline" | g0452 |
| concise `div x=a\n  (b)`, `\n  + b`, `\n  ? b : c`, `\n  in b`, `\n  <span/>` | value `a`, then a child | continues across the newline | **(c)** | spec §3 "Concise mode" says a concise tag's "children are the lines indented under it" but says nothing about attribute values, and the default itself continues a value onto such lines in other cases (`div x=a +\n  b`, `div x=a in\n  b`). Whether §3 governs value continuation is OQ 18 | g0454 g0456 g0457 g0458 g0451 |
| `<div x=async/>`, `<div x=async, y=1/>`, concise `div x=async\n  span` | `async/`, then a missing close tag; `async,` then `y=1`; one value swallowing the child | the identifier `async`, then stops | **(c)** | spec silent. OQ 17 | g0664 g0665 g0306 |
| concise `div x=f<T> ,y=1` | one value | an instantiation expression `f<T>`, then stops | **(c)** | spec silent. OQ 17 | g0666 |
| `<div x=/* c */ a/>` | value `/* c */`, then an attribute `a` | the expression `a` after a comment | **(c)** | spec silent. OQ 24. TODO `value-block-comment-after-operator` | g0667 |
| `x=a [0]` | value `a`, then an attribute named `[0]` | `a[0]` | **(c)** | spec silent. In concise mode `[` begins an attribute group, so continuing would change `div x=a [y=1]` | g0622 |
| `` x=a `t` `` | value `a`, then an attribute named `` `t` `` | a tagged template, `` a`t` `` | **(c)** | spec silent; accepts nothing the spec rejects | g0625 |
| `x=a {b}` | one value | stops after `a` | **(c)** | spec silent | g0623 |
| `x=a: b` | one value | stops after `a`; `: b` is not part of an expression | **(c)** | spec silent: the after-value rule needs whitespace before the `:` | g0624 |
| `x=a !b`, `x=a ++b` | one value | `a!`, `a++`, then stops | **(c)** | spec silent. OQ 23 | g0668 g0669 |
| `x=f<T>(y)`, `x=<T,>(a) => a` | cut at the `>` | a generic call; a generic arrow | **(c)** | spec silent; accepts nothing the spec rejects. Recorded defect. OQ 7 | g0353 g0670 |
| `x=a as T = b`, `x=a as T < b`, `x=a as T {k: T}` | one value | the type ends at `T` | **(c)** | spec silent | g0671 g0672 g0673 |
| concise `div x=a as T > b` | `Mismatched group` | a comparison | **(c)** | spec silent. OQ 24 | g0266 |
| `x=a + /* c */ b` | value `a + /* c */`, then an attribute `b` | one expression | **(c)** | spec silent. OQ 24 | g0674 |
| `<div x=a\n  <span/>` (HTML) | the single value `a\n  <span` | `a < span`, then stops at `/` | **(c)** | spec silent on newlines inside an HTML-mode value. OQ 18 | g0633 |
| `<div ... [a]/>`, `<div ... "s"/>` | `Missing value for attribute` | a spread of `[a]`, of `"s"` | **(c)** | spec silent. OQ 24 | g0479 g0480 |
| `<let/foo : string/>` | the variable `foo : string` | as a pattern with a type annotation, the same; as an expression, stops after `foo` | **(c)** | spec silent on how the boundary reads a tag variable; it must be read as a binding pattern for the two to agree | g0675 |
| `<foo\|x: A \| B\|/>` | parameters end at the first `\|` | a union type | **(c)** | spec silent. OQ 6 | g0676 |
| `<foo<() => void>/>` | type arguments `() =` | a function type | **(c)** | spec silent. OQ 24 | g0677 |

### Recorded defects in the default

These behaviours are defects or recorded limits, not grammar. Each row pins
today's behaviour; the probes of a row with a TODO carry its name in the
corpus.

| Defect | Behaviour today | TODO | Probes |
| --- | --- | --- | --- |
| a generic call or generic arrow in an HTML-mode value | cut at `>` with no error: `x=f<T>(y)`, `x=<T,>(a) => a` | `html-value-generic-call-cut-at-gt` (OQ 7) | g0353 g0670 |
| end of input in concise mode in a position whose delimiter the owning state consumed | no error | `concise-eof-open-delimiter-silent` (OQ 19) | g0368 g0370 g0374 g0375 g0376 g0373 g0377 |
| end of input in concise mode inside a tag name's, shorthand's or template literal's `${…}` | no error, and the owning event is not reported: no shorthand, no event, no value | `concise-eof-interpolation-drops-event` (OQ 19) | g0380 g0381 g0382 |
| fixed on main in #377 (TODOs `template-parser-ascii-only-lookbehinds` and `template-parser-comment-in-text-tag-open-crash`), kept here as regression probes | `<div x=é / 2 y/>` and `${é / 2}` divide; `<div x=énew y=1/>` is the value `énew` and `y=1`; `<div.a::${x}/>` names `::`; `<script // c </script>` no longer closes the tag from inside its open tag | none | g1027 g1028 g1029 g1030 g0047 |
| fixed in the look-behinds follow-up (TODO `template-parser-lookbehinds-followup`; decision 156, addenda 8, 11 and 12), kept here as regression probes | a comment before `of`, `yield` or `await` is skipped as whitespace is: `x=(f(/*c*/ await :b))` lexes no atom, as `x=(f( await :b))` lexes none; `<if=count\u00a0>= 10>` is the comparison, `<div x=(é)\u00a0/ 2/>` divides and `<div x=a +\u00a0 y=1/>` is one value, each as with a space | none | g1678 g1679 g1686 g1684 g1685 g1687 |
| the type context at any group depth after `as`, `satisfies` or an annotation | `<div x=a as T ? (b < c) : d/>` is `Mismatched group`. A recorded limit: no action before MX2's TypeScript-aware expression boundary | `as-satisfies-type-context-any-depth` | g0360 |

The behaviours of OQ 13 (no `\` escape in a text-body string), OQ 17, OQ 24,
OQ 25 and OQ 27 look like defects as well and are not filed. An implementer
**must not** treat a row of this table as intended grammar.

## Conformance

The probe corpus (decision 165) pins the rows of this document's normative
tables on the three builds ([Method](#the-parser-grammar-status-sources-of-truth-and-method-method-the-tables-and-the-probes-are-the-specification)).
Beside it: the htmljs fixtures, upstream's fixture directories kept
byte-identical in `packages/parser/src/template/__tests__/fixtures/` and run
by `upstream-suite.test.ts`, which are evidence of the default behaviour and
not a gate; `mx-after-value.test.ts` (the after-value rule, re-pointed from
`patches/htmljs-parser.test.ts`); `mx-atoms.test.ts` over the case table
`mx-atoms.cases.ts`; `__tests__/base-offset.test.ts`; and
`corpus-equivalence.test.ts`, which pins identical event streams between this
source and the patched npm build. Where the fixtures and MX's other tests
exercise a section:

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

## Further probes

These probes are the inputs written in earlier review rounds to attack the
rules above. They are grouped by the kinds of event the parser reports for
the input, in order (`×n` is a run of the same kind; an error is given by the
start of its message). A row states that sequence; the probes hold the ranges
and the text.

| Events, in order | Probes |
| --- | --- |
| Comment, Doctype, Declaration, CDATA | g1280 |
| Comment, Error: In concise mode a javascript comment block can only be follo | g1566 |
| Comment, OpenTagName, OpenTagEnd, CloseTagEnd | g1067 g1567 |
| Comment, Text | g1104 g1307 |
| Error: Line has extra indentation at the beginning | g1033 |
| Error: Mismatched group. A ")" character was found when ">" was exp | g1660 |
| Error: Mismatched group. A closing ">" character was found but it i | g1444 |
| OpenTagName | g1325 |
| OpenTagName, AttrName | g1329 |
| OpenTagName, AttrName ×2, AttrValue, OpenTagEnd, CloseTagEnd | g1451 |
| OpenTagName, AttrName ×2, OpenTagEnd, CloseTagEnd | g1127 g1236 g1251 |
| OpenTagName, AttrName ×3, OpenTagEnd, CloseTagEnd | g1240 |
| OpenTagName, AttrName, Atom, AttrValue, AttrName, OpenTagEnd, CloseTagEnd | g1618 |
| OpenTagName, AttrName, Atom, AttrValue, OpenTagEnd, CloseTagEnd | g1609 g1610 g1616 |
| OpenTagName, AttrName, Atom, AttrValue, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1517 g1611 g1612 g1613 g1614 g1615 g1617 |
| OpenTagName, AttrName, AttrArgs | g1522 |
| OpenTagName, AttrName, AttrArgs, OpenTagEnd, CloseTagEnd | g1273 |
| OpenTagName, AttrName, AttrMethod, OpenTagEnd, CloseTagEnd | g1045 g1405 g1550 |
| OpenTagName, AttrName, AttrMethod, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1487 |
| OpenTagName, AttrName, AttrValue, AttrName, AttrValue, OpenTagEnd, CloseTagEnd | g1107 g1170 g1192 g1313 |
| OpenTagName, AttrName, AttrValue, AttrName, AttrValue, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1159 |
| OpenTagName, AttrName, AttrValue, AttrName, OpenTagEnd, CloseTagEnd | g1083 g1086 g1088 g1089 g1108 g1194 g1603 |
| OpenTagName, AttrName, AttrValue, AttrName, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1518 |
| OpenTagName, AttrName, AttrValue, Error: EOF reached while within an attribute group (e.g. "[ ... ]") | g1523 |
| OpenTagName, AttrName, AttrValue, OpenTagEnd, CloseTagEnd | g1085 g1112 g1193 g1249 g1328 g1331 g1378 g1379 g1380 g1384 g1385 g1386 g1389 g1390 g1395 g1544 g1573 g1578 g1623 g1630 g1631 g1671 g1675 g1676 |
| OpenTagName, AttrName, AttrValue, OpenTagEnd, Error: A semicolon indicates the end of a line. Only comments may f | g1084 g1087 |
| OpenTagName, AttrName, AttrValue, OpenTagEnd, OpenTagName, AttrName, AttrValue, OpenTagEnd, CloseTagEnd ×2 | g1168 |
| OpenTagName, AttrName, AttrValue, OpenTagEnd, OpenTagName, AttrName, OpenTagEnd, CloseTagEnd ×2 | g1169 |
| OpenTagName, AttrName, AttrValue, OpenTagEnd, OpenTagName, Error: EOF reached while within an attribute group (e.g. "[ ... ]") | g1167 |
| OpenTagName, AttrName, AttrValue, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1034 g1342 g1387 g1388 g1391 g1575 |
| OpenTagName, AttrName, Error: EOF reached while parsing multi-line JavaScript comment | g1330 |
| OpenTagName, AttrName, Error: EOF reached while parsing regular expression | g1533 |
| OpenTagName, AttrName, Error: EOF reached while parsing string expression | g1532 |
| OpenTagName, AttrName, Error: Mismatched group. A closing ">" character was found but it i | g1670 |
| OpenTagName, AttrName, Error: Unexpected "]" character within open tag. | g1241 |
| OpenTagName, AttrName, OpenTagComment, AttrName, OpenTagEnd, CloseTagEnd | g1242 |
| OpenTagName, AttrName, OpenTagComment, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1032 |
| OpenTagName, AttrName, OpenTagEnd, CloseTagEnd | g1129 |
| OpenTagName, AttrName, OpenTagEnd, Comment, CloseTagEnd | g1237 |
| OpenTagName, AttrName, OpenTagEnd, Error: A semicolon indicates the end of a line. Only comments may f | g1238 |
| OpenTagName, AttrName, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1546 |
| OpenTagName, AttrSpread, OpenTagEnd, CloseTagEnd | g1381 g1382 |
| OpenTagName, Error: "-" not allowed as first character of attribute name | g1239 |
| OpenTagName, Error: EOF reached while parsing attribute name for the "div" tag | g1324 |
| OpenTagName, Error: EOF reached while parsing attribute value for the ... attrib | g1524 |
| OpenTagName, Error: Mismatched group. A ">" character was found when ")" was exp | g1661 |
| OpenTagName, OpenTagEnd | g1197 g1204 g1431 |
| OpenTagName, OpenTagEnd, CloseTagEnd | g1042 g1305 g1306 |
| OpenTagName, OpenTagEnd, Comment, Error: In concise mode a javascript comment block can only be follo | g1243 |
| OpenTagName, OpenTagEnd, Error: A line within a tag that only allows text content must begin | g1565 |
| OpenTagName, OpenTagEnd, Error: A semicolon indicates the end of a line. Only comments may f | g1250 |
| OpenTagName, OpenTagEnd, Error: EOF reached while parsing string expression | g1319 |
| OpenTagName, OpenTagEnd, OpenTagName, AttrName, OpenTagEnd, CloseTagEnd | g1582 |
| OpenTagName, OpenTagEnd, OpenTagName, Error: "static" can only be used at the root of the template. | g1275 |
| OpenTagName, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd | g1041 g1063 g1145 g1146 g1222 g1393 g1428 g1429 g1430 g1432 g1433 g1434 g1441 g1442 g1443 g1520 g1568 g1576 g1583 g1584 |
| OpenTagName, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1539 |
| OpenTagName, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd, Error: Line indentation does match indentation of previous line | g1310 g1311 g1563 |
| OpenTagName, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1312 |
| OpenTagName, OpenTagEnd, OpenTagName, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×3 | g1309 |
| OpenTagName, OpenTagEnd, OpenTagName, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd, Error: Line indentation does match indentation of previous line | g1316 g1564 |
| OpenTagName, OpenTagEnd, OpenTagStart, OpenTagName, OpenTagEnd | g1191 |
| OpenTagName, OpenTagEnd, OpenTagStart, OpenTagName, OpenTagEnd, CloseTagStart, Text, CloseTagName, CloseTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1279 |
| OpenTagName, OpenTagEnd, Text ×2, CloseTagEnd | g1188 |
| OpenTagName, OpenTagEnd, Text, CloseTagEnd | g1314 g1317 g1589 g1590 |
| OpenTagName, OpenTagEnd, Text, CloseTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd | g1315 |
| OpenTagName, OpenTagEnd, Text, Placeholder | g1318 |
| OpenTagName, OpenTagEnd, Text, Placeholder, CloseTagEnd | g1039 |
| OpenTagName, TagParams, OpenTagEnd, CloseTagEnd | g1402 |
| OpenTagName, TagParams, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1401 |
| OpenTagName, TagTypeArgs, AttrName, AttrValue, OpenTagEnd, CloseTagEnd | g1221 |
| OpenTagName, TagVar, AttrName, AttrValue, OpenTagEnd, CloseTagEnd | g1203 g1452 |
| OpenTagName, TagVar, AttrName, OpenTagEnd, CloseTagEnd | g1427 |
| OpenTagName, TagVar, OpenTagEnd, CloseTagEnd | g1091 g1186 g1327 |
| OpenTagName, TagVar, OpenTagEnd, OpenTagName, AttrName, AttrValue, OpenTagEnd, CloseTagEnd ×2 | g1453 |
| OpenTagName, TagVar, OpenTagEnd, OpenTagName, AttrName, OpenTagEnd, CloseTagEnd ×2 | g1285 |
| OpenTagName, TagVar, OpenTagEnd, OpenTagName, OpenTagEnd, CloseTagEnd ×2 | g1656 |
| OpenTagName, TagVar, OpenTagEnd, Text, CloseTagEnd | g1259 g1356 |
| OpenTagStart, Error: EOF reached while parsing tag name | g1477 |
| OpenTagStart, OpenTagName, Atom, AttrName, Atom, AttrMethod, OpenTagEnd | g1494 |
| OpenTagStart, OpenTagName, AttrName ×2, AttrArgs, OpenTagEnd | g1548 |
| OpenTagStart, OpenTagName, AttrName ×2, AttrMethod, OpenTagEnd | g1545 |
| OpenTagStart, OpenTagName, AttrName ×2, AttrValue, AttrName, OpenTagEnd | g1052 |
| OpenTagStart, OpenTagName, AttrName ×2, AttrValue, OpenTagEnd | g1547 |
| OpenTagStart, OpenTagName, AttrName ×2, Error: EOF reached while parsing attribute name for the "div" tag | g1122 |
| OpenTagStart, OpenTagName, AttrName ×2, OpenTagEnd | g1031 g1128 g1534 g1537 g1542 g1552 g1553 |
| OpenTagStart, OpenTagName, AttrName ×3, AttrMethod, OpenTagEnd | g1121 |
| OpenTagStart, OpenTagName, AttrName ×3, AttrValue, OpenTagEnd, Error: Missing ending "div" tag | g1190 |
| OpenTagStart, OpenTagName, AttrName ×3, OpenTagEnd | g1037 g1579 |
| OpenTagStart, OpenTagName, AttrName, Atom ×2, AttrMethod, OpenTagEnd | g1492 |
| OpenTagStart, OpenTagName, AttrName, Atom ×2, AttrValue, AttrName, OpenTagEnd | g1608 |
| OpenTagStart, OpenTagName, AttrName, Atom ×2, AttrValue, OpenTagEnd, CloseTagStart, Text, CloseTagName, CloseTagEnd | g1511 g1513 |
| OpenTagStart, OpenTagName, AttrName, Atom, AttrValue, AttrName ×2, OpenTagEnd, CloseTagStart, Text, CloseTagName, CloseTagEnd | g1516 |
| OpenTagStart, OpenTagName, AttrName, Atom, AttrValue, AttrName, OpenTagEnd | g1619 g1621 g1622 |
| OpenTagStart, OpenTagName, AttrName, Atom, AttrValue, AttrName, OpenTagEnd, CloseTagStart, Text, CloseTagName, CloseTagEnd | g1507 g1508 g1509 g1514 |
| OpenTagStart, OpenTagName, AttrName, Atom, AttrValue, OpenTagEnd | g1496 g1497 g1503 g1504 g1572 g1593 g1594 g1595 g1596 g1597 g1598 g1599 g1620 g1636 |
| OpenTagStart, OpenTagName, AttrName, Atom, AttrValue, OpenTagEnd, CloseTagStart, Text, CloseTagName, CloseTagEnd | g1510 g1512 g1515 |
| OpenTagStart, OpenTagName, AttrName, AttrArgs, Error: An attribute can only have one set of arguments | g1526 |
| OpenTagStart, OpenTagName, AttrName, AttrArgs, OpenTagEnd | g1449 g1536 g1570 g1580 g1581 |
| OpenTagStart, OpenTagName, AttrName, AttrMethod, AttrName, AttrArgs, OpenTagEnd | g1484 |
| OpenTagStart, OpenTagName, AttrName, AttrMethod, AttrName, AttrValue, OpenTagEnd | g1483 |
| OpenTagStart, OpenTagName, AttrName, AttrMethod, AttrName, OpenTagEnd | g1486 |
| OpenTagStart, OpenTagName, AttrName, AttrMethod, OpenTagEnd | g1044 g1048 g1261 g1272 g1404 g1416 g1417 g1418 g1419 g1471 g1472 g1473 g1474 g1479 g1549 g1551 g1666 g1667 |
| OpenTagStart, OpenTagName, AttrName, AttrSpread, OpenTagEnd | g1450 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, AttrName ×2, OpenTagEnd | g1071 g1093 g1148 g1150 g1157 g1158 g1171 g1178 g1179 g1184 g1211 g1294 g1600 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, AttrName, AttrArgs, AttrName, OpenTagEnd | g1162 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, AttrName, AttrMethod, OpenTagEnd | g1166 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, AttrName, AttrValue, OpenTagEnd | g1053 g1165 g1173 g1174 g1200 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, AttrName, Error: Ambiguous ">" in attribute. A ">" preceded by whitespace end | g1465 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, AttrName, OpenTagEnd | g1038 g1049 g1055 g1056 g1057 g1058 g1059 g1060 g1061 g1069 g1070 g1072 g1073 g1074 g1077 g1078 g1079 g1080 g1081 g1082 g1098 g1100 g1101 g1102 g1103 g1106 g1130 g1131 g1132 g1133 g1134 g1147 g1149 g1151 g1152 g1153 g1154 g1161 g1163 g1164 g1176 g1177 g1205 g1207 g1208 g1212 g1213 g1215 g1263 g1266 g1269 g1276 g1277 g1278 g1281 g1282 g1283 g1284 g1287 g1292 g1293 g1295 g1296 g1299 g1300 g1332 g1333 g1334 g1336 g1338 g1339 g1340 g1341 g1357 g1358 g1359 g1360 g1361 g1362 g1363 g1365 g1366 g1374 g1375 g1376 g1377 g1498 g1499 g1501 g1527 g1577 g1626 g1627 g1629 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, AttrName, OpenTagEnd, CloseTagStart, Text, CloseTagName, CloseTagEnd | g1265 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, AttrSpread, AttrName, OpenTagEnd | g1095 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, Error: A close tag was found before the "div" open tag was closed.  | g1270 g1291 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, Error: An html comment cannot be used within an open tag. Use a Jav | g1271 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, OpenTagEnd | g1035 g1046 g1054 g1064 g1065 g1066 g1075 g1076 g1097 g1099 g1160 g1172 g1180 g1181 g1182 g1183 g1185 g1195 g1196 g1198 g1206 g1209 g1210 g1216 g1219 g1255 g1256 g1262 g1286 g1289 g1290 g1297 g1301 g1335 g1337 g1364 g1368 g1369 g1373 g1383 g1392 g1495 g1505 g1525 g1528 g1529 g1571 g1574 g1601 g1602 g1606 g1607 g1632 g1633 g1634 g1635 g1637 g1638 g1639 g1640 g1641 g1642 g1643 g1644 g1645 g1646 g1647 g1648 g1649 g1650 g1651 g1652 g1653 g1654 g1655 g1677 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, OpenTagEnd, CloseTagStart, Text, CloseTagName, CloseTagEnd | g1094 g1246 g1247 g1267 g1268 g1466 g1519 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, OpenTagEnd, Error: Missing ending "div" tag | g1199 |
| OpenTagStart, OpenTagName, AttrName, AttrValue, OpenTagEnd, Text, Error: Missing ending "div" tag | g1175 g1367 g1370 g1371 g1372 g1455 g1458 g1460 g1462 g1469 g1470 g1502 g1673 g1674 |
| OpenTagStart, OpenTagName, AttrName, Error: Ambiguous ">" in attribute. A ">" preceded by whitespace end | g1245 g1288 g1456 g1457 g1459 g1461 g1463 g1464 g1467 g1468 g1556 g1669 |
| OpenTagStart, OpenTagName, AttrName, Error: An html comment cannot be used within an open tag. Use a Jav | g1244 |
| OpenTagStart, OpenTagName, AttrName, Error: Attribute cannot contain type parameters unless it is a shor | g1543 |
| OpenTagStart, OpenTagName, AttrName, Error: EOF reached while parsing attribute "a" for the "div" tag | g1447 |
| OpenTagStart, OpenTagName, AttrName, Error: EOF reached while parsing attribute value for the "onClick"  | g1109 |
| OpenTagStart, OpenTagName, AttrName, Error: EOF reached while parsing attribute value for the "x" attrib | g1126 g1217 g1218 g1448 |
| OpenTagStart, OpenTagName, AttrName, Error: EOF reached while parsing expression | g1531 |
| OpenTagStart, OpenTagName, AttrName, Error: EOF reached while parsing regular expression | g1298 |
| OpenTagStart, OpenTagName, AttrName, Error: EOF reached while parsing string expression | g1113 |
| OpenTagStart, OpenTagName, AttrName, Error: EOL reached while parsing regular expression | g1114 |
| OpenTagStart, OpenTagName, AttrName, Error: Mismatched group. A ")" character was found when ">" was exp | g1624 g1672 |
| OpenTagStart, OpenTagName, AttrName, Error: Mismatched group. A ">" character was found when "]" was exp | g1625 |
| OpenTagStart, OpenTagName, AttrName, Error: Mismatched group. A "]" character was found when ")" was exp | g1500 |
| OpenTagStart, OpenTagName, AttrName, Error: Mismatched group. A closing "}" character was found but it i | g1214 |
| OpenTagStart, OpenTagName, AttrName, Error: Missing value for attribute | g1124 g1125 g1201 |
| OpenTagStart, OpenTagName, AttrName, OpenTagEnd | g1303 g1538 |
| OpenTagStart, OpenTagName, AttrName, OpenTagEnd, Text, Error: Missing ending "div" tag | g1554 g1555 |
| OpenTagStart, OpenTagName, Error: '::b' is reserved (decision 156): '::' will be the Symbol.fo | g1506 |
| OpenTagStart, OpenTagName, Error: EOF reached while parsing attribute name for the "div" tag | g1187 |
| OpenTagStart, OpenTagName, Error: EOF reached while parsing attribute value for the "x" attrib | g1446 |
| OpenTagStart, OpenTagName, Error: EOF reached while parsing expression | g1110 g1111 |
| OpenTagStart, OpenTagName, Error: EOF reached while parsing tag name | g1326 |
| OpenTagStart, OpenTagName, Error: Missing value for attribute | g1123 |
| OpenTagStart, OpenTagName, Error: The "static" tag is reserved and cannot be used as an HTML t | g1274 |
| OpenTagStart, OpenTagName, Error: Unexpected types. Type arguments must directly follow a tag  | g1135 |
| OpenTagStart, OpenTagName, OpenTagComment, AttrName, OpenTagComment, AttrName, OpenTagEnd | g1036 |
| OpenTagStart, OpenTagName, OpenTagEnd | g1304 g1408 g1475 g1476 |
| OpenTagStart, OpenTagName, OpenTagEnd, Atom, Placeholder, CloseTagStart, CloseTagName, CloseTagEnd | g1604 g1605 |
| OpenTagStart, OpenTagName, OpenTagEnd, CloseTagStart, Error: EOF reached while parsing closing tag | g1119 |
| OpenTagStart, OpenTagName, OpenTagEnd, CloseTagStart, Text, CloseTagName, CloseTagEnd | g1227 g1557 g1585 |
| OpenTagStart, OpenTagName, OpenTagEnd, Declaration, CloseTagStart, Text, CloseTagName, CloseTagEnd | g1105 |
| OpenTagStart, OpenTagName, OpenTagEnd, Error: EOF reached while parsing CDATA | g1115 |
| OpenTagStart, OpenTagName, OpenTagEnd, Error: EOF reached while parsing comment | g1116 |
| OpenTagStart, OpenTagName, OpenTagEnd, Error: EOF reached while parsing declaration | g1118 |
| OpenTagStart, OpenTagName, OpenTagEnd, Error: EOF reached while parsing document type | g1117 |
| OpenTagStart, OpenTagName, OpenTagEnd, Error: EOF reached while parsing multi-line JavaScript comment | g1320 |
| OpenTagStart, OpenTagName, OpenTagEnd, Error: EOF reached while parsing placeholder | g1491 |
| OpenTagStart, OpenTagName, OpenTagEnd, Error: Invalid placeholder, the expression cannot be missing | g1226 g1489 |
| OpenTagStart, OpenTagName, OpenTagEnd, OpenTagStart, OpenTagName, AttrName, OpenTagEnd, CloseTagStart, CloseTagName, CloseTagEnd | g1155 |
| OpenTagStart, OpenTagName, OpenTagEnd, OpenTagStart, Text, OpenTagName, OpenTagEnd, CloseTagStart, Error: The closing "p" tag does not match the corresponding opening | g1235 |
| OpenTagStart, OpenTagName, OpenTagEnd, Placeholder ×2, CloseTagStart, CloseTagName, CloseTagEnd | g1488 |
| OpenTagStart, OpenTagName, OpenTagEnd, Placeholder, CloseTagStart, CloseTagName, CloseTagEnd | g1040 g1047 g1225 g1345 g1346 g1347 g1348 g1349 g1350 g1490 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text | g1540 g1541 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, Atom, Placeholder, Text, CloseTagStart, CloseTagName, CloseTagEnd | g1530 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, CloseTagStart, CloseTagName, CloseTagEnd | g1230 g1321 g1323 g1559 g1560 g1562 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, CloseTagStart, CloseTagName, CloseTagEnd, CloseTagStart, Error: The closing "script" tag was not expected | g1561 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, Comment, Error: Missing ending "p" tag | g1308 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, Comment, Text, Comment, CloseTagStart, Text, CloseTagName, CloseTagEnd | g1234 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, Error: EOF reached while parsing expression | g1302 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, Error: Missing ending "script" tag | g1322 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, OpenTagName, OpenTagEnd, CloseTagEnd | g1068 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, Placeholder, CloseTagStart, CloseTagName, CloseTagEnd | g1228 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, Placeholder, Text, CloseTagStart, CloseTagName, CloseTagEnd | g1229 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, Scriptlet, CloseTagStart, Text, CloseTagName, CloseTagEnd | g1139 g1224 g1438 g1439 g1440 |
| OpenTagStart, OpenTagName, OpenTagEnd, Text, Scriptlet, Error: Missing ending "p" tag | g1558 g1587 |
| OpenTagStart, OpenTagName, TagArgs, Error: Unexpected types. Type arguments must directly follow a tag  | g1481 |
| OpenTagStart, OpenTagName, TagArgs, OpenTagEnd | g1202 g1343 g1344 g1403 g1406 g1407 g1668 |
| OpenTagStart, OpenTagName, TagArgs, TagTypeParams, TagParams, OpenTagEnd | g1136 |
| OpenTagStart, OpenTagName, TagParams, AttrName, AttrValue, OpenTagEnd | g1260 |
| OpenTagStart, OpenTagName, TagParams, AttrName, OpenTagEnd | g1397 |
| OpenTagStart, OpenTagName, TagParams, AttrName, OpenTagEnd, Text, Error: Missing ending "foo" tag | g1399 g1569 |
| OpenTagStart, OpenTagName, TagParams, Error: A tag can only specify parameters once | g1396 |
| OpenTagStart, OpenTagName, TagParams, Error: Unexpected types. Type arguments must directly follow a tag  | g1137 g1138 g1480 |
| OpenTagStart, OpenTagName, TagParams, OpenTagEnd | g1351 g1352 g1398 g1400 g1535 g1664 g1665 |
| OpenTagStart, OpenTagName, TagShorthandClass ×2, TagShorthandId, OpenTagEnd | g1252 |
| OpenTagStart, OpenTagName, TagShorthandClass, OpenTagEnd | g1409 |
| OpenTagStart, OpenTagName, TagShorthandClass, OpenTagEnd, CloseTagStart, CloseTagName, CloseTagEnd | g1120 g1254 |
| OpenTagStart, OpenTagName, TagShorthandClass, TagShorthandId, OpenTagEnd | g1410 |
| OpenTagStart, OpenTagName, TagShorthandClass, TagVar, OpenTagEnd | g1096 |
| OpenTagStart, OpenTagName, TagShorthandId, Error: Multiple shorthand ID parts are not allowed on the same tag | g1253 |
| OpenTagStart, OpenTagName, TagShorthandId, Error: Unexpected types. Type arguments must directly follow a tag  | g1592 |
| OpenTagStart, OpenTagName, TagTypeArgs, AttrName, AttrMethod, OpenTagEnd | g1485 |
| OpenTagStart, OpenTagName, TagTypeArgs, AttrName, OpenTagEnd, Text, Error: Missing ending "foo" tag | g1412 g1413 |
| OpenTagStart, OpenTagName, TagTypeArgs, OpenTagEnd | g1411 g1414 g1415 g1493 g1628 g1662 g1663 |
| OpenTagStart, OpenTagName, TagTypeParams, TagParams, OpenTagEnd | g1478 g1482 |
| OpenTagStart, OpenTagName, TagVar, AttrName, AttrValue, OpenTagEnd | g1090 g1257 g1258 g1353 g1354 g1355 g1423 g1426 |
| OpenTagStart, OpenTagName, TagVar, AttrName, OpenTagEnd | g1421 g1424 g1425 g1657 |
| OpenTagStart, OpenTagName, TagVar, Error: Unexpected types. Type arguments must directly follow a tag  | g1092 |
| OpenTagStart, OpenTagName, TagVar, OpenTagEnd | g1220 g1248 g1420 g1422 g1454 |
| Scriptlet | g1140 g1141 g1144 g1223 g1445 g1659 |
| Scriptlet, Error: Line has extra indentation at the beginning | g1062 g1264 g1588 |
| Scriptlet, OpenTagName, OpenTagEnd, CloseTagEnd | g1043 g1142 g1143 g1394 g1435 g1436 g1437 g1521 g1586 |
| Scriptlet, OpenTagStart, OpenTagName, OpenTagEnd | g1658 |
| Text | g1050 g1189 g1233 g1591 |
| Text, Error: A concise mode closing block delimiter can only be followed  | g1051 g1156 |
| Text, OpenTagName, OpenTagEnd, CloseTagEnd | g1231 g1232 |

---
title: "The parser grammar"
description: "How MX source text is split into tokens, expressions and nodes, in every mode, for the MX-owned parser."
---

# The parser grammar

This document is the parser-level specification of MX: how source text is split
into tags, attributes, values, bodies, placeholders, scriptlets and text, in
HTML mode, concise mode, and the delimited text blocks. It is written to be
implementable and testable, not to be read as a tutorial.

It is **a draft for review by mx-lead**, who owns language design. Where the
language spec, the decision log and `divergences.md` disagree or are silent, the
disagreement is recorded in [Open questions for mx-lead](#open-questions-for-mx-lead)
rather than resolved here. Nothing in this document decides syntax.

## Status, sources of truth and method

Decision 157 (2026-10-05) makes the MX parser and compiler MX-owned, written in
TypeScript, starting from the source of `htmljs-parser` 5.18.0 and
`@marko/compiler` 5.42.10 copied into workspace packages in this repo, with no
obligation to follow upstream (decision 157, addendum 2). **Marko's behaviour is
the default answer wherever MX has no ruling of its own** (decision 157.3), and
Marko byte parity is no longer a requirement.

Sources of truth, in this order:

1. the language spec, `apps/docs/docs/specification.md` (cited as *spec §N*);
2. the decision log, `notes/decisions-2026-09-10.md` (cited as *decision N* and
   its addenda);
3. `divergences.md` at the repository root, cited by its **row heading**, because
   its rows carry no numbers (for example *divergence row "The parser
   after-value rule"*), plus `fixtures/divergences.md`.

The htmljs-parser fixtures and the Marko fixtures are **evidence of the default
behaviour, not a gate**.

Two changes are described here as they **will be**, not as the patch is today:

- decision 146, addendum 4 — a sugar immediately followed by `=value` or
  `(params) { body }` sets the tag's default attribute;
- atoms, phase B — `:name` lexed in expression position, `::` reserved
  (decision 156).

### Method: every behavioural rule is read out of the parser source

Every rule in this document about what the existing parser does is **derived
from the parser's source**, `htmljs-parser` 5.18.0 in
`/Users/svallory/work/htmljs-parser/src` (read-only), and cites the file and the
symbol or line the rule comes from. The parser is a hand-written state machine;
the symbols named here are the whole of the state machine's decision surface:

| Concern | Source |
| --- | --- |
| value termination, whitespace continuation, operators, ternary depth, type context, end of input | `src/states/EXPRESSION.ts` — `EXPRESSION.parse`, `checkForOperators`, `lookBehindForOperator`, `lookAheadForOperator`, and the keyword tables `unaryKeywords`, `jsUnaryKeywords`, `tsUnaryKeywords`, `binaryKeywords` at `:35-67` |
| attribute name, value, argument, method and type-parameter positions; the per-mode terminator sets | `src/states/ATTRIBUTE.ts` — `shouldTerminateHtmlAttrName`, `shouldTerminateHtmlAttrValue`, `shouldTerminateConciseAttrName`, `shouldTerminateConciseAttrValue`, `shouldTerminateConciseGroupedAttrName`, `shouldTerminateConciseGroupedAttrValue`, `detectAmbiguousCloseAngleBracket` |
| tag head, tag variable, tag arguments, tag parameters, tag type arguments and parameters, the tag-level default method | `src/states/OPEN_TAG.ts` — `OPEN_TAG.parse`, `OPEN_TAG.return`, `shouldTerminateHtmlTagVar`, `shouldTerminateConciseTagVar` |
| tag name terminators, shorthands, dynamic names, statement-tag recognition | `src/states/TAG_NAME.ts` — `TAG_NAME.parse`, `TAG_NAME.exit`, `prepareStatement` |
| concise indentation and line rules, mixed mode | `src/states/CONCISE_HTML_CONTENT.ts` — `CONCISE_HTML_CONTENT.parse` |
| `--` and `---` blocks | `src/states/BEGIN_DELIMITED_HTML_BLOCK.ts` — `BEGIN_DELIMITED_HTML_BLOCK.parse`, `handleDelimitedBlockEOL` |
| scriptlets and statement tags | `src/states/INLINE_SCRIPT.ts` — `INLINE_SCRIPT.parse`, `prepareScriptlet` |
| placeholders | `src/states/PLACEHOLDER.ts` — `checkForPlaceholder` |
| raw-text (`TagType.text`) bodies | `src/states/PARSED_TEXT_CONTENT.ts` — `PARSED_TEXT_CONTENT.parse` |
| the character predicates every rule is stated in terms of | `src/util/util.ts` — `isWhitespaceCode`, `isIndentCode`, `isWordCode`, `matchesCloseParen`, `matchesCloseAngleBracket`, `matchesPipe` |

Every rule is then **confirmed by probe** — and, where a rule can be worded
wrongly, by probes chosen to break the wording rather than to illustrate it. Each
rule carries the inputs that try to break it and the observed event stream; the
table is in the task report `scratch/reports/mx2/grammar-spec-r2.md`. Probes ran
through the **patched** 5.18.0 dist in this repo's `node_modules` **and** the
**stock** source, with the same consumer callbacks (`onOpenTagName` returning
`TagType.statement` for `static`/`import`/`export`/`server`/`client`,
`TagType.text` for `script`/`style`/`textarea`, `TagType.void` for
`input`/`br`). **Stock and patched agree on every input below unless the text
says otherwise**; the only input on which they differ is the after-value `??`/`.`
rule, which is the patch.

Where the parser's behaviour differs from what a source of truth says should
happen, this document records the difference and raises an open question. It
does not smooth the difference over, and it does not invent a ruling. Where the
parser silently accepts input that is not valid TypeScript, that is recorded as
an open question too, not normalised away.

### The central design change

The parser stops guessing where an embedded TypeScript expression ends. At every
position in [Expression boundaries](#expression-boundaries) it calls a real
TypeScript expression parser **at the value's start offset**, supplies a set of
stop conditions, and takes the **end offset** back from it. The vendored
`@babel/parser` 7.29.8 is that parser; `parseExpression` is its entry point and
`getExpression` the internal reader. `startLine`, `startColumn` and `startIndex`
exist and **must** be supplied with the value's real base offsets, so a
diagnostic column is the column in the MX file.

One limitation is open: **no entry point of the vendored parser returns where an
expression stopped yet**; the mechanism for that is the parser lead's work and
is not fixed by this document (see OQ 1).

### Vocabulary: hard and soft stops

This is the vocabulary the whole document uses.

- A **hard stop** is a character that ends the value at nesting depth 0,
  whatever the expression parser could still consume. A hard stop is the
  parser's decision alone.
- A **soft stop** is a character at which the value *may* end. It ends the value
  only when the continuation rules of that position do not carry the value
  across it.
- **One exemption applies to every hard stop, and the parser does not present it
  as an exemption.** `EXPRESSION.parse` asks `shouldTerminate` and, when it says
  yes, then checks whether the **previous non-whitespace character is an
  operator**; if it is, the stop is **ignored** and the character is consumed as
  part of the value (`EXPRESSION.ts:151-172`, the `wasExpression` local, whose
  test is `lookBehindForOperator(...) !== -1`). So a stop character written
  directly after an operator does **not** end the value. This only ever affects
  input that is not valid TypeScript — no valid TypeScript puts an operator
  immediately before `,`, `/>` or `>` — and the parser's recovery from it is not
  consistent: `<div x=a + ,b/>` silently becomes the single value `a + ,b`,
  while `<div x=a +/>` and `<div x=a ? />` enter the regular-expression state
  and report `EOF reached while parsing regular expression` instead. This
  document states the exemption as part of the default and records the
  inconsistency as an open question (OQ 17).
- **Grouping characters** are `(`, `[`, `{` and, in a type context, `<`. Inside
  an open group no stop character is significant, at any depth.
- **Depth** is the parser's group stack depth. Every stop below applies at
  depth 0 unless the text says otherwise.
- **Opaque spans** are string literals, template literals (including their
  `${…}` parts, which are parsed as nested expressions at depth + 1), regular
  expressions and JavaScript comments. No stop character is significant inside
  one.

Decision 157.3 makes the **stock** rule the normative default: wherever this
document says "the default", it means what the stock parser's source says, as
confirmed by probe.

### Conventions

Normative statements use **must**, **must not** and **may**. Every fenced block
in this document is preceded by the word *Example* and carries no normative
weight. Inline snippets inside a rule are part of the rule.

## Document structure and modes

A template file is a sequence of nodes. At the root a node is text, a comment, a
doctype, a statement tag, an HTML-mode tag, a concise-mode tag, or a delimited
text block (spec §1, spec §2).

Inside a tag body there are three mutually exclusive forms:

| Form | Entered by | Left by |
| --- | --- | --- |
| **HTML mode** | the `>` that ends an open tag, or content after a tag ends | the matching close tag, `/>`, or end of input |
| **Concise mode** | a tag name written at the start of a line without angle brackets | dedent: `CONCISE_HTML_CONTENT.parse:65-71` closes every active tag whose `indent.length >= curIndent`, so a line whose indentation is not greater than the enclosing tag's closes it |
| **Delimited HTML block** | a `--` line followed by content on the same line, or a `--`/`---` line followed by a newline (`BEGIN_DELIMITED_HTML_BLOCK.parse:36-77`) | the end of the line, the matching `indent` + `delimiter`, or a non-blank line that does not start with the block's `indent` (`handleDelimitedBlockEOL:101-157`) |

The block's **body is HTML**, not text: `BEGIN_DELIMITED_HTML_BLOCK.parse` calls
`beginHtmlBlock` on both paths (`:53` for the multi-line form, `:70` for the
single-line form), so tags and placeholders inside it are parsed.

Concise and HTML mode coexist in one file (spec §3 "Concise mode"): a line
starting with `<` sets `beginMixedMode` and enters HTML mode
(`CONCISE_HTML_CONTENT.parse:109-112`), and an HTML-mode region does not end the
region before a closing tag. A column-0 tag line inside a concise block is a
**sibling**, not a terminator — that is the reader-level description in spec §3;
mechanically the parser closes a concise block by indentation
(`CONCISE_HTML_CONTENT`).

`/>` self-closes **any** tag, not only a void element.

## Tags

### Tag names

A static tag name **must** run until one of the characters that end a tag head
(`TAG_NAME.ts`): whitespace, `=`, `:=`, `(`, `/`, `|`, `<`, `,`, and — in concise
mode `;` and `[`, in HTML mode `>`.

**`:` is a tag-name character and only `:=` ends a name** (decision 146:
"tag-adjacent `:` is a tag-name character"). `.` and `#` do not end a name: each
starts the next shorthand.

The parser imposes no leading-character class; the stock parser accepts a name
beginning with a digit (observed). No source of truth states a class, so this
document states none (OQ 14).

Four name forms exist:

| Form | Example | Grammar |
| --- | --- | --- |
| Static | `div`, `my-widget` | any run of tag-name characters |
| Interpolated | `<${expr}>`, `<${Foo}.bar>` | `${` … `}`; the name may be followed by shorthands and by a literal suffix (`<${foo}-bar>`) |
| Shorthand-only (unnamed) | `<#main>`, `<.card>`, `<:email>` | a shorthand with no written name; the name event carries an **empty** range (decision 145) |
| Statement tag | `static`, `import`, `export`, `server`, `client` | concise mode only, and only at the root (see [E10](#e10--statement-tags)) |

The empty name range is the parser's own signal: no authored name has one, so
core resolves the tag through the `defaultTag` ladder
([dialect rule 8](#dialect-rules)).

**A static tag name must not contain `:`.** `tag:rest` is the tag `tag` plus
`name="rest"`; `<:rest>` is the unnamed tag with `name="rest"` (divergence row
"A static tag name may not contain `:`"; decision 146, divergence 1). The split
is **post-parse**, so the parser must still see the whole written head as the
name, and three consequences follow:

- in HTML mode a void element written with a `:name` still needs its `/>`;
- a closing tag repeats the **written** name, or is the shorthand close `</>`;
- concise mode is unaffected.

A **second** `:` in a tag head is a positioned error — a tag takes one name
(divergence row "A static tag name may not contain `:`"; spec §4 "Name sugar").

### Dynamic tag names

`<${expr}>` is a dynamic name. It is **not** split at `:` (divergence row "A
static tag name may not contain `:`"; spec §4 "Left alone"). What follows the
closing `}` is read as shorthands: `<${Foo}.bar>` is the dynamic tag `${Foo}`
with the class shorthand `.bar` (observed). A literal suffix is a suffix of the
name itself: `<${foo}-bar>`.

### Shorthand `#id` and `.class`

A shorthand **must** run until whitespace, `=`, `(`, `/`, `|`, `<`, `,` or `>`; `.` and
`#` start the next part (spec §4 "Name sugar"). `.` and `#` accept exactly what
the parser's shorthand accepts, so `<div #1a>` and `.2xl` are valid in both the
tag-adjacent and the attribute position. A shorthand may be dynamic:
`<div.${x}>` and `<div#${x}>` are shorthands whose value is a placeholder
(observed).

Shorthands compose in **any order** (decision 146, addendum of 23:23): the static
part of a shorthand `class`/`id` value splits at its first `:` (divergence row
"A shorthand class or id cannot contain `:`"). A dynamic shorthand splits only
its static tail, and a `:` before a `${…}` is a positioned error (spec §4).

## Attributes

An attribute in HTML mode runs from after the tag head to the tag's end; in
concise mode to the end of the line, or to the `]` of a grouped list.

| Form | Syntax | Parser note |
| --- | --- | --- |
| Static | `class="card"` | quoted by the string state; an unquoted value runs to the value stop set |
| Dynamic | `value=expr` | see [Expression boundaries](#expression-boundaries) |
| Boolean | `disabled` | no `=`; the parser emits **no value event** for it |
| Spread | `...expr` | the stock value range **includes** the whitespace after `...` (observed) |
| Bound | `value:=count` | `:=`; the space before `=` decides: `x:=expr` is a binding, `x: =expr` is a name `x:` (spec §4 "`:modifier`") |
| Modifier | `class:active=on`, `value:fn:=x`, `value:foo:bar` | the last-`:` split and the empty-head fill to `value` are **`@marko/compiler`'s** (`babel-plugin/parser.js` `onAttrName`, quoted in spec §4 "`:modifier`"), not the parser's. Under MX a bare `:foo` is **name sugar**, not the name `value:foo` (divergence row "Bare `:x` is `name="x"`") |
| Method | `onClick() { … }` | `()` is attribute arguments, `{ … }` is a statement block ([E4](#e4--attribute-arguments), [E5](#e5--attribute-method-body)) |
| Sugar | `#x`, `.x`, `:x` | [Dialect rules](#dialect-rules) |

Attribute **names** are `EXPRESSION` positions with `operators = false` and
`terminatedByWhitespace = true` (`ATTRIBUTE.parse`, the `ATTR_STAGE.NAME` branch,
`:174-186`), so their terminator set is exactly the position's
`shouldTerminate`:

| Mode | Name terminators | Source |
| --- | --- | --- |
| HTML | `,` `=` `(` `>` `<`; `:` when the next character is `=`; `/` when the next character is `>` | `shouldTerminateHtmlAttrName:586-601` |
| Concise | `,` `=` `(` `;` `<`; `:` when the next character is `=`; `--` **only** when the previous character is whitespace | `shouldTerminateConciseAttrName:633-655` |
| Concise, `[ … ]` group | `,` `=` `(` `]` `<`; `:` when the next character is `=` | `shouldTerminateConciseGroupedAttrName:676-693` |

Three consequences that this document states explicitly because they are easy to
get wrong: a concise name does **not** end on `[` (`div a[b]=1` gives the name
`a[b]`, observed); neither the HTML nor the concise set ends a name on `>` or
`/>` in the other mode; and inside a `[ … ]` group a name does **not** end on
`;` or on `--`.

The **default attribute** — a value with no written name, `=expr` — has a
zero-width name span, and it is the only value the after-value rule exempts.

## Tag arguments, tag variables, tag parameters and types

**Tag arguments** `<Tag(expr)>`: a parenthesised, comma-separated argument list
([E6](#e6--tag-arguments)). A tag **must not** have both arguments and
attributes, unless it is a dynamic tag or a `<define>` call (decision 109; spec
§9). Decision 109 says the same exception covers "a body and/or attribute tags",
and that "arguments plus plain attributes remain an error" for those two tag
forms too. That is a **compiler** rule, not a parser one: the parser accepts
`<foo(a) b=1/>` and the rejection belongs to the layer that builds the call
(`assertAttributesOrArgs`, decision 109).

**Tag variables** `div/x=1`: a name, `/`, then a pattern position and an attribute
list on that variable ([E9](#e9--tag-variable)). The value after a tag variable
is the **default attribute**, and is therefore exempt from the after-value rule
(observed; divergence row "The parser after-value rule"; `patches/htmljs-parser.test.ts`
`DEFAULT_ATTRIBUTE`).

**Tag parameters** `<Tag|a, b|>` ([E7](#e7--tag-parameters-and-attribute-tag-parameters)):
patterns between pipes, parsed as TypeScript binding patterns, destructuring and
type annotations included (spec §8). Empty pipes are a no-argument function.
Parameters come before `=value` (spec §8).

**Tag type arguments** `<Tag<A, B>>` and **tag type parameters**
`<Tag <A, B>|x|>` ([E14](#e14--tag-type-arguments),
[E15](#e15--tag-type-parameters)) are TypeScript positions the parser recognises
with their own errors. **Attribute-method type parameters** `<div onClick<T>(a)/>`
are a third position ([E16](#e16--attribute-method-type-parameters)).

**Tag-level default method** `<Tag(a) { … }>`: tag arguments followed by `{`
become the default attribute's method ([E17](#e17--tag-level-default-method)).

## Attribute tags

`<@name>`, `<@name attrs>`, `<@name|p|>`: a child written with a leading `@` is
an attribute tag, not an element. Its name is a **property key**, so the `:`
split does **not** apply — `<@svg:rect>` is one name (decision 146, addendum 3;
spec §4 "Attribute tags") — while attribute-position sugar **does** apply:
`<@z .b>` gives a class. `<@children>` collides with the parent's ordinary
children; `content` is the reserved body name of an attribute tag (spec §8
"Collisions and placement").

An attribute tag is legal only directly inside a component call.

## Placeholders

`${expr}` interpolates escaped; `$!{expr}` interpolates raw (spec §3
"Interpolation"). The value ends at the matching `}` ([E8](#e8--placeholder)).
`$!{…}` inside an attribute value is text the parser accepts and the **compiler
rejects** — spec §3 attributes the refusal to "Marko's parser", which in this
repo is `@marko/compiler`'s expression parse, not htmljs-parser (observed:
`<div x=$!{a}/>` yields the value text `"$!{a}"`). Under decision 157 the layer
that must raise it is the compiler's expression parse (OQ 12).

A bare `${expr}` on its own line in a concise region is a **dynamic tag**, not a
placeholder (spec §3 "A bare `${expr}` line"). Inside an HTML-syntax body it is
always an ordinary placeholder.

## Scriptlets and statement tags

**Scriptlets** `$ statement` and `$ { … }` parse ([E11](#e11--scriptlets)) and are
rejected in lowering on every host with decision 54's message (spec §3
"Scriptlets").

**Statement tags** `static`, `import`, `export`, `server`, `client` take a
TypeScript module-level statement list ([E10](#e10--statement-tags); spec §2).
They are recognised only when the consumer returns `TagType.statement`
(`TAG_NAME.exit:80-101`), and the consumer decides that from a hard-coded set
in this repo — `packages/core/src/close-tag-opener.ts:49-55`, which reproduces
Marko 6.3.51's core taglib parse options (`@marko/compiler`'s
`babel-plugin/parser.js:341-352`, quoted at `close-tag-opener.ts:37-48`). That
set also contains `class`, so `<class>` is a statement tag too. **Spec §9.3 does
not say this**: it names only `text`, `preserveWhitespace` and `openTagOnly` as
the `parseOptions` keys a tag declaration may carry, and decision 87(a) says only
that MX reuses Marko's parser and syntax subset. The parser itself has no list
of its own.

## Text, comments, CDATA, doctype, declarations and text bodies

| Construct | Parser behaviour |
| --- | --- |
| Text | Everything that is not a tag, comment, placeholder, doctype, CDATA, declaration or scriptlet start; whitespace normalised per below |
| HTML comment | `<!-- … -->`; delimiters are stripped, and the node keeps its span so a consumer can tell an HTML comment from a `//` comment (spec §3) |
| Line / block comment | `//` to end of line, `/* … */`; never content |
| Doctype | `<!doctype …>`, delimiters stripped |
| CDATA / declaration | `<![CDATA[ … ]]>` and `<? … ?>` parse to nodes and are rejected in lowering (spec §3) |

A **text body** (`TagType.text`) is an element whose body the consumer marked as
text — `script`, `style`, `textarea`, `title` in this repo's consumer
(`close-tag-opener.ts`, the `TEXT` set, mirroring Marko's core taglib `text` parse
option). The tag type comes from the consumer's `onOpenTagName` return value,
**not** from the spec §9.3 `parseOptions` list (which carries only `text`,
`preserveWhitespace` and `openTagOnly`) and **not** from a parser-side list: the
parser has none. Such a body recognises `${…}` and `$!{…}` placeholders, and lexes
strings, template literals and JavaScript comments
(`PARSED_TEXT_CONTENT.parse:74-105`, `STATE.checkForPlaceholder`); observed:
`<script>a ${x} <b></script>` yields the placeholder `x` and the text ` <b>`.
Inside it `<![CDATA[…]]>` is literal text. Spec §3 says such a body is "a single
`MarkoText`", which contradicts the observation (OQ 13).

## Concise mode: indentation and line rules

These are the parser's rules, read from
`CONCISE_HTML_CONTENT.parse` and `OPEN_TAG.parse`:

- a concise block ends by **dedent** — `CONCISE_HTML_CONTENT.parse:65-71` closes
  every active tag whose `indent.length >= curIndent`, so a line whose indentation
  is not greater than the enclosing tag's closes it;
- a line whose indentation does not match the previous line is an error
  (`Line has extra indentation at the beginning`, `Line indentation does match
  indentation of previous line`; `CONCISE_HTML_CONTENT.parse:76-104`);
- a line must not start with a single hyphen; `--` is the delimited text form
  (`CONCISE_HTML_CONTENT.parse:121-131`);
- a line must not start with `/` unless it starts `//` or `/*`
  (`CONCISE_HTML_CONTENT.parse:132-148`);
- `;` ends the open tag's line, and only a comment may follow it
  (`OPEN_TAG.parse:146-186`, `INVALID_CODE_AFTER_SEMICOLON`);
- a line starting with `,` continues the open tag's attribute list
  (`OPEN_TAG.parse:108-142`; observed: `div x=1\n  ,y=2` is `x=1` and `y=2`);
- a line starting with `<` enters HTML mode (mixed mode;
  `CONCISE_HTML_CONTENT.parse:109-112`);
- an `[ … ]` attribute group may span lines and is bounded by `]`
  (`OPEN_TAG.parse:227-250`; the group also suppresses the concise end-of-line
  rule at `OPEN_TAG.parse:108`);
- in a tag whose children are text only, every line must start with `-`
  (`CONCISE_HTML_CONTENT.parse:86-93`);
- **a value continues onto the next line only when the character before the
  newline is an operator** — see [E2](#e2--attribute-value-concise-mode). In
  concise mode the parser never looks ahead past a newline for a continuation
  (`EXPRESSION.ts:421-422`: `checkForOperators` computes `terminatedByEOL =
  expression.terminatedByEOL || parser.isConcise` and skips the whole look-ahead
  block when that is true at a newline). A next line that is indented and starts
  with anything else — a word, `.b`, `(b)`, `!b`, `+ b`, `? b : c`, `in b` — is a
  **child tag**, not a continuation (all observed);
- every rule in this section is inherited from the parser and has no MX decision
  of its own (decisions 71, 72).

## Whitespace at the parser level

The parser owns whitespace; core and hosts must not re-normalize it (spec §3
"Whitespace"; decisions 33 and 141). The parser must apply these rules, all
observed:

1. at a body's beginning and end, leading and trailing CR/LF plus indentation are
   removed;
2. a whitespace-only run that **begins** with CR/LF is dropped and produces no
   node, so `" \n "` retains one space;
3. remaining runs collapse to one space;
4. comments are not content and do not count when trimming;
5. `${" "}` is the only escape hatch for a dropped space.

`preserveWhitespace` bypasses rules 1–4.

## Error conditions

Every diagnostic is a positioned error (spec §12) raised at the construct's own
offset. The parser's own messages, as observed:

| Condition | Message (observed) |
| --- | --- |
| `=` with no value | `Missing value for attribute` |
| `${}` empty | `Invalid placeholder, the expression cannot be missing` |
| EOF inside an attribute value (HTML mode) | `EOF reached while parsing attribute value for the "x" attribute` |
| EOF inside a default attribute | `EOF reached while parsing attribute name for the "div" tag` |
| EOF inside a tag name | `EOF reached while parsing tag name` |
| EOF inside a placeholder | `EOF reached while parsing placeholder` |
| EOF inside any other expression | `EOF reached while parsing expression` |
| EOF inside a regex | `EOF reached while parsing regular expression` |
| EOF inside a template literal's `${…}` | `EOF reached while parsing template string expression` (`TEMPLATE_STRING.ts:51`) |
| EOF inside an open tag (HTML mode) | `EOF reached while parsing open tag` |
| EOF inside a `[ … ]` group | `EOF reached while within an attribute group (e.g. "[ ... ]").` |
| A `>` preceded by whitespace inside a value, with more on the line | `Ambiguous ">" in attribute. …` |
| `</` before the open tag closes | `A close tag was found before the "div" open tag was closed. …` |
| A statement tag written in HTML mode | `The "static" tag is reserved and cannot be used as an HTML tag.` |
| A closing tag in a concise region | `The closing "div" tag was not expected` (`CLOSE_TAG.ts:85-93`, no active tag) |
| A closing tag that names a different tag | `The closing "x" tag does not match the corresponding opening "y" tag` (`CLOSE_TAG.ts:117-126`) |
| Concise line starting with `-` | `A line in concise mode cannot start with a single hyphen. Use "--" instead.` |
| Concise line starting with `/` | `A line in concise mode cannot start with "/" unless it starts a "//" or "/*" comment` |
| Mismatched groups | `Mismatched group. …` |
| Code after `;` on a concise line | the parser reports it; see OQ 10 |
| An HTML comment inside an open tag | the parser reports it; see OQ 10 |
| Type parameters where none are allowed | `Attribute cannot contain type parameters unless it is a shorthand method` |
| A `<…>` list after a tag name followed by neither `|` nor `(` | `Unexpected types. Type arguments must directly follow a tag name and type paremeters must precede a method or tag parameters.` |
| Whitespace after a tag variable's `/` | `A slash was found that was not followed by a variable name or lhs expression` |
| A line inside a `TagType.text` tag that does not start with `-` | `A line within a tag that only allows text content must begin with a "-" character` |

Semantic rejections raised outside the parser: scriptlets (decision 54), CDATA
and declarations (spec §3), duplicate attributes (decision 135), a second `:` in
a tag head and a bare `:` in attribute position (divergence rows), `::name`
(decision 156.5), sugar after a default value (decision 151, ruling 2).

## Expression boundaries

Every position where a TypeScript expression, statement list, type,
type-parameter list or parameter list can appear in MX source. For each: what
starts it, what stops it, whether the stop is hard or soft, and what overrides
TypeScript's own grammar.

Rules that hold at **every** position below:

- **R1 — grouping.** `(`, `[`, `{` open a group. No stop character may end a
  value inside an open group, at any depth.
- **R2 — angle brackets in a type, and when the type context ends.** `<` opens a
  group **only** while the parser is in a type context, and the matching `>`
  closes it (`EXPRESSION.ts:263-273` and `:277-306`). A `>` at the top of the
  group is consumed as a closing bracket only when `inType` is set **and** the
  previous character is not `=`; otherwise it is just a character
  (`EXPRESSION.ts:278-283`). `inType` is **entered** by a `:` at depth 0 with an
  open ternary count of 0 (`EXPRESSION.ts:188-197`), and by `as`/`satisfies` in
  the look-ahead (`:617-623`), where `forceType` is set when no ternary or group
  is open. It is **left** by an `=` that is not `=>` (`:198-215`), by a `{` that
  is not preceded by an operator (`:243-256`), and by an explicit reset on the
  next `=` after a type. Consequence: a value in a type context does not end at
  `=` or `<` — `x=a as T = b` and `x=a as T < b` are each **one** value
  (observed). Outside a type context `>` ends an HTML-mode value. This is what
  separates two observed cases:

  ```mx
  <!-- Example: a type argument list is a group, so the value survives the `>`. -->
  <div x=a as Map<K, V>/>

  <!-- Example: not a type context, so `>` ends the tag and the value is `f<T`. -->
  <div x=f<T>(y)/>
  ```

  (Both observed; the htmljs fixtures `ts-generic-complex` and
  `ts-generic-simple` cover the same shape.)
- **R3 — opaque spans.** String literals, template literals (whose `${…}` parts
  are parsed as nested expressions), regular expressions and comments. A `/`
  that can follow a division is an operator; otherwise it starts a regex. The
  decision is made from the previous significant character.
- **R4 — whitespace.** Stated per position; see [E1](#e1--attribute-value-html-mode).
- **R5 — end of input.** Stated per position. The rule is
  `EXPRESSION.ts:336-341`: if no group is open and the parser `isConcise` or the
  position is `terminatedByEOL`, the value **terminates silently**; otherwise the
  EOF error is chosen by the **parent state** (`EXPRESSION.ts:343-389`). So
  end of input terminates a concise-mode value only when no group is open, and
  the observed result per position is:

  | Position | Input | Observed at end of input |
  | --- | --- | --- |
  | E1/E2 attribute value, HTML | `<div x=(a` | `EOF reached while parsing attribute value for the "x" attribute` |
  | E1/E2 attribute value, concise | `div x=(a` | the same error — concise mode terminates at EOF only with **no open group** |
  | E1 default attribute, HTML | `<div =(a` | `EOF reached while parsing attribute name for the "div" tag` (`EXPRESSION.ts:349-360`, the `!attr.spread && !attr.name` branch) |
  | E1 template string, concise | `` div x=`a `` | `EOF reached while parsing template string expression` (`TEMPLATE_STRING.ts:51`) |
  | E3 spread | `<div ...(` | `EOF reached while parsing attribute value for the ... attribute` |
  | E4 attribute arguments | `<div onClick(a` | `EOF reached while parsing attribute value for the "onClick" attribute` — the parent-state switch is keyed on the parent **state**, not on the attribute's stage, so E1 and E4 share a message |
  | E6 tag arguments | `div(a` | **no error** — tag arguments are not whitespace-terminated, so the expression runs to `maxPos` and `isConcise` terminates it (`EXPRESSION.ts:336-341`) |
  | E8 placeholder | `-- ${a` | `EOF reached while parsing placeholder` |
  | E10 statement tag | `static const x = (` | `EOF reached while parsing expression` |
  | E11 scriptlet block | `$ {a` | **no error** — see the note below |
  | E13 dynamic tag name | `<div ${a` | `EOF reached while parsing attribute name for the "div" tag` |
  | E14/E15/E16 type lists | `<foo<A` | `EOF reached while parsing expression` |

  Two of these rows are worth stating rather than tabulating: a concise value
  with an open group does **not** terminate silently (`div x=(a` errors), and a
  scriptlet block `$ {a` **does** terminate silently even with the `{` group
  open. Both are parser behaviours with no source of truth behind them (OQ 19).
- **R6 — atoms** (decision 156.1): `:name` is lexed where an expression is
  expected. Decision 156.1 itself rules only on the three **in** positions —
  attribute values, `${}`, and tag arguments — and only one **out**: "never
  inside `static`/`import`/script blocks". The wider exclusion list (scriptlets,
  method bodies, tag parameters, the tag variable, spreads) and the
  "never after `.`, `?.`, `as`, `satisfies`" rule come from the atoms prototype
  report — `scratch/reports/squad-atoms/parser-approach.md` §1d and §2, test-table
  row 9 — which is **evidence, not a decision**. Those parts are **not settled**
  (OQ 14).

### E1 — Attribute value, HTML mode

- **Start:** the first non-whitespace character after `=`, or after `:=` for a
  bound value (`ATTRIBUTE.parse:84-107`: the value branch consumes the `=`, `:=`
  or `...` and then calls `consumeWhitespace()`). `x= :b` starts at `:b`: the
  whitespace after `=` is consumed by the parser and is not part of the value
  (observed).
- **Stops** (`shouldTerminateHtmlAttrValue:603-631`):

  | Character | Hard or soft | Condition |
  | --- | --- | --- |
  | `,` | hard | — |
  | `/>` | hard | the `/` when the next character is `>` |
  | `>` | soft | it terminates **unless** it is at the value's first character, unless the previous character is `=` (that is `=>`), and unless it is preceded by whitespace and followed by `=` (that is `>=`). Every other `>` terminates the value |
  | whitespace | soft | see below |
  | end of input | — | EOF error, see R5 below |

- **Whitespace rule.** The position is created with `terminatedByWhitespace =
  true` and `operators = true` (`ATTRIBUTE.parse:105-113`). At depth 0 a
  whitespace run ends the value **unless** `checkForOperators`
  (`EXPRESSION.ts:408-462`) carries it across, and it does so when either of the
  two following holds, and in both cases the next non-space character is not
  `</` (HTML mode) and not `<!--`:

  - **an operator before the whitespace** — `lookBehindForOperator`
    (`EXPRESSION.ts:464-555`): the characters `&` `*` `^` `:` `=` `<` `%` `|` `?`
    `~`; a `!`, which is an operator **unless** it follows an operand (a closing
    `)`/`]`/quote or an identifier, and unless the identifier is `in`/`instanceof`),
    so a postfix non-null assertion does not continue; a `>`, which is an operator
    when it is **not** in a type context and **is** an operator when it is the
    `>` of `=>` (the branch returns the position of the `=`); a `.` followed by a
    word character; a `+` or `-`, **except** when it is the second character of a
    `++`/`--`, where the check recurses further back and so a postfix increment
    does not continue; or a whole-word unary keyword — `async` `await` `class`
    `function` `new` `typeof`, plus `delete` and `void` outside a type, plus
    `asserts` `infer` `is` `keyof` `readonly` `unique` inside one
    (`EXPRESSION.ts:35-57`, selected at `:551`). `return`, `throw` and `yield`
    are deliberately absent: JavaScript forbids a line break after them, so they
    never continue.
  - **an operator after the whitespace** — `lookAheadForOperator`
    (`EXPRESSION.ts:557-635`), and **only when the next non-space character is
    not itself a stop of this position**, because `checkForOperators` calls
    `shouldTerminate` on the looked-at character first (`EXPRESSION.ts:439-444`).
    That is why `x=a > b` is not one value while `x=a >= b` is. The characters are
    `&` `*` `^` `!` `<` `%` `|` `~` `+` `-`; `/` `{` `(` `>` `?` `:` `=`; a `.`
    followed by a word character; or one of the binary keywords `as` `extends`
    `instanceof` `in` `satisfies` (`EXPRESSION.ts:59-67`) followed by whitespace
    and then an operand that is not one of `:` `,` `=` `/` `>` `;`
    (`EXPRESSION.ts:608-625`).

  In HTML mode this rule also applies **across a newline**, because the
  position is `terminatedByWhitespace`, not `terminatedByEOL`
  (`EXPRESSION.ts:421-422`). Observed: `<div x=a\n  <span/>` is the single value
  `a\n  <span`. In concise mode it does not; see [E2](#e2--attribute-value-concise-mode).

  A real TypeScript expression parser continues in different places, and the
  default's failures are documented, not fixed (OQ 2): `x=a [0]` is two
  attributes (`[0]` is an attribute name), `` x=a `t` `` is two attributes, while
  `x=a {b}` and `x=a: b` are one value each although TypeScript cannot parse
  either. The one input on which the patched and stock parsers differ is
  `x=a ?? b :c`, which is the patch's `??` rule below.
- **Overrides:**
  - **after-value sugar.** When the attribute **whose value is being read** has a
    name or is a spread, and whitespace immediately precedes the character, then
    a `:` followed by an identifier start (or a bare end of tag/line), with **no
    open `?`** in the value, ends the value and begins a new attribute; and so
    does a `.` followed by an identifier start (divergence row "The parser
    after-value rule"; decision 146, divergence 3; decision 151, ruling 2).
  - **`?` depth.** `?` increments a ternary counter; `:` at depth 0 starts a
    type annotation, at depth > 0 it closes a ternary.
  - **`??` and `?.`.** In an attribute value, a `?` immediately followed by `?`,
    or by `.` not followed by a digit, is consumed as one operator and does not
    open a ternary. On the stock parser `x=a ?? b` and `x=a?.b` are also one
    value; the patch matters only when a sugar follows (`x=a ?? b :c`,
    `x=a ?.b :c`). **Patch behaviour; not settled** (OQ 3).
  - **`.` followed by a digit** does not end the value, so `x=a .2xl` stays one
    value (observed; `patches/htmljs-parser.test.ts` pins it). **Not settled**
    (OQ 4).
  - **a bare `:`** before `/>`, `>` or the end of the line also ends the value,
    so the sugar error can name it (divergence row "The parser after-value
    rule").
  - **default attribute exemption.** When the attribute has **no** name, none of
    the after-value rules apply (decision 151, ruling 2; observed).
- The whitespace that ends a value belongs to neither the value nor the next
  attribute's range.

### E2 — Attribute value, concise mode

- **Start:** as E1 (`ATTRIBUTE.parse` consumes the `=`/`:=`/`...` and the
  following whitespace).
- **Stops** (`shouldTerminateConciseAttrValue:657-674`):

  | Character | Hard or soft | Condition |
  | --- | --- | --- |
  | `,` | hard | — |
  | `;` | hard | — |
  | `--` | hard | **only** when the previous character is whitespace |
  | whitespace | soft | see below |
  | end of input | — | **terminates** the value, no EOF error |

  Inside a `[ … ]` group the stop set is instead `,` and `]`
  (`shouldTerminateConciseGroupedAttrValue:695-701`), and the group suppresses
  the end-of-line rule in `OPEN_TAG.parse:108`.

- **Whitespace rule — the one that differs from E1.** The **look-behind** half of
  E1's whitespace rule applies in full. The **look-ahead** half does **not**
  apply across a newline in concise mode: `checkForOperators` sets
  `terminatedByEOL = expression.terminatedByEOL || parser.isConcise` and skips
  the entire look-ahead when that is true and the whitespace was a newline
  (`EXPRESSION.ts:416-422`). So a newline continues the value **only** when the
  character before it is an operator in `lookBehindForOperator`'s list, and a
  next line that is indented and begins with anything else is a **child tag**.
  Confirmed by probe, all in concise mode:

  | Input | Observed |
  | --- | --- |
  | `div x=a\n  b` | value `a`, then the child tag `b` |
  | `div x=a\n  <span/>` | value `a`, then the child tag `span` |
  | `div x=a\n  .b` | value `a`, then an unnamed child tag with class `b` |
  | `div x=a\n  (b)` | value `a`, then a child tag with tag arguments `b` |
  | `div x=a\n  !b` | value `a`, then the child tag `!b` |
  | `div x=a\n  + b` | value `a`, then the child tag `+` with attribute `b` |
  | `div x=a\n  ? b : c` | value `a`, then the child tag `?` |
  | `div x=a\n  in b` | value `a`, then the child tag `in` |
  | `div x=a\n  {b}` | value `a`, then the child tag `{b}` |
  | `div x=a +\n  b` | **one** value `a +\n  b` |

  The last row is the look-behind half working; the nine above it are the
  look-ahead half not applying. TypeScript, by contrast, continues across the
  newline in all of them (OQ 2, OQ 18).
- **Overrides:** identical to E1, including the default-attribute exemption.

### E3 — Spread attribute

- **Start:** the first non-whitespace character after `...`. The parser skips
  exactly the three dots and **not** the whitespace after them
  (`ATTRIBUTE.parse:96-98`, `this.pos += 3`), so the stock value range
  **includes** the whitespace between `...` and the expression; `<div ... props/>`
  yields the value text `" props"` (observed).
- **Stops:** as E1 (HTML) or E2 (concise) — the same position is used, with
  `attr.spread = true`.
- **Overrides:** the patch applies the after-value rules to a spread as well as
  to a named attribute, so `...props .b` is a spread plus a class sugar
  (observed; `patches/htmljs-parser.test.ts` pins it). **Not settled** — the
  spec text does not distinguish spreads (OQ 5).

### E4 — Attribute arguments

`onClick(a, b)`:

- **Start:** the first non-whitespace character after `(`.
- **Stops:** the matching `)` (hard).
- **Overrides:** none beyond R1–R3. Inside the parentheses the after-value rules
  do not apply (grouping).
- **Atoms:** unruled (OQ 14).

### E5 — Attribute method body

`onClick() { … }`:

- **Start:** the `{`.
- **Stops:** the matching `}` (hard).
- **Overrides:** the body is a **statement list**, not an expression. Atoms are
  excluded here by the atoms prototype report, not by a decision (OQ 14).

### E6 — Tag arguments

`<Tag(expr)>`:

- **Start:** the first non-whitespace character after `(`.
- **Stops:** the matching `)` (hard).
- **Overrides:** none beyond R1–R3.

### E7 — Tag parameters and attribute-tag parameters

`<Tag|a, b|>`, `<@name|x|>`:

- **Start:** the first non-whitespace character after `|`.
- **Stops:** the next `|` at depth 0 (hard).
- **Overrides:** each item is a **binding pattern**, optionally with `: Type` and
  an initialiser. The parser hands the span to a pattern parser, not an
  expression parser. A union type or a bitwise `|` inside a parameter list ends
  the list in the default parser (`|x: A | B|` is `|x: A |` and `B|`), so a union
  must be parenthesised — **not settled** (OQ 6). Atoms are unruled (OQ 14).

### E8 — Placeholder

`${expr}`, `$!{expr}`:

- **Start:** the first non-whitespace character after `${` or `$!{`.
- **Stops:** the matching `}` (hard).
- **Overrides:** atoms are lexed here — decision 156.1 names `${}` explicitly.

### E9 — Tag variable

`div/x=1`:

- **Start:** the character immediately after `/`. There is **no** whitespace skip:
  `OPEN_TAG.parse:305-314` reads `/`, advances past it, and if the next character
  is whitespace it raises `A slash was found that was not followed by a variable
  name or lhs expression`. Observed: `<div/ x/>` is that error.
- **Expression flags:** `operators = true` and `terminatedByWhitespace = true`
  (`OPEN_TAG.parse:315-320`), so E1's **look-behind** whitespace rule applies here
  too and E1's **look-ahead** rule does not (the position is not `terminatedByEOL`,
  so a newline takes the look-ahead path, but concise mode still supplies
  `terminatedByEOL` through `parser.isConcise`). Observed: `<div/x y=1/>` is the
  variable `x`; `<div/x + 1 y=1/>` is the variable `x + 1`.
- **Stops:**

  | Character | HTML mode | Concise mode |
  | --- | --- | --- |
  | `|` | hard | hard |
  | `,` | hard | hard |
  | `=` | hard | hard |
  | `(` | hard | hard |
  | `;` | — | hard |
  | `<` | hard **unless** `expression.inType` | same |
  | `--` | — | hard (any `--`, no whitespace-before requirement, unlike an attribute value) |
  | `:` | hard when the next character is `=` | same |
  | `>` | hard | — |
  | `/>` | hard | — |

  Sources: `shouldTerminateHtmlTagVar:554-576`, `shouldTerminateConciseTagVar:530-552`.
  `>` and `/>` are stops **only in HTML mode**: `div/x>1` is the variable `x>1`
  (observed).
- **The value that follows is the default attribute** and is exempt from the
  after-value rule, exactly like `<if=a .b>` (observed;
  `patches/htmljs-parser.test.ts` `DEFAULT_ATTRIBUTE`, `<a/x=…>` and
  `<const/x=…>` rows; divergence row "The parser after-value rule"; decision 151,
  ruling 2). A named attribute after the default value still splits.

### E10 — Statement tags

`static`, `import`, `export`, `server`, `client`, recognised when the consumer
returns `TagType.statement`:

- **Constraints:** concise mode only (`<static …/>` in HTML mode is
  `The "static" tag is reserved and cannot be used as an HTML tag.`) and root
  only (both observed).
- **Start:** the first non-whitespace character after the keyword
  (`prepareStatement`, `TAG_NAME.ts:194-201`, which calls `prepareScriptlet`
  with `this.pos + 1`).
- **Stops:** the **end of the line** — `prepareScriptlet` sets
  `terminatedByEOL = true` (`INLINE_SCRIPT.ts:83-90`), and `prepareStatement`
  additionally sets `consumeIndentedContent = true`, so an indented next line
  continues it. The value also continues past a newline while a group is open or
  a trailing operator continues it (E1's whitespace rule; observed:
  `static const x = 1\n<div/>` ends at the newline, and
  `static const x = (\n  a)` does not). There is **no** `/>`, **no** close tag,
  and it does **not** run to the end of the region. The test that pins "no
  attributes are parsed" is `patches/htmljs-parser.test.ts`'s `statement tags`
  block (`describe("statement tags")`, `:235-253`), not a decision.
- **Type context:** `prepareScriptlet` sets `inType`/`forceType` when the code
  begins with `declare`, `interface` or `type` followed by a type name
  (`INLINE_SCRIPT.ts:76-130`), so a `static declare` or `static interface`
  statement is read as a type. `x=return b` and `x=throw b` do not continue
  (observed) because those keywords are absent from `unaryKeywords`.
- **Overrides:** none. This is TypeScript's own statement grammar. Atoms are not
  lexed (decision 156.1).

### E11 — Scriptlets

`$ statement`, `$ { … }`:

- **Start:** in HTML mode only at the **beginning of a line** — `HTML_CONTENT.parse:126-136`
  requires `$`, then whitespace, then `isBeginningOfLine(this)`
  (`HTML_CONTENT.ts:206-222`, which scans back to the last newline); observed,
  `<p>x $ const a</p>` gives text. In concise mode `$` must be followed by
  whitespace (`CONCISE_HTML_CONTENT.parse:113-118`), which is not a
  beginning-of-line test, because a concise `$` is always at the start of a line.
- **Stops:** end of line for the statement form, unless an open group or a
  trailing operator continues it (`prepareScriptlet` sets `operators = true` and
  `terminatedByEOL = true`, `INLINE_SCRIPT.ts:83-90`; observed:
  `$ const a = 1 +\n    2` is one scriptlet); `}` for the block form, followed by
  an optional `;` (`INLINE_SCRIPT.return`).
- **Overrides:** none. Rejected in lowering by decision 54.

### E12 — Delimited HTML blocks

**`-- text` (single-line block).** The line's remainder is a **single-line HTML
block**: `BEGIN_DELIMITED_HTML_BLOCK.parse:65-72` sees content after the `--`,
calls `beginHtmlBlock(undefined, true)`, and tags and placeholders in it are
parsed. Observed: `-- hi ${x} <b>y</b>` yields the text `hi `, the placeholder
`x`, the text ` `, the tag `b`, the text `y`; htmljs fixture
`concise-contentplaceholder-start` is `-- ${data.name}`. The escape hatch for a
line of literal text is `-- ${expr}` in spec §3 "Text lines", which is this same
single-line-block rule, not a different one.

**`--` alone on a line (multi-line block).** The body is again **HTML, not
text**: `beginHtmlBlock(block.delimiter, false)`
(`BEGIN_DELIMITED_HTML_BLOCK.parse:50-55`) with the delimiter string recorded.
Observed: `--\n<b>${x}</b>\n--` yields the tag `b` and the placeholder `x`; htmljs
fixture `multiline-html-block` parses `<strong>` the same way.

**Where a multi-line block ends** (`handleDelimitedBlockEOL:101-157`), in order:

1. the line begins with `indent + delimiter` — the block ends. `---` therefore
   closes with `---`. A closing delimiter may be followed only by whitespace, or
   the parser reports `A concise mode closing block delimiter can only be
   followed by whitespace.`;
2. the line begins with `indent` — the block **continues**, and the indent is
   consumed as part of the block. A line at the **same** indentation as the
   opening `--` therefore stays inside the block;
3. the line is not blank and does not begin with `indent` — the block **ends**,
   and the line is reprocessed in the enclosing region. This is the only
   indentation-based end: a line with **less** indentation than the opening `--`
   ends the block, and a line with equal indentation does not;
4. the line is blank — the block continues.

Observed: `div\n  --\n    a\n  span` yields the text `"  a\n"` and then the
**text** `span` — `span` was at less indentation than the block's `    `, so it
ended the block and was read as body content. Observed: `--\n  a\n  b\n--` is the
text `"  a\n  b"`.

### E13 — Dynamic tag name and dynamic shorthand

`<${expr} …>` and `<div.${x}>` / `<div#${x}>`:

- **Start / stops:** as E8.
- **Overrides:** the `:` split does not apply; what follows the closing `}` is
  read as shorthands and then as attributes.

### E14 — Tag type arguments

`<Tag<A, B>>`:

- **Start:** the `<` **directly after the tag name, with no whitespace**.
  `OPEN_TAG.return`'s `TAG_STAGE.TYPES` branch decides between type arguments and
  type parameters with `tag.tagName.end === types.start` (`OPEN_TAG.ts:488-492`);
  with whitespace before the `<` the equality fails and the list is **type
  parameters**, not type arguments.
- **Stops:** the matching `>` (hard; the expression runs with `inType = true`,
  `forceType = true` and `shouldTerminate = matchesCloseAngleBracket`,
  `OPEN_TAG.parse:360-368`), so nested generics and `,` are fine.
- **Overrides:** none; TypeScript's own grammar. If the list is followed by
  anything other than `|` or `(`, the parser reports `Unexpected types. Type
  arguments must directly follow a tag name and type paremeters must precede a
  method or tag parameters.` (`OPEN_TAG.ts:499-511`). Observed: `<foo<A>/>` is
  type arguments `A`; `<foo <A>>` is that error; `<foo<A> |x|/>` is type
  arguments `A` **and** parameters `x`; `<foo <A>|x|/>` is type parameters `A`
  and parameters `x`; `<foo <A>(a) {x}/>` is a tag-level default method whose
  method range starts at the `<`. htmljs fixtures `tag-with-type-arguments`,
  `tag-params-with-type-parameters`, `invalid-*type*`.

### E15 — Tag type parameters

`<Tag <A, B>|x|>` and `<Tag <A, B>(x) { … }>`:

- **Start / stops:** the same `<…>` position as E14, but **after whitespace**, so
  `tag.tagName.end !== types.start` and the list is type parameters.
- **Overrides:** after the closing `>` the next non-whitespace character **must**
  be `|` with no parameters yet, or `(` with no type parameters, no parameters and
  no arguments (`OPEN_TAG.ts:494-511`); the `(` form is stored as
  `tag.typeParams`, and any other next character is the `Unexpected types. …`
  error. htmljs fixture `tag-params-with-type-parameters`.

### E16 — Attribute-method type parameters

`<div onClick<T>(a) { … }>`:

- **Start:** the `<` after the attribute **name**, before the `(` — not after
  the `(`. `ATTRIBUTE.parse:126-137` enters the type-parameter branch only when
  `attr.stage === ATTR_STAGE.NAME` (or a pending `async` is held), that is, before
  any `(`, `=` or `{` has been seen for this attribute. Observed:
  `<div onClick<T>(a) {x}/>` and `<div onClick <T>(a) {x}/>` are both shorthand
  methods (whitespace is allowed before the `<`); `<div onClick<T>/>` is the error
  below.
- **Stops:** the matching `>` (hard), after which `consumeWhitespaceIfBefore("(")`
  **must** succeed (`ATTRIBUTE.return`, the `ATTR_STAGE.TYPE_PARAMS` branch,
  `:296-311`).
- **Overrides:** type parameters are allowed **only** on a shorthand method;
  elsewhere the parser reports `Attribute cannot contain type parameters unless
  it is a shorthand method`. An attribute may not have both type parameters and
  arguments (the `ATTR_STAGE.ARGUMENT` branch, `:216-224`). htmljs fixtures
  `attr-method-with-type-parameters`, `invalid-*type*`.

### E17 — Tag-level default method

`<Tag(a) { … }>`:

- **Start:** the first non-whitespace character after `(` for the arguments, the
  `{` for the body.
- **Stops:** `)` and `}` (both hard).
- **Overrides:** this is how a sugar followed by `(params) { body }` parses: the
  parser sees the written tag name including its `:` (`<input:email(a) {…}/>`
  yields the tag `input:email` plus a default method — observed), and decision
  146, addendum 4 makes the result `name="email"` with a default value.

### E18 — Types, type arguments and type parameters in expressions

TypeScript's own type positions are not separate MX syntax: inside every
position E1–E13 the parser must let the type parser consume `as`, `satisfies`,
generic arguments and annotations and take the end offset back. The stop
characters of each position still apply, which is why `x=a > b` inside a tag is
handled by E1's `>` rule and not by the type parser.

## Dialect rules

### `:name`, `#id` and `.class` in any position

1. **Tag-adjacent:** `#x` sets an id, `.x` a class, `:x` a name, in **any
   order**, on a named tag or the unnamed tag (decision 146, addendum of
   23:23).
2. **Attribute position, first:** the same three sugars before any other
   attribute are rewritten to id, class and name before the shorthand merge
   (spec §4 "Name sugar").
3. **Attribute position, after a value:** see
   [E1](#e1--attribute-value-html-mode). The default attribute is exempt
   (decision 151, ruling 2).
4. **`:name` names:** `[A-Za-z_$][\w$-]*` (spec §4). A static tag name splits at
   its first `:`; the static part of a shorthand class or id splits the same way;
   a second `:` in a tag head is an error.
5. **A sugar followed by `=value` or `(params) { body }`** sets the tag's
   **default attribute** (decision 146, addendum 4). The error is only "the tag
   already has a default value".
6. **Left alone:** an attribute tag's own name, `<@svg:rect>` (decision 146,
   addendum 3); the explicit `value:x`, `class:x`, `style:x` and
   `value:fn:=x` (decision 146, divergence 2; spec §4); a dynamic tag name;
   a bound attribute; the default attribute (decision 151, ruling 2).
7. **Repeated or adjacent sugars** follow the duplicate rule: the later one wins,
   with a warning (decision 135; spec §4 "Name sugar"). Observed: `x=a :b :c`
   parses as three attributes; `x=a ? b : c :d :e` as four.
8. **Wildcard children (decision 147).** A child keeps its **authored** name:
   `<att>` is the tag `att`, checked against the matched entry's contract; only
   `<:att>` yields a child whose name attribute is `att`. Decision 147 adds no
   syntax, so the parser is unaffected.
9. **defaultTag, where it affects parsing (decision 145).** The unnamed tag keeps
   an **empty** name range; the parser must not write a host name into it. The
   name is resolved afterwards by the ladder: parent contract `defaultTag` → user
   `package.json#mx.<target>.defaultTag` → host override → target built-in. A
   `defaultTag` value whose parse shape is not a plain tag (void, text or
   whitespace-preserving built-ins such as `input`, `script`, `textarea`, `pre`)
   is an error **at the declaration**, never at the use site.
10. **Atoms (decision 156).** `:name` in an MX expression position is a value
    representing itself, whose runtime value is the name as a string literal.
    `::` is one reserved token for a future `Symbol.for` sugar, and the lexer
    raises the reserved error at the `::` column.

### Ternary depth, and the `??` / `?.` exceptions

- `?` opens a ternary and increments a depth counter; the matching `:` closes it.
  A ternary inside a group, a template's `${…}` or a comment holds no depth.
- A `:` at depth 0 starts a type annotation — unless the after-value rule
  applies, which needs a named (or spread) attribute, whitespace before it, an
  identifier start or a bare end after it, and depth 0.
- `??` and `?.` (with `.` not followed by a digit) are one operator and never
  open a ternary. `?:` is **not** an exception: it goes through the ternary
  counter, so `x=a ?:b` is one value (observed).

## Ambiguous inputs

Each row gives the input and the parse the grammar requires. "Observed" means
the event stream the **patched** 5.18.0 parser produced for that input, with
the stock parser agreeing unless the row says otherwise; the runs and the
rule-by-rule table are in `scratch/reports/mx2/grammar-spec-r2.md`.

| Input | Required parse | Settled by |
| --- | --- | --- |
| `x=a ? b : c` | one value, a ternary | default (observed) |
| `x=a :b` | value `a`, then a `name` sugar | decision 146, divergence 3 (observed) |
| `x=a.b .c` | value `a.b`, then a class sugar | decision 146, divergence 3 (observed; breaking) |
| `x=(a) :T => a` | value `(a)`, then a `:T` sugar with no value → `Missing value for attribute` | decision 151, ruling 3 (observed) |
| `x=(a): T => a` | one value | default (observed) |
| `x=a ?? b` | one value | default (observed) |
| `x=a?.b` | one value | default (observed) |
| `x=a?.b :c` | value `a?.b`, then a `name` sugar | decision 146, divergence 3 (observed) |
| `x=a < b` | one value | default (observed) |
| `x=f<T>(y)` | value `f<T`; `>` ends the tag; `(y)/>` is body text (observed). For the TypeScript-parser design this is **NOT SETTLED** | default; OQ 7 |
| `x=a > b` with no later `>` on the line | value `a`, the tag closes at the `>`, the body is the text ` b` | default (`shouldTerminateHtmlAttrValue`; observed `<div x=a > b</div>`) |
| `x=a > b` with a later `>` or `/>` on the same line | `Ambiguous ">" in attribute. …` | default (`detectAmbiguousCloseAngleBracket:389-521`; observed `<div x=a > b/>` and `<div x=a > b>`); OQ 8 |
| `x=a as T` | one value | default (observed) |
| `x=a satisfies T` | one value | default (observed) |
| `x=a! .c` | value `a!`, then a class sugar | decision 146, divergence 3 (observed) |
| `x=/re/ .c` | value `/re/`, then a class sugar | decision 146, divergence 3 (observed) |
| `x=a as Map<K, V>` | one value | default, R2 (observed) |
| `x=a [0]` | value `a`, then an attribute named `[0]` | default (observed); OQ 2 |
| `x=a {b}` | one value, although TypeScript cannot parse it | default (observed); OQ 2 |
| `x=a: b` | one value, although TypeScript cannot parse it | default (observed); OQ 2 |
| `` <div x=a `t`/> `` | value `a`, then an attribute **named** `` `t` `` | default (observed; `shouldTerminateHtmlAttrName` does not end on a backtick) |
| `x=a .2xl` | one value | patch pins it; **not settled** — OQ 4 |
| `x=a :b :c` | value `a`, then two `name` sugars; last wins with a warning | decision 135, decision 146, spec §4 (observed) |
| `x=a ?:b` | one value | default (observed); whether it should be an error is OQ 3 |
| `x= :b` | value `:b` — the atom `"b"` | default (observed); decision 156.1 makes a `:name` in an attribute value an atom |
| `x=a ? :b :c` | one value `a ? "b" : c` | atoms report **§5** test-table row 6 — **NOT SETTLED**, OQ 9 |
| `x=a :: b` | **NOT SETTLED.** Observed in a tag as `<div x=a :: b/>`: the single value `a :: b` — `::` after whitespace is a `:` that opens a type context, and the stock parser has no `::` token. Decision 156.5 reserves `::name` only when the `::` directly precedes a name; nothing rules on `::` followed by a space | no source; decision 156.5 covers `::name` only |
| `<div x=::a/>` | the reserved `::` error at the `::` column | decision 156.5; atoms report §5 test-table row 7 |
| `div x=a\n  <span/>` (concise) | value `a`, then the **child tag** `span` — the newline ends the value | `checkForOperators` skips the look-ahead in concise mode at a newline (`EXPRESSION.ts:421-422`); OQ 18 |
| `div x=a\n  .b` (concise) | value `a`, then an unnamed child tag with class `b` | same; OQ 18 |
| `div x=a\n  (b)` (concise) | value `a`, then a child tag with tag arguments `b` | same; OQ 18 |
| `div x=a\n  + b` (concise) | value `a`, then the child tag `+` | same; OQ 18 |
| `div x=a +\n  b` (concise) | one value `a +\n  b` | `lookBehindForOperator` (`EXPRESSION.ts:464-555`); OQ 18 |
| `<div x=a\n  <span/>` (HTML mode) | the single value `a\n  <span` — the look-ahead **does** apply across a newline here | `terminatedByEOL` is false for an HTML attribute value (`EXPRESSION.ts:421-422`); OQ 2 |
| `<input type="email" :email>` | `type="email"` then `name="email"` | decision 146, divergence 3 (observed) |
| `<:email/>` | unnamed tag, `name="email"` | decision 145; atoms invariant table |
| `<input:email/>` | tag `input`, `name="email"` | decision 146, divergence 1; observed as tag `input:email` |
| `<input :email/>` | `name="email"` first | decision 146; observed as an attribute named `:email` |
| `<input#main:email.big/>` | id, name, class in written order | decision 146, addendum of 23:23 |
| the six orders of the tag-adjacent sugars | each sugar keeps its meaning | decision 146, addendum of 23:23 |
| `<input #main/>`, `<input .big/>` | id, class | decision 146 |
| `<input :email type="email"/>` | `name` first | decision 146 |
| `<input x=1 #main .big :email/>` | four attributes in written order | decision 146; observed as names `#main`, `.big`, `:email` |
| `<input x=a.b .c/>` | as `x=a.b .c` above | decision 146, divergence 3 |
| `<input:email=1/>` | `name="email"` and default value `1` | decision 146, addendum 4 |
| `<input :email=1/>` | `name="email"` and default value `1` | decision 146, addendum 4 (spec §4 still calls it an error — OQ 11) |
| `<input:email(a) { return a; }/>` | `name="email"`, default value a function | decision 146, addendum 4; observed as tag `input:email` + default method (E17) |
| `<input #main(a) {}/>` | id and default value a function | decision 146, addendum 4 |
| `<input x=1 :/>`, `<input :/>` | positioned error, bare `:` | decision 146, divergence 2; patch pinned |
| `<a:b:c/>` | positioned error, one name per tag | divergence row "A static tag name may not contain `:`" (the second-`:` clause); spec §4; decision 146 |
| `<if=a\n .b>x</if>` | one value; the default attribute is exempt | decision 151, ruling 2 (observed) |
| `<const/x=items\n .filter(Boolean)/>` | one value | decision 151, ruling 2 (observed) |
| `<div class:x=1/>` | Marko's refusal (`class:x` is reserved on native elements) | spec §4 "class/style modifiers"; observed as the attribute `class:x` |
| `<div style:x=1/>` | same, `style:x` | spec §4 "class/style modifiers"; observed as the attribute `style:x` |
| `<input value:fn:=x/>` | a bound `value:fn` | decision 146, divergence 2 |
| `<div><@svg:rect/></div>` | an attribute tag named `svg:rect` — **an error**, attribute tags on a native element | decision 146, addendum 3; `divergences.md` "Deferred to MX 2" |
| `x=a ? b :c` | one value | atoms report §4 invariant table |
| `x=a ?? b :c` | value `a ?? b`, then a name sugar | patch; **not settled** — OQ 3 |
| `<div x=a ?.b :c/>` | value `a ?.b`, then a name sugar | patch; **not settled** — OQ 3 |

## Open questions for mx-lead

One line each. None is resolved in the normative text.

1. **End offset from the expression parser.** The vendored `@babel/parser` has
   no entry point returning where an expression stopped; `startIndex` fixes only
   the start. *Recommendation:* the parser lead owns a thin wrapper that returns
   `{ node, endIndex }`, built before any of the other questions matter.
2. **Where the default whitespace rule and TypeScript continuation diverge.**
   The full table is [Where a real TypeScript parser would end the value
   differently](#where-a-real-typescript-parser-would-end-the-value-differently)
   below. *Recommendation:* keep the stock rule as normative default, and adopt
   TypeScript's continuation only for inputs the stock rule rejects.
3. **`??`, `?.` and `?:`.** The skip is in the patch and pinned by tests, but no
   spec paragraph or decision states it, and `?:` is not an exception (it goes
   through the ternary counter). *Recommendation:* state all three in the spec,
   and decide whether `?:` is an error.
4. **`.` followed by a digit.** The patch does not split `x=a .2xl`, while
   `.2xl` **is** a valid class shorthand in the tag-adjacent and first-attribute
   positions (spec §4). *Recommendation:* keep the exclusion and say so, or align
   the positions.
5. **Spreads.** The patch applies the after-value rules to a spread
   (`...props .b` splits); the spec text does not distinguish. *Recommendation:*
   rule spreads in or out explicitly.
6. **Unions in tag parameters.** `|x: A | B|` ends at the first `|` in the
   default. *Recommendation:* require parentheses and state it in the spec.
7. **Generic calls and generic arrows in an HTML-mode value.** `x=f<T>(y)` and
   `x=<T,>(a) => a` are cut at `>` today with **no error**, and the rest becomes
   body text. *Recommendation:* the TypeScript parser must consume the angle
   brackets; whether that changes the E1 `>` hard stop needs a ruling.
8. **The ambiguous `>` error.** The stock parser raises `Ambiguous ">" in
   attribute.` for `x=a > b`. *Recommendation:* keep it, since the TypeScript
   parser cannot tell `>` the operator from `>` the tag end either.
9. **Atoms in a ternary.** The atoms prototype says `x=a ? :b :c` is one value
   `a ? "b" : c`; the current patch mis-splits it. *Recommendation:* the ternary
   counter must skip an atom's `:`.
10. **Code after `;` and HTML comments in an open tag.** The parser reports them;
    no MX source states the expected wording or whether they stay errors.
    *Recommendation:* keep both errors, with wording pinned by a fixture.
11. **Spec §4 still describes `:x=1` and `:b(x)` as errors**, which decision 146,
    addendum 4 replaced. *Recommendation:* the spec PR follows the decision.
12. **`$!{…}` in an attribute value.** The parser accepts it as value text; the
    compiler's expression parse rejects it. Under decision 157, which layer must
    raise it. *Recommendation:* the compiler's expression parse, as today.
13. **Placeholders in a text body.** The parser recognises `${…}` inside a
    `TagType.text` body; spec §3 says the body is "a single `MarkoText`".
    *Recommendation:* amend spec §3 to say the body is text plus placeholders.
14. **Atoms outside the three ruled positions.** Decision 156.1 rules attribute
    values, `${}` and tag arguments, and excludes `static`/`import`/script
    blocks; scriptlets, method bodies, attribute arguments, tag parameters, the
    tag variable and spreads have no ruling, and "script blocks" is undefined.
    *Recommendation:* extend 156.1 to name the exclusion list.
15. **Spec §4 "Consumers on a stock parser" and the divergence row "The parser
    after-value rule"** still describe the stock-parser diagnostic that decision
    157, addendum 3 removed. *Recommendation:* strike that paragraph in the spec
    PR that this grammar lands with.
16. **A tag name's first character.** The parser accepts a leading digit; no
    source states a class. *Recommendation:* write `<name> ::= <any run of
    non-terminator characters>` in the spec, or pin the observed acceptance.
17. **The hard-stop operator exemption.** `EXPRESSION.ts:151-172` ignores any
    stop character written directly after an operator, so `x=a + ,b` is one
    value while `x=a +/>` and `x=a ? />` report a regular-expression EOF error.
    No valid TypeScript is affected. *Recommendation:* state the exemption as an
    error-recovery rule and give the three inputs one shared diagnostic, or turn
    it into a plain hard stop. Either way the current silent acceptance of
    `a + ,b` should stop.
18. **Newline continuation in concise mode.** The default continues a concise
    value across a newline only on a look-behind operator; a TypeScript parser
    continues across all of them, so `<div x=a\n  <span/>` in HTML mode is the
    garbage value `a\n  <span` while the same input in concise mode is the value
    `a` plus a child tag `span`. See the OQ 2 divergence table for the full set.
    *Recommendation:* keep the look-behind-only rule as the MX default and make
    the TypeScript-parser design reproduce it, so a `.mx` file parses the same in
    both modes.
19. **End of input with an open group.** `div x=(a` reports an EOF error in
    concise mode, and `$ {a` terminates silently with the `{` group open. Two
    positions, one rule (`isConcise || terminatedByEOL` terminates only when no
    group is open), two different outcomes, neither of them a stated design.
    *Recommendation:* one rule — terminate the value and let the value's own
    syntax error be reported by the expression parser.
20. **`::` with whitespace.** Decision 156.5 reserves `::name`; the stock parser
    has no `::` token, and `<div x=a :: b/>` is the single value `a :: b` (a `:`
    that opens a type context). *Recommendation:* rule `::` as a token the lexer
    rejects wherever it appears, with or without a following name.
21. **Names of expression positions and span rules.** MX2 gets its own AST
    (decision 158), catalogued in `apps/docs/docs/architecture/ast.md`, which is
    being drafted on another branch. The two documents have to agree on the
    **names of the expression positions** used here (this document's E1–E18) and
    on **span rules** (which spans include the delimiter: an attribute value
    includes the `=`, a placeholder includes `${`, a tag variable includes `/`,
    a method's range starts at its `async` or its type parameters). This document
    does not depend on that catalogue and does not edit it.
    *Recommendation:* whoever lands second adopts the other's names, and the AST
    catalogue cites this document for the spans rather than restating them.

### Where a real TypeScript parser would end the value differently

Every row is the **stock** behaviour, which this document keeps as the normative
default, with what TypeScript's own grammar does instead. Each is an input, not
a class, and each is observed.

| Input | Stock parse (normative default) | TypeScript parse | OQ |
| --- | --- | --- | --- |
| `div x=a\n  <span/>` (concise) | value `a`, child tag `span` | continues across the newline as `a < span` | OQ 18 |
| `div x=a\n  .b` (concise) | value `a`, unnamed child tag with class `b` | `a.b` | OQ 18 |
| `div x=a\n  (b)` (concise) | value `a`, child tag with tag arguments | `a(b)` | OQ 18 |
| `<div x=a\n  <span/>` (HTML mode) | the single value `a\n  <span` | `a < span` continuing the newline | OQ 2, OQ 18 |
| `<div x=a !b/>` | one value `a !b` | `a!` as a non-null assertion, then `b` | OQ 2 |
| `<div x=a ++b/>` | one value `a ++b` | `a++`, then `b` | OQ 2 |
| `<div x=a as T < b/>` | one value `a as T < b` | the type context ends at `T`, so `< b` is a comparison | OQ 2 |
| `<div x=a as T = b/>` | one value `a as T = b` | not valid TypeScript at all | OQ 2 |
| `<div x=a {b}/>` | one value `a {b}` | not valid TypeScript at all | OQ 2 |
| `<div x=a: b/>` | one value `a: b` | a type annotation, so `x` would be `a` annotated `b` — but the default keeps it in the value | OQ 2, OQ 3 |
| `<div x=a const b/>` | value `a`, then attributes `const` and `b` | `const` is not an operator, so TypeScript also stops — the default agrees here | OQ 2 |

## Conformance

The htmljs-parser fixtures cited below live in
`/Users/svallory/work/htmljs-parser/src/__tests__/fixtures/` — one directory per
case, each with an `input.marko` and a snapshot — and are **evidence of the
default behaviour, not a gate**.

| Section | Exercised by |
| --- | --- |
| Tags, tag names, the `:` split | `packages/core/src/name-sugar.test.ts`; `packages/targets/html/fixtures-marko/attr-value-modifier`; htmljs-parser fixtures `tag-name-*`, `shorthand-*` |
| Sugars and the after-value rule | **`patches/htmljs-parser.test.ts`** (`CHANGED`, `PINNED`, `DEFAULT_ATTRIBUTE` blocks — the primary asset for Expression boundaries); `packages/core/src/name-sugar.test.ts`; `packages/core/src/stock-parser.test.ts` |
| E1–E3 attribute values, spreads, whitespace | `patches/htmljs-parser.test.ts`; htmljs fixtures `attr-*`, `ts-generic-*`, `attr-value-*`, `attr-ambiguous-right-angle-bracket*` |
| E4–E5, E16–E17 methods and type parameters | htmljs fixtures `attr-method-*` (5), `invalid-*type*` |
| E6–E7, E15 tag arguments and parameters | htmljs fixtures `tag-params-*`, `tag-with-type-arguments`; `fixtures/render-props`; `packages/targets/html/fixtures-marko/attribute-tags*`. There is no htmljs fixture named `attribute-tags` |
| E8, E13 placeholders and dynamic names | htmljs fixtures `placeholder-*`, `shorthand-*-dynamic*`; `fixtures/{counter,todos,lists}` |
| E9 tag variables | htmljs fixtures `tag-var-*`; `patches/htmljs-parser.test.ts` |
| E10 statement tags | `patches/htmljs-parser.test.ts` (`statement tags` block); htmljs fixtures `statement-*` |
| E11 scriptlets | htmljs fixtures `scriptlet-*` |
| E12 delimited text blocks | htmljs fixtures `double-hyphen-*`, `multiline-html-block*`, `single-line-text-block*`, `concise-contentplaceholder-start` |
| Concise mode | `apps/docs/example/home-example.mx`; `packages/tooling/tsc/src/fixtures/host-dispatch/data-check/violation.mx`; htmljs fixtures `concise-*`, `semicolon-concise`, `attr-comma-multiline*`, `mixed-*` |
| Whitespace | `test-fixtures/body-whitespace/cases.json` |
| Text, comments, doctype, raw text | `packages/targets/html/fixtures-marko/{doctype-page,comments-and-html-comment,html-comment-placeholder,elements-text,piped-text}`; htmljs fixtures `placeholder-within-script-tag`, `dtd`, `*-crlf` |
| Attribute tags | `packages/targets/html/fixtures-marko/attribute-tags*`; htmljs fixtures `empty-closing-tag*`, `shorthand-closing-html*` |
| Atoms | **no asset** — the atoms test table (atoms report §5) is written but not implemented |
| End of input, per position | htmljs fixtures `eof-attr-value`, `eof-attr-name`, `eof-attr-argument`, `attr-eof-after-name`, `attr-eof-default-value`, `attr-eof-spread`, `attr-eof-unnamed`, `attr-eof-value-string`, `eof-placeholder-*`, `eof-script-body`, `eof-style`, `eof-tag-start`, `tag-name-placeholder-eof` — these **do** pin which position produces which EOF message |
| Concise EOF termination | htmljs fixtures `eof-attr-value-js-comment-comment-concise`, `eof-placeholder-concise` |

### Rules no existing test covers

- Generic calls and generic arrows in an HTML-mode value (`x=f<T>(y)`) as an
  explicit assertion rather than an oracle row.
- The atoms themselves end to end, including the core splice that keeps an atom
  out of the authored source slice.
- The sugar-then-`=` and sugar-then-`(` forms of decision 146, addendum 4 (PR 4).
- `:name` with a dash as an atom (`:rename-all`).
- `|x: A | B|` and other union types inside tag parameters.
- The **concise newline continuation** rule as an explicit assertion — which of
  the look-ahead half's operators stop applying at a newline in concise mode (the
  htmljs fixtures cover `attr-comma-multiline*` but not this).
- A concise value with an open group at EOF (`div x=(a`), and a scriptlet block
  at EOF (`$ {a`), whose two results differ for no stated reason (OQ 19).
- The hard-stop operator exemption (`x=a + ,b`, `x=a +/>`, `x=a ? />`) — it is
  error recovery, so no test should pin it until OQ 17 is ruled.
- `--` text lines in an MX-specific asset (the htmljs fixtures cover them; the
  MX tree does not — already flagged as untested in spec §3).
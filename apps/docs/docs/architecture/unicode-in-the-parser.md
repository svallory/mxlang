---
title: "Unicode in the parser"
description: "How the MX template parser classifies characters above ASCII where it looks behind or ahead, and where it reads them as htmljs-parser 5.18.0 does."
---

# Unicode in the parser

The template parser sometimes decides what a character means by looking at the character before or after the current position: whether a `:` is an atom, a `/` a division or a regular expression, a word a keyword, a `>` the end of a tag, a `--` the start of a text block. This page lists how characters above ASCII are classified at those places, the rule each place follows, and the places that read them exactly as the unpatched htmljs-parser 5.18.0 does.

"The unpatched parser" below means htmljs-parser 5.18.0 as published (git tag `v5.18.0`), which classifies only ASCII characters. It is not the `htmljs-parser` the workspace's `@marko/compiler` resolves, which carries MX's patch. Every example was run on both parsers; `stock` is the unpatched one and `MX` is the template parser on main. Events are shortened: `@x ="v"` is an attribute `x` with the value `v`, `atom(b)` an atom event, and every non-printing or easily confused character in an input or an output is written as a `\uXXXX` escape (`\u{XXXXX}` above U+FFFF); ordinary letters such as `é` and `名` and the visible symbols the page discusses are literal. The `g` numbers are probes in the grammar corpus (`packages/parser/src/template/grammar-spec.corpus.json`) that run in CI against the source copy and both patched builds.

## The two classes

### Word characters

A word character is `A`–`Z`, `a`–`z`, `0`–`9`, `$` or `_`, or a code point at or above U+0080 with the Unicode property `ID_Continue`, or U+200C (ZWNJ) or U+200D (ZWJ). ECMAScript's `IdentifierPartChar` is `UnicodeIDContinue` or `$`, and U+200C and U+200D have been `ID_Continue` since Unicode 15.1; MX lists them by name so the class does not depend on the Unicode version of the engine it runs on for those two.

A surrogate pair is one code point. Looking back, a low surrogate is combined with the high surrogate before it; looking ahead, a high surrogate with the low surrogate after it. A lone surrogate is not a word character. The test for a code point below U+0080 is a comparison, and the property lookup runs only at or above U+0080.

So `é`, `名`, `𠞷` (U+20BB7), a combining mark such as U+0301 and U+200D are word characters; `©`, `×`, `…`, `«`, `—`, an emoji, a private-use character, U+00AD, U+2060 and a lone surrogate are not. The unpatched parser has no non-ASCII word characters at all.

The standard: ECMA-262 (16th edition, ES2025, and the later editions; the productions are unchanged), section "Names and Keywords", `IdentifierPartChar :: UnicodeIDContinue | $`, with `UnicodeIDContinue` "any Unicode code point with the Unicode property ID_Continue".

### Whitespace

Where the parser looks behind for whitespace, it counts the ASCII code units U+0000 to U+0020 and these 19 code points:

| Code point | Name | Category | ECMAScript production | Probe |
| --- | --- | --- | --- | --- |
| U+00A0 | NO-BREAK SPACE | Zs | WhiteSpace | g0967 |
| U+1680 | OGHAM SPACE MARK | Zs | WhiteSpace | g0968 |
| U+2000 to U+200A | EN QUAD to HAIR SPACE (eleven code points) | Zs | WhiteSpace | g0969 to g0979 |
| U+2028 | LINE SEPARATOR | Zl | LineTerminator | g0980 |
| U+2029 | PARAGRAPH SEPARATOR | Zp | LineTerminator | g0981 |
| U+202F | NARROW NO-BREAK SPACE | Zs | WhiteSpace | g0982 |
| U+205F | MEDIUM MATHEMATICAL SPACE | Zs | WhiteSpace | g0983 |
| U+3000 | IDEOGRAPHIC SPACE | Zs | WhiteSpace | g0984 |
| U+FEFF | ZERO WIDTH NO-BREAK SPACE | Cf | WhiteSpace | g0985 |

This is ECMAScript's WhiteSpace plus LineTerminator above ASCII, code point for code point, and also the set Babel skips. The standard: ECMA-262 (ES2025 and later), "White Space" (WhiteSpace: U+0009, U+000B, U+000C, U+FEFF and any code point in category Zs) and "Line Terminators" (LineTerminator: U+000A, U+000D, U+2028, U+2029). TypeScript's scanner additionally treats U+0085 and U+200B as whitespace; MX does not, so both are neither whitespace nor word characters here (they are no `ID_Continue`). U+180E, U+2060 and U+00AD are neither either. None of the 19 code points is a word character.

The probes in the table pin the atom look-behind for each code point (`<div x=[a,<code point>:b]/>`).

## The rules

Each rule is one place where the parser looks behind or ahead. The probe for an example is named beside it.

### Identifier characters before a `:` and around keywords and `/`

In an expression, a non-ASCII identifier character counts as a word character wherever the parser asks whether a word starts or ends: a word right before a `:` is an object key or a label, so no atom follows (`{ é:a }`); a `/` after a word is a division, not the start of a regular expression; a name that ends in a keyword (`énew`) is a name, not the keyword; `!` after a word is a postfix assertion; a `.` before a word continues a member access; an operand before `>` takes part in the ambiguous-`>` check. A symbol or an unpaired surrogate is not a word character and is read as ASCII punctuation is.

Standard: ECMAScript's `IdentifierPartChar`, as classified above. The unpatched parser is ASCII-only, so it treats every non-ASCII character as punctuation.

| Input | stock | MX | Probe |
| --- | --- | --- | --- |
| `<div x=({ é:a })/>` | `@x ="({ é:a })"` | the same value; `é:` is a key and no atom lexes | g0572 |
| `<div x=(é :b)/>` | `@x ="(é :b)"` | the same value, no atom: a word before whitespace and `:` is an operand, so TypeScript owns the colon | g0574 |
| `<div x=é / 2 y/>` | `@x ="é / 2 y/"`, then `Missing ending "div" tag` (the `/` starts a regular expression) | `@x ="é / 2" @y` (a division) | g1027 |
| `<div x=\u{207b7} / 2 y=1/>` (U+20BB7, a surrogate pair) | the same error as above | `@x ="\u{207b7} / 2" @y ="1"` | g1694 |
| `<div x=a\u200d / 2 y=1/>` (ZWJ) | the same error | `@x ="a\u200d / 2" @y ="1"` | g1695 |
| `<div x=a\u0301 / 2 y=1/>` (a combining mark) | the same error | `@x ="a\u0301 / 2" @y ="1"` | g1696 |
| `<div x=© / 2 y=1/>` (a symbol) | `@x ="© / 2 y=1/"`, then the error | the same as stock: `©` is not a word character | g1692 |
| `<div x=\u{1f600} / 2 y=1/>` (an emoji) | the same as `©` | the same as stock | g1693 |
| `<div x=\ud800 / 2 y=1/>` (a lone surrogate) | the same as `©` | the same as stock | g1697 |
| `<div x=énew y=1/>` | `@x ="énew y=1"` | `@x ="énew" @y ="1"` | g1029 |
| `<div x=a >\u{207b7}>c</div>` | `@x ="a"`, then the text `\u{207b7}>c` | `Ambiguous ">" in attribute` (as for `a >b>c`) | g1698 |
| `<div x=a >©>c</div>` | `@x ="a"`, then the text `©>c` | the same as stock | g1691 |
| `<div x=(for (é of :a))/>` | `@x ="(for (é of :a))"` | the same value, and the atom `:a` lexes: `of` follows a word | g0989 |

In the first two rows the two parsers read the same value: the unpatched parser has no atoms, so the rule shows only in that MX lexes none.

U+200B and U+0085 are not word characters: `<div x=(a\u200b :b)/>` and `<div x=(a\u0085 :b)/>` lex the atom `:b` in MX (g1633, g1634), as an atom lexes after any ASCII punctuation.

### Unicode whitespace before an atom's `:`

In the atom look-behind, the 19 whitespace code points behave as an ASCII space. `a\u00a0:b` is a key followed by whitespace and a colon, exactly as `a :b` is; `[a,\u00a0:b]` is an operand position, exactly as `[a, :b]`.

Standard: ECMAScript's WhiteSpace and LineTerminator (Babel and TypeScript skip the same code points as trivia). The unpatched parser has no atoms and sees these code points as non-whitespace punctuation.

| Input | stock | MX | Probe |
| --- | --- | --- | --- |
| `<div x=[a,\u00a0:b]/>` | `@x ="[a,\u00a0:b]"` | `@x atom(b) ="[a,\u00a00.]"`: the atom lexes | g0967 |
| `<div x=({ a\u00a0:b })/>` | `@x ="({ a\u00a0:b })"` | the same value, no atom: a key, as in `{ a :b }` | g0957 |
| `<div x=({ é\u00a0:a })/>` | the same value shape | no atom: a key | g0955 |
| `<div x=(a?\u00a0:b : c)/>` | `@x ="(a?\u00a0:b : c)"` | the same value, no atom: `a?` is TypeScript's optional marker, as with `a? :b` | g0960 |
| `<div x=(Array<T>\u00a0:b)/>` | `@x ="(Array<T>\u00a0:b)"` | the same value, no atom: type arguments, as with `Array<T> :b` | g0962 |

Two shapes that lexed an atom before this rule, `(a?\u00a0:b : c)` and `(Array<T>\u00a0:b)`, now read as their ASCII-space spellings and no longer compile; the fix is an ASCII space before the `?`, or parentheses.

### Unicode whitespace at the expression look-behinds

The same 19 code points count as whitespace wherever an expression look-behind asks "is this whitespace": whether a `/` is a division or a regular expression, the keyword and operator look-behinds (`typeof`, `new`, a trailing `+` or `||`), `++` and `--`, the `{` after a type, a whitespace-preceded `>=`, and a comment skipped before an operator word.

Standard: ECMAScript's WhiteSpace and LineTerminator. The unpatched parser uses `code <= 0x20` everywhere, so these characters end nothing and join nothing.

| Input | stock | MX | Probe |
| --- | --- | --- | --- |
| `<div x=(é)\u00a0/ 2/>` | `@x ="(é)\u00a0/ 2/"`, then the error (a regular expression) | `@x ="(é)\u00a0/ 2"` (a division) | g1684 |
| `<div x=a +\u00a0 y=1/>` | `@x ="a +\u00a0" @y ="1"` | `@x ="a +\u00a0 y=1"`: the value continues after the operator | g1687 |
| `<if=count\u00a0>= 10>y</if>` | `@ ="count\u00a0"`, then the text `= 10>y` | `@ ="count\u00a0>= 10"`, then the text `y` | g1686 |
| `<div x=(a /* c */\u00a0:b)/>` | `@x ="(a /* c */\u00a0:b)"` | the same value, no atom | g1637 |

### Concise `--` after Unicode whitespace

In concise mode, a `--` after one of the 19 code points ends the attribute and starts a text block, as after an ASCII space. The code point stays in the attribute's range, because an ASCII space ends an attribute by the current-character test, which is not a look-behind and does not recognise the Unicode characters.

Standard: MX's own; neither ECMAScript nor the unpatched parser defines it. The unpatched parser reads the `--` as part of the value or the name and the text as another attribute.

| Input | stock | MX | Probe |
| --- | --- | --- | --- |
| `div x=1\u00a0-- text\n` | `@x ="1\u00a0--" @text`; value range 6 to 10 | `@x ="1\u00a0"` and the text `text`; value range 6 to 8 | g1680 |
| `div x\u00a0-- text\n` | `@x\u00a0--` and `@text` | `@x\u00a0` and the text `text`; name range 4 to 6 | g1681 |
| `div x=1 -- text\n` (an ASCII space) | `@x ="1"` and the text `text` | the same | g1688 |

A trailing U+00A0 on a value does not reach emitted code (the expression is parsed as `1`); on an attribute name the compile fails with `Invalid attribute name`.

### `await`, `yield` and `of` before an atom

An atom after `await` or `yield` is not lexed when the keyword follows `(`, `,`, `?` or `:` (`(await :b) => 1` is valid TypeScript with `await` a parameter), and is lexed otherwise; `of` is an operator only after an operand. Whitespace and word characters are read as above: a Unicode whitespace character between the keyword and what precedes it is skipped, and a word character glued to the keyword makes it an ordinary identifier.

Standard: MX's own, derived from the TypeScript grammar; `await` and `yield` are ordinary identifiers outside async and generator code. The unpatched parser has no atoms.

| Input | stock | MX | Probe |
| --- | --- | --- | --- |
| `<div x=(a,\u00a0yield :b)/>` | `@x ="(a,\u00a0yield :b)"` | the same value, no atom: `yield` follows `,` (the non-breaking space is skipped) | g0964 |
| `<div x=(x\u00a0of :a)/>` | `@x ="(x\u00a0of :a)"` | `@x atom(a) ="(x\u00a0of 0.)"`: `of` follows the operand `x` | g0965 |

## Where MX reads as the unpatched parser does

### Body text

In HTML body text, `//` and `/*` start a comment only after ASCII whitespace. A non-breaking space before them is text.

| Input | stock | MX | Probe |
| --- | --- | --- | --- |
| `<p>Visit\u00a0//cdn.example/x.js</p>` | `text:"Visit\u00a0//cdn.example/x.js"` | the same | g1689 |
| `<p>a\u00a0/* b */ c</p>` | `text:"a\u00a0/* b */ c"` | the same | g1690 |
| `<p>a\u00a0// b\n</p>` | `text:"a\u00a0// b\n"` | the same | g1682 |

0.1.0-alpha.7 to 0.1.0-alpha.9 read these as comments, so the first input became a comment that swallowed `</p>` and ended in `Missing ending "p" tag`. That was a regression and is fixed.

### Tag names and shorthands

The tag-name and shorthand states keep ASCII whitespace. `div\u00a0-- text` names the tag `div\u00a0--` and gives it the attribute `text`; `div.a\u00a0-- text` gives the tag `div` the class `a\u00a0--` and the attribute `text`. The unpatched parser reads both identically.

| Input | stock | MX | Probe |
| --- | --- | --- | --- |
| `div\u00a0-- text\n` | tag `div\u00a0--`, `@text` | the same | none |
| `div.a\u00a0-- text\n` | tag `div`, class `a\u00a0--`, `@text` | the same | none |

Unicode whitespace does not separate attributes either: `<div a\u00a0b/>` has one attribute named `a\u00a0b` (g1538).

### The after-value rule

After whitespace inside an attribute value, a `:` or a `.` followed by a name starts a new attribute instead of continuing the value (`x=a :b` is the value `a` and the attribute `:b`). The name's first character is tested for being an ASCII identifier start, so a non-ASCII name does not split a `:`. A `.` takes any word character that is not a digit, so `x=a .é` splits.

| Input | stock | MX | Probe |
| --- | --- | --- | --- |
| `<div x=a :b/>` | `@x ="a :b"` | `@x ="a" @:b` | g0422 |
| `<div x=1 :é/>` | `@x ="1 :é"` | the same as stock: one value (it fails to compile) | none |
| `<div x=(a) :T => a/>` | `@x ="(a) :T => a"` | `@x ="(a)" @:T`, then `Missing value for attribute` | g0610 |
| `<div x=(a) :É => a/>` | `@x ="(a) :É => a"` | the same as stock: one valid value | none |
| `<div x=a .é/>` | `@x ="a" @.é` | the same | g1020 |

This ASCII-only test is **on hold**, not a final rule. Whether `:name` after a value stays in the language is under review, so the identifier-start test is not being widened to non-ASCII names in the meantime. It would change valid TypeScript that the unpatched parser reads as one value: an arrow function's or a function expression's return type written with a space before the colon (`x=(a) :É => a`).

## Known approximations and leftovers

- MX's whitespace still counts 27 ASCII control characters that ECMAScript does not (U+0000 to U+0008 and U+000E to U+001F). This is inherited from htmljs-parser, whose `isWhitespaceCode` is `code <= 0x20` and carries the comment "this might be slightly non-conforming".
- U+2028 and U+2029 are whitespace in the look-behinds but do not end a concise line.
- The tag grammar's own tests (a character that ends an attribute name, a tag name or a shorthand) look at the current character and keep ASCII whitespace; the Unicode whitespace of this page applies only in the look-behinds and the concise ` --` rule above.
- An atom's name is ASCII, and a non-ASCII character directly after it makes it no atom: `<div x=:aé/>` is the plain value `:aé` (g0526).
- The word class has no table of its own; it follows the engine's Unicode property data. TypeScript's identifier tables follow Unicode 15.1 and Babel's 17.0, so a character added to `ID_Continue` after the engine's Unicode version is a non-word character here until the engine updates.
- Not determined: what MX 0.1.0-alpha.4, before the rules above, did with `(a?\u00a0:b : c)` and `(Array<T>\u00a0:b)` (it needs a checkout of that release), and how editors, formatters and language tools consume the attribute ranges that keep a trailing Unicode space.

## How this was checked

The unpatched reference is htmljs-parser at tag v5.18.0 from its own repository, run from source; it is not the workspace's `@marko/compiler`, which runs on MX's patched parser, so no statement here about what "the unpatched parser" reads comes from Marko's compiler. The two classes were compared with the definitions above over every code point: the word helper agrees with the engine's own `\p{ID_Continue}` (plus U+200C and U+200D, and no surrogate) over all 63,360 non-surrogate code points of the Basic Multilingual Plane and all 1,048,576 supplementary code points, and the whitespace set equals ECMAScript's WhiteSpace plus LineTerminator above ASCII. Every example above was run on both parsers, and the probe corpus runs in CI on three builds: the source copy of the parser, and the `index.mjs` and `index.js` builds of the patched npm package.

## Sources

- Decision 156 addenda 8 to 15 (atoms, the non-ASCII rules, and the on-hold after-value name).
- ECMA-262, 16th edition (ES2025) and later: "White Space", "Line Terminators", "Names and Keywords".
- The probe corpus and the grammar tables: [The parser grammar](/architecture/parser-grammar/).

---
title: "ADR 146: the `:name` sugar"
description: "Why `<input:email>`, `<input :email>` and `<:email>` set `name`, which characters and alternatives were rejected, and the parser rule MX carries for it."
---

# ADR 146: the `:name` sugar

**Status:** accepted 2026-10-04 (decision 146 and its addendum in the decisions log). **Depends on:** ADR 145 (`defaultTag`). **Implementation:** three PRs (parser patch, core, tooling and docs).

## Context

Marko has two tag-adjacent shorthands borrowed from CSS selectors: `<div#main>` sets `id`, `<div.card>` sets `class`. A great many tags, in HTML (`<input>`, `<select>`, `<button>`, `<slot>`, `<meta>`) and in data vocabularies (attributes, fields, resources, actions), carry a `name` attribute, and there is no shorthand for it. The data target made the gap visible: a vocabulary that declares attributes writes `<attribute name="title" type="string"/>` for every entry.

MX is a language first (its targets exist to test it), so the question was treated as one of language design: which spelling, in which positions, at what cost in parser work and divergence from Marko.

## Decision

`:val` sets `name="val"`, the way `#val` sets `id` and `.val` sets `class`. All three sugars work in three positions:

| position | example | meaning |
|---|---|---|
| tag-adjacent | `<input:email>`, `<:email>` | `name="email"`; a bare `<:email>` is the unnamed tag of ADR 145 with a name |
| first attribute | `<input :email>` | same |
| after any attribute | `<input type="email" :email>`, `<input x="1" #main .big>` | same, in HTML and concise mode |

Tag-adjacent sugars compose in any order (`<a.c:b>`, `<a#d:b.c>`, `<:b.c>`). The value is the same identifier-like token Marko's shorthand accepts; `:x=1` is a positioned error. After the sugar is resolved, `name` is an ordinary attribute: contracts, duplicate rules and attribute typing apply unchanged.

## What was measured

All claims below were measured on `@marko/compiler` 5.42.5 (htmljs-parser 5.15) with a capture translator, 2026-10-04.

- Marko's parser is permissive about tag names: only whitespace, `/`, `>`, `.`, `#`, `,`, `=`, `(` and `|` end or change a name. `<a:b>` is the tag `a:b`, `<:b>` is the tag `:b`. So the tag-adjacent split is a post-parse rewrite; no parser work.
- `#b` in attribute position already parses as an attribute named `#b`, first, after a quoted value, after an unquoted value, in concise mode.
- `:b` first or after `,` parses as the *default attribute with a modifier*, `{ name: "value", modifier: "b" }`, i.e. `value:b`. After any attribute value it is the parse error "Expected a single expression, but found `:` after it": the parser reads ` :` as a ternary continuation of the previous value.
- `.b` after any value is swallowed as member access (`x="1" .b` is `"1".b`).
- Bare `:mod` meaning `value:mod` is undocumented. It falls out of two generic parser rules (split an attribute name at its last `:`; fill an empty head with `value`), and the only use found anywhere was MX's own oracle fixture.
- The expression-continuation rule is general: after a value, any token that can continue a JavaScript expression continues it (`- + * / % & | ^ < .`, `?`/`:`, `in`, `instanceof`, `=>`, a `(` call, across newlines). It never bites today because every real attribute name starts with a letter, `_`, `$`, `@` or `#`, none of which continue an expression.

## Alternatives considered

| option | works in every position without parser change | reads as "name" | rejected because |
|---|---|---|---|
| `:` | no (`:` after a value is an error) | yes | **chosen**; the parser rule it needs is non-breaking |
| `$` | yes | no: reads as "variable" in JS, shell and PHP | sugar that is misread is sugar people avoid |
| `@` | yes | partly | `<@x>` is an attribute tag; one sigil, two positions, two meanings |
| `&` | no (`x=a &b` is a valid bitwise expression today) | YAML anchor reading is nice | needs a *breaking* parser change; real ambiguity, not just an error |
| `::` | no (same `:` error) | yes | same parser problem; two spellings for one thing once `<input:email>` exists |
| wildcard attribute tags (`<@title type="string"/>`) | yes | different thing | forces a tag's whole contract into attribute-tag shape; attribute tags do not have every tag capability |
| replace the modifier operator `:` with `\|` | n/a | n/a | changes a documented Marko feature (`class:x`, `style:x`, `value:fn:=x`) and buys nothing the chosen rule does not |

## Consequences

Four divergences from Marko, each recorded in `divergences.md`:

1. A tag name may not contain `:`; `tag:rest` is tag plus name. No HTML element has a `:` in its name, so nothing real is lost.
2. Bare `:x` in attribute position is `name="x"`, not `value:x`. The named modifier forms (`class:x`, `style:x`, `value:fn:=x`) are untouched.
3. A shorthand class or id cannot contain `:` (`<div.hover:x>` is class `hover`, name `x`). Tailwind-style variants use `class="hover:x"`, which is unchanged.
4. Parser: after whitespace inside an attribute value, a `:` with no open `?` in that value, and a `.` followed by an identifier start, begin a new attribute instead of continuing the previous value. The `:` half breaks nothing (every input it affects is a parse error today) and is offered upstream to htmljs-parser. The `.` half changes `x=a.b .c` (member access across whitespace), which must now be written without the space or in parentheses.

MX carries rule 4 as a bun `patchedDependencies` hunk on htmljs-parser until upstream takes the `:` half. Marko's own language tools will flag `:x` after a value in `.marko` files; `.mx` files use MX's tools.

What stays true: `#` and `.` keep their Marko meaning and merge rules; every existing golden is byte-identical; the sugar never produces anything a user could not have written as `name="…"`.

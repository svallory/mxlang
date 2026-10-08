# @mxlang/parser changelog

## Unreleased

- **Docs (front-end-handler-contract):** the README documents the front-end handler contract: the full table of the 28 `on*` handlers the MX front end installs (stock htmljs-parser 5.18.0's 27 plus `onAtom`), each payload's shape, the fire-and-forget rule, and the single exception where a handler's return value is read (`onOpenTagName` → `TagTypeValue`). No code change.
- **Fix, regression of 0.1.0-alpha.7 (decision 156 addendum 13):** in HTML body text, `//` and `/*` start a comment only after ASCII whitespace, as in Marko. `<p>Visit\u00a0//cdn.example/x.js</p>` is text again; alpha.7 and alpha.8 read it as a comment that swallowed `</p>` (`Missing ending "p" tag`). Addendum 11 stays at the expression sites.
- **Fix (decision 156 addendum 13):**
  - The word class is exact: a code point at or above U+0080 is a word character where the parser looks behind or ahead only when it is `ID_Continue` or U+200C or U+200D, a surrogate pair read as one code point. `©`, `×`, `…`, `«` and emoji are no longer identifier characters, so valid Marko such as `<div x=a >©>c</div>` parses as Marko reads it instead of failing with `Ambiguous ">"`.
  - A tag that never got its name and is still open at the end of the input (`<,>a`) is an `onError` (`Missing ending "div" tag`) instead of a `TypeError` out of `parse()`.

- **Fix (template-parser-lookbehinds-followup, decisions 156 addenda 11 and 12, 165):** in the template parser (`src/template/`, which `@mxlang/core` bundles) and the `htmljs-parser` patch:
  - A closing tag after a tag that never got its name (`,--/</e>`) is an `onError` (`EXTRA_CLOSING_TAG`) instead of a `TypeError` out of `parse()`.
  - Unicode whitespace and line terminators behave as ASCII whitespace in every look-behind, so `(é)\u00a0/ 2` divides.
  - A comment before `of`/`yield`/`await` is skipped as whitespace is (`f(/*c*/ await :b)` lexes no atom, as `f( await :b)` does not).
  - **Behaviour change:** text after NBSP + `//` in a body is a comment, as after a space (`<div>a\u00a0// c</div>`).
  - **Behaviour change (addendum 12):** in concise mode, `--` after Unicode whitespace starts the text block; the attribute's range keeps the trailing whitespace.

- **Changed (parser-split, decision 158):** the package now holds only the template parser (`src/template/`). The vendored Babel fork moved to `@mxlang/babel` and the MX bridge, `parse`/`print` and their tests to `@mxlang/tsx-bridge`; earlier history is in `packages/tsx-bridge/CHANGELOG.md`.

# @mxlang/parser changelog

## Unreleased

- **Fix (template-parser-lookbehinds-followup, decisions 156 addenda 11 and 12, 165):** in the template parser (`src/template/`, which `@mxlang/core` bundles) and the `htmljs-parser` patch:
  - A closing tag after a tag that never got its name (`,--/</e>`) is an `onError` (`EXTRA_CLOSING_TAG`) instead of a `TypeError` out of `parse()`.
  - Unicode whitespace and line terminators behave as ASCII whitespace in every look-behind, so `(é)\u00a0/ 2` divides.
  - A comment before `of`/`yield`/`await` is skipped as whitespace is (`f(/*c*/ await :b)` lexes no atom, as `f( await :b)` does not).
  - **Behaviour change:** text after NBSP + `//` in a body is a comment, as after a space (`<div>a\u00a0// c</div>`).
  - **Behaviour change (addendum 12):** in concise mode, `--` after Unicode whitespace starts the text block; the attribute's range keeps the trailing whitespace.

- **Changed (parser-split, decision 158):** the package now holds only the template parser (`src/template/`). The vendored Babel fork moved to `@mxlang/babel` and the MX bridge, `parse`/`print` and their tests to `@mxlang/tsx-bridge`; earlier history is in `packages/tsx-bridge/CHANGELOG.md`.

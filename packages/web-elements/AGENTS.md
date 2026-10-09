# web-elements — agent instructions

`packages/web-elements` (`@mxlang/web-elements`) is the table of HTML, SVG
and MathML elements: `HTML_ELEMENTS`, `SVG_ELEMENTS`, `MATHML_ELEMENTS`, and
`WEB_ELEMENTS`, a map from each name to `{ namespace, body }`. `body` is the
element's body mode, the same names as `@mxlang/core`'s (`"void"` for the 14
void elements, `"preserve"` for `pre`, `"parsed-text-preserve"` for `script`,
`style` and `textarea`, `"parsed-text"` for `title`, `"html"` otherwise).

- It is plain data with no dependency, so any target or host can read it.
  Core never imports it (core names no element): a target that renders web
  elements hands the table to core through its declarations.
- The table equals Marko's `marko-html`, `marko-svg` and `marko-math`
  taglibs. The pin lives in `packages/stock-marko/src/web-elements.test.ts`,
  the package that owns the Marko dependency, so this package needs no
  `@marko/compiler`; it compares the names and each body mode with Marko's
  parse rules. A deliberate divergence changes both the table and that test,
  with the reason.
- `src/index.test.ts` checks the table's own invariants (no duplicates,
  disjoint lists, the 19 non-`html` bodies, names that are not elements).
- Consumers resolve `dist/`, so `bun run build` (the root build builds this
  package first) comes before their tests.

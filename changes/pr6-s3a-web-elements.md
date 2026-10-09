---
packages: [web-elements, html]
kind: Added
---

New package `@mxlang/web-elements` (decision 197, PR 6 slice S3a): the HTML, SVG and MathML element names (`HTML_ELEMENTS`, `SVG_ELEMENTS`, `MATHML_ELEMENTS`) and, for each, its namespace and body mode (`WEB_ELEMENTS`, `webElement(name)`, `isWebElement(name)`), as plain data with no dependency. The body modes are the 19 parse rules of Marko's element taglibs: `"void"` for the 14 void elements, `"preserve"` for `pre`, `"parsed-text-preserve"` for `script`, `style` and `textarea`, `"parsed-text"` for `title`. `@mxlang/html` reads its element table from the new package (a new runtime dependency) instead of its own `element-table.ts`, so which tags render as elements is unchanged; the comparison with `@marko/compiler` 5.42.11's `marko-html`, `marko-svg` and `marko-math` taglibs moved with it and now covers the body modes too. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).

# @mxlang/web-elements

The HTML, SVG and MathML element names, and how each element's body parses,
as plain data with no dependency.

> **Beta.** This package is at 0.x. Its API may change in any release until 1.0.0.

```ts
import { isWebElement, webElement, WEB_ELEMENTS } from "@mxlang/web-elements";

isWebElement("div"); // true
isWebElement("my-widget"); // false
webElement("br"); // { namespace: "html", body: "void" }
webElement("textarea"); // { namespace: "html", body: "parsed-text-preserve" }
webElement("circle"); // { namespace: "svg", body: "html" }
```

| Export | What it is |
|---|---|
| `HTML_ELEMENTS`, `SVG_ELEMENTS`, `MATHML_ELEMENTS` | The names, one list per namespace. The lists are disjoint: a name SVG shares with HTML (`a`, `script`, `style`, `title`) is listed once, under HTML. |
| `WEB_ELEMENTS` | `ReadonlyMap<string, WebElement>`: every name with its `namespace` (`"html"`, `"svg"` or `"mathml"`) and `body`. |
| `isWebElement(name)` | Whether `name` is an element. Exact and case-sensitive: `Div` is not. |
| `webElement(name)` | The `WebElement`, or `undefined`. |

`body` is one of:

- `"void"`: no body and no closing tag (`area`, `base`, `br`, `col`, `embed`,
  `hr`, `img`, `input`, `link`, `meta`, `param`, `source`, `track`, `wbr`).
- `"preserve"`: markup whose whitespace is kept as written (`pre`).
- `"parsed-text-preserve"`: text with placeholders, no tags, whitespace kept
  (`script`, `style`, `textarea`).
- `"parsed-text"`: text with placeholders, no tags (`title`).
- `"html"`: ordinary markup, every other element.

The table equals the element taglibs of Marko 6 (`@marko/compiler` 5.42.11),
names and parse rules both; MX's test suite pins it.

## License

MIT

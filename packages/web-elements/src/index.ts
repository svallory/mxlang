/**
 * The HTML, SVG and MathML elements, and how each one's body parses.
 *
 * This is plain data with no dependency: a target or host that renders web
 * elements reads it, and passes it to `@mxlang/core` through its own
 * declarations, so core itself names no element. The lists equal Marko's
 * `marko-html`, `marko-svg` and `marko-math` taglibs and the body modes equal
 * their parse rules (`@marko/compiler` 5.42.11);
 * `packages/stock-marko/src/web-elements.test.ts` pins both, so a Marko bump
 * that adds or drops an element, or changes a rule, fails there instead of
 * silently changing what an element is.
 */

/** HTML elements (Marko's `marko-html` taglib). */
export const HTML_ELEMENTS: readonly string[] = [
  "a",
  "abbr",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "base",
  "bdi",
  "bdo",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "link",
  "map",
  "mark",
  "menu",
  "meta",
  "meter",
  "nav",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "param",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "small",
  "source",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "track",
  "u",
  "ul",
  "video",
  "wbr",
  "dialog",
  "main",
  "var",
  "data",
  "template",
];

/** SVG elements (Marko's `marko-svg` taglib). */
export const SVG_ELEMENTS: readonly string[] = [
  "animate",
  "animateColor",
  "animateMotion",
  "animateTransform",
  "circle",
  "clipPath",
  "defs",
  "desc",
  "ellipse",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "filter",
  "foreignObject",
  "g",
  "image",
  "line",
  "linearGradient",
  "marker",
  "mask",
  "metadata",
  "mpath",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialGradient",
  "rect",
  "set",
  "stop",
  "svg",
  "switch",
  "symbol",
  "text",
  "textPath",
  "tspan",
  "use",
  "view",
];

/** MathML elements (Marko's `marko-math` taglib). */
export const MATHML_ELEMENTS: readonly string[] = [
  "math",
  "maction",
  "maligngroup",
  "malignmark",
  "menclose",
  "merror",
  "mfenced",
  "mfrac",
  "mglyph",
  "mi",
  "mlabeledtr",
  "mlongdiv",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "ms",
  "mscarries",
  "mscarry",
  "msgroup",
  "mstack",
  "msline",
  "mspace",
  "msqrt",
  "msrow",
  "mstyle",
  "msub",
  "msup",
  "msubsup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "semantics",
  "mprescripts",
  "none",
];

/** The namespace a web element belongs to. */
export type WebNamespace = "html" | "svg" | "mathml";

/**
 * How a tag's body parses: `"html"` is ordinary markup; `"void"` takes no
 * body or closing tag; `"parsed-text"` is text with placeholders (no tags);
 * `"preserve"` keeps whitespace as written; `"parsed-text-preserve"` is both.
 * The same names as `@mxlang/core`'s body modes.
 */
export type WebBodyMode =
  | "html"
  | "parsed-text"
  | "preserve"
  | "parsed-text-preserve"
  | "void";

/** One web element: its namespace and how its body parses. */
export interface WebElement {
  readonly namespace: WebNamespace;
  readonly body: WebBodyMode;
}

/** The elements whose body is not `"html"`, with their mode. */
const BODY_MODES: Readonly<Record<string, WebBodyMode>> = {
  area: "void",
  base: "void",
  br: "void",
  col: "void",
  embed: "void",
  hr: "void",
  img: "void",
  input: "void",
  link: "void",
  meta: "void",
  param: "void",
  source: "void",
  track: "void",
  wbr: "void",
  pre: "preserve",
  script: "parsed-text-preserve",
  style: "parsed-text-preserve",
  textarea: "parsed-text-preserve",
  title: "parsed-text",
};

function entries(
  names: readonly string[],
  namespace: WebNamespace,
): [string, WebElement][] {
  return names.map((name) => [
    name,
    Object.freeze({
      namespace,
      body: Object.hasOwn(BODY_MODES, name)
        ? (BODY_MODES[name] as WebBodyMode)
        : "html",
    }),
  ]);
}

/**
 * Every web element by name. The three lists are disjoint, as Marko's are,
 * so a name has one namespace and one body mode: a name SVG shares with HTML
 * (`a`, `script`, `style`, `title`) is listed once, under HTML.
 */
export const WEB_ELEMENTS: ReadonlyMap<string, WebElement> = new Map([
  ...entries(HTML_ELEMENTS, "html"),
  ...entries(SVG_ELEMENTS, "svg"),
  ...entries(MATHML_ELEMENTS, "mathml"),
]);

/** Whether `name` is an HTML, SVG or MathML element (exact, case-sensitive match). */
export function isWebElement(name: string): boolean {
  return WEB_ELEMENTS.has(name);
}

/** The element named `name`, or `undefined` when it is not a web element. */
export function webElement(name: string): WebElement | undefined {
  return WEB_ELEMENTS.get(name);
}

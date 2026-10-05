// MX decision 146: `#id`, `.class` and `:name` shorthands anywhere in a
// tag: tag-adjacent in any order, and in attribute position (first, or after
// any attribute) in html and concise mode. htmljs-parser has no `:name`
// sugar and reads the attribute-position forms differently (see the ADR), so
// these cases assert trees directly instead of comparing parser events.
import assert from "node:assert";
import Parser from "tree-sitter";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Marko = require("../bindings/node");

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(Marko);
  return parser.parse(src).rootNode;
}

const CASES: [name: string, src: string, tree: string][] = [
  [
    "tag-adjacent name",
    "<a:b/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) shorthand: (shorthand_name (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "tag-adjacent name on the unnamed tag",
    "<:b/>",
    "(document (element (open_tag_start) (tag_name) shorthand: (shorthand_name (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "tag-adjacent class then name",
    "<a.c:b/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) shorthand: (shorthand_class (tag_name_fragment)) shorthand: (shorthand_name (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "tag-adjacent id, name, class",
    "<a#d:b.c/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) shorthand: (shorthand_id (tag_name_fragment)) shorthand: (shorthand_name (tag_name_fragment)) shorthand: (shorthand_class (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "unnamed tag with name and class",
    "<:b.c/>",
    "(document (element (open_tag_start) (tag_name) shorthand: (shorthand_name (tag_name_fragment)) shorthand: (shorthand_class (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "tag-adjacent name with placeholder",
    "<a:${x}/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) shorthand: (shorthand_name (placeholder (placeholder_start) (placeholder_expr) (placeholder_end))) (open_tag_end_self) (element_end)))",
  ],
  [
    "close tag matches the bare name",
    "<a:b>hi</a>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) shorthand: (shorthand_name (tag_name_fragment)) (open_tag_end) (text) (close_tag (close_tag_start) (close_tag_name) (close_tag_end)) (element_end)))",
  ],
  [
    "close tag matches the full name",
    "<a:b>hi</a:b>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) shorthand: (shorthand_name (tag_name_fragment)) (open_tag_end) (text) (close_tag (close_tag_start) (close_tag_name) (close_tag_end)) (element_end)))",
  ],
  [
    "void tag keeps its type",
    "<input:email>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) shorthand: (shorthand_name (tag_name_fragment)) (open_tag_end) (element_end)))",
  ],
  [
    "concise tag-adjacent",
    "a.c:b #d",
    "(document (element (tag_name (tag_name_fragment)) shorthand: (shorthand_class (tag_name_fragment)) shorthand: (shorthand_name (tag_name_fragment)) (shorthand_id (tag_name_fragment)) (concise_open_tag_end) (element_end)))",
  ],
  [
    "concise unnamed tag",
    ":b.c",
    "(document (element (tag_name) shorthand: (shorthand_name (tag_name_fragment)) shorthand: (shorthand_class (tag_name_fragment)) (concise_open_tag_end) (element_end)))",
  ],
  [
    "name first attribute",
    "<input :email/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (shorthand_name (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "name after quoted value",
    "<input type=\"email\" :email/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (shorthand_name (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "id and class after value",
    "<input x=\"1\" #main .big/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (shorthand_id (tag_name_fragment)) (shorthand_class (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "all three after unquoted value",
    "<a x=foo :b .c #d/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (shorthand_name (tag_name_fragment)) (shorthand_class (tag_name_fragment)) (shorthand_id (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "after boolean attribute",
    "<input disabled :email/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (shorthand_name (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "after comma",
    "<a x=1,:b/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (shorthand_name (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "chained attribute shorthands",
    "<a x=1 .b.c:d/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (shorthand_class (tag_name_fragment)) (shorthand_class (tag_name_fragment)) (shorthand_name (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "attribute class with placeholder",
    "<a x=1 .${y}/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (shorthand_class (placeholder (placeholder_start) (placeholder_expr) (placeholder_end))) (open_tag_end_self) (element_end)))",
  ],
  [
    "concise after value",
    "input x=\"1\" #b .c :d",
    "(document (element (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (shorthand_id (tag_name_fragment)) (shorthand_class (tag_name_fragment)) (shorthand_name (tag_name_fragment)) (concise_open_tag_end) (element_end)))",
  ],
  [
    "concise first attribute",
    "input :email",
    "(document (element (tag_name (tag_name_fragment)) (shorthand_name (tag_name_fragment)) (concise_open_tag_end) (element_end)))",
  ],
  [
    "concise attribute group",
    "div [ x=1 :n .c ]",
    "(document (element (tag_name (tag_name_fragment)) (attr_group (attr_group_open) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (shorthand_name (tag_name_fragment)) (shorthand_class (tag_name_fragment)) (attr_group_close)) (concise_open_tag_end) (element_end)))",
  ],
  [
    "html across newline",
    "<a x=1\n  .b/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (shorthand_class (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "member access across whitespace now splits",
    "<a x=a.b .c/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (shorthand_class (tag_name_fragment)) (open_tag_end_self) (element_end)))",
  ],
  [
    "ternary keeps its colon",
    "<a x=a ? b : c/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))",
  ],
  [
    "ternary without spaces before branch",
    "<a x=a ? b :c/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))",
  ],
  [
    "member access without whitespace",
    "<a x=a.b/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))",
  ],
  [
    "call then member attribute name",
    "<a f(x).b=1/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (args (args_open) (args_expr) (args_close)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))",
  ],
  [
    "spread",
    "<a ...x/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_spread (attr_value_expr)) (open_tag_end_self) (element_end)))",
  ],
  [
    "class modifier",
    "<div class:scoped=\"x\"/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))",
  ],
  [
    "style modifier",
    "<div style:x=\"y\"/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))",
  ],
  [
    "bound value modifier",
    "<input value:fn:=x/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_bound_value (attr_bound_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))",
  ],
  [
    "bound default attribute",
    "<a:=x/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_bound_value (attr_bound_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))",
  ],
  [
    "as-type value is unchanged",
    "<a x=y as T/>",
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))",
  ],
  [
    "name with value is an error",
    "<input :x=1/>",
    "(document (ERROR (open_tag_start) (tag_name (tag_name_fragment))))",
  ],
  [
    "tag-adjacent name with value is an error",
    "<input:x=1/>",
    "(document (ERROR (open_tag_start) (tag_name (tag_name_fragment))))",
  ],
  [
    "id with value is an error",
    "<input x=1 #x=1/>",
    "(ERROR (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)))",
  ],
  [
    "two tag-adjacent names is an error",
    "<a:b:c/>",
    "(document (ERROR (open_tag_start) (tag_name (tag_name_fragment)) shorthand: (shorthand_name (tag_name_fragment))))",
  ],
];

describe("mx shorthands", () => {
  for (const [name, src, tree] of CASES) {
    it(name, () => {
      assert.strictEqual(parse(src).toString(), tree);
    });
  }

  it("splits the value exactly before the shorthand", () => {
    const values = (src: string) =>
      parse(src)
        .descendantsOfType("attr_value_expr")
        .map((n) => n.text);
    assert.deepStrictEqual(values("<a x=foo :b .c #d/>"), ["foo"]);
    assert.deepStrictEqual(values("<a x=a.b .c/>"), ["a.b"]);
    assert.deepStrictEqual(values("<a x=a ? b :c/>"), ["a ? b :c"]);
    assert.deepStrictEqual(values("<a x=a ? b : c/>"), ["a ? b : c"]);
    assert.deepStrictEqual(values("<a x=y as T/>"), ["y as T"]);
  });

  it("keeps named modifiers as attribute names", () => {
    const names = (src: string) =>
      parse(src)
        .descendantsOfType("attr_name")
        .map((n) => n.text);
    assert.deepStrictEqual(names('<div class:scoped="x"/>'), ["class:scoped"]);
    assert.deepStrictEqual(names('<div style:x="y"/>'), ["style:x"]);
    assert.deepStrictEqual(names("<input value:fn:=x/>"), ["value:fn"]);
  });

  it("ends the value only at a `:` with no open conditional `?`", () => {
    const values = (src: string) =>
      parse(src)
        .descendantsOfType("attr_value_expr")
        .map((n) => n.text);
    const names = (src: string) =>
      parse(src)
        .descendantsOfType("shorthand_name")
        .map((n) => n.text);
    for (const [src, value] of [
      ["<a x=a ?? b :c/>", "a ?? b"],
      ["<a x=a?.[0] :c/>", "a?.[0]"],
      ["<a x=a ?.b :c/>", "a ?.b"],
      ["<a x=a ?? b ? c : d :e/>", "a ?? b ? c : d"],
      ["<a x=a?.5:1 :c/>", "a?.5:1"],
    ]) {
      assert.deepStrictEqual(values(src), [value], src);
      assert.strictEqual(names(src).length, 1, src);
      assert.ok(!parse(src).hasError, src);
    }
    assert.deepStrictEqual(values("<a x=a ? b : c/>"), ["a ? b : c"]);
    assert.deepStrictEqual(names("<a x=a ? b : c/>"), []);
  });

  it("splits a chain continued on the next line (whitespace rule)", () => {
    const root = parse("<a x=foo\n  .bar()/>");
    assert.deepStrictEqual(
      root.descendantsOfType("attr_value_expr").map((n) => n.text),
      ["foo"],
    );
    assert.deepStrictEqual(
      root.descendantsOfType("shorthand_class").map((n) => n.text),
      [".bar"],
    );
    const kept = parse("<a x=(foo\n  .bar())/>");
    assert.deepStrictEqual(
      kept.descendantsOfType("attr_value_expr").map((n) => n.text),
      ["(foo\n  .bar())"],
    );
    assert.deepStrictEqual(kept.descendantsOfType("shorthand_class"), []);
  });

  it("reads `:` after a tag variable as its type annotation", () => {
    const root = parse("<a/b :c/>");
    assert.deepStrictEqual(
      root.descendantsOfType("var_type").map((n) => n.text),
      ["c"],
    );
    assert.deepStrictEqual(root.descendantsOfType("shorthand_name"), []);
    assert.deepStrictEqual(
      parse("<a/b x=1 :c/>")
        .descendantsOfType("shorthand_name")
        .map((n) => n.text),
      [":c"],
    );
  });

  it("marks only tag-adjacent shorthands with the shorthand field", () => {
    const fielded = (src: string) =>
      parse(src)
        .firstNamedChild!.childrenForFieldName("shorthand")
        .map((n) => n.text);
    assert.deepStrictEqual(fielded("<a#d:b.c x=1 :e .f #g/>"), [
      "#d",
      ":b",
      ".c",
    ]);
    assert.deepStrictEqual(fielded("<style .scss>a{}</style>"), []);
    assert.deepStrictEqual(fielded("style.less x=1 .scss -- c{}"), [".less"]);
  });

  it("covers the shorthand source exactly", () => {
    const root = parse("<a#d:b.c x=1 :e .f #g/>");
    const text = (type: string) =>
      root.descendantsOfType(type).map((n) => n.text);
    assert.deepStrictEqual(text("shorthand_id"), ["#d", "#g"]);
    assert.deepStrictEqual(text("shorthand_class"), [".c", ".f"]);
    assert.deepStrictEqual(text("shorthand_name"), [":b", ":e"]);
  });
});

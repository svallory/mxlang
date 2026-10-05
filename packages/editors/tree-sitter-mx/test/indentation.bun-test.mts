// MX's own test (not vendored): an indented line with no tag open is an ERROR
// node. Marko's parser rejects it ("Line has extra indentation at the
// beginning"), and the scanner used to fail the lex silently there: with no
// tag open the document is already complete, so tree-sitter dropped the rest of
// the file and returned a clean tree. A column-0 line (a `//` comment, or any
// tag) closes the concise tag above it, which is how the state is reached.
import assert from "node:assert";
import { parseMx } from "../__tests__/util/language.mts";

function parse(src: string) {
  const tree = parseMx(src);
  if (!tree) throw new Error(`parse timed out: ${JSON.stringify(src)}`);
  return tree.rootNode;
}

describe("extra indentation at the root", () => {
  // [name, src, text the ERROR node covers]
  const BAD: [string, string, string][] = [
    ["after a column-0 comment", "div\n// c\n  b\n", "b"],
    ["after a nested tag and a column-0 comment", "div\n  a\n// c\n  b\n", "b"],
    ["after a block comment", "div\n/* c */\n  b\n", "b"],
    ["on the first line", "  b\n", "b"],
    ["with tabs", "div\n// c\n\tb\n", "b"],
    [
      "after a root tag and a comment, then another tag",
      "x\n// c\n  b\ny\n",
      "b",
    ],
  ];
  for (const [name, src, covered] of BAD) {
    it(`is an ERROR ${name}`, () => {
      const root = parse(src);
      assert.ok(root.hasError, root.toString());
      const errors = root.children.filter((c) => c.type === "ERROR");
      assert.equal(errors.length, 1, root.toString());
      assert.equal(errors[0]?.text, covered);
    });
  }

  it("keeps parsing after the error", () => {
    const root = parse("x\n// c\n  b\ny\n");
    assert.equal(
      root.toString(),
      "(document (element (tag_name (tag_name_fragment)) (concise_open_tag_end) (element_end)) (line_comment) (ERROR) (element (tag_name (tag_name_fragment)) (concise_open_tag_end) (element_end)))",
    );
  });

  // The language rule is unchanged: these are all valid.
  const GOOD: [string, string][] = [
    ["a column-0 comment between root tags", "div\n  a\n// c\nspan\n  b\n"],
    ["nested tags", "div\n  a\n    b\n"],
    ["an indented comment with no tag open", "  // c\n"],
    ["a column-0 line after a root tag", "div\nspan\n  b\n"],
  ];
  for (const [name, src] of GOOD) {
    it(`parses ${name} clean`, () => {
      const root = parse(src);
      assert.ok(!root.hasError, root.toString());
    });
  }
});

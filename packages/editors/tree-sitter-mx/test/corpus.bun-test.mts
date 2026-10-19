// MX's own: every case in test/corpus parses with the wasm grammar with no
// ERROR or MISSING node (except the `:error` cases of errors.txt, which must
// have one: htmljs-parser rejects them), and the reader hands back the source
// the case holds.
// packages/core/src/ir-entry/conformance.test.ts runs the same cases
// through lowerSource.
import assert from "node:assert";
import { parseMx } from "../__tests__/util/language.mts";
import { readCorpus } from "./corpus/read.mts";

const CASES = readCorpus();

describe("tree-sitter-mx corpus", () => {
  it("has cases", () => {
    assert.ok(CASES.length >= 300, `only ${CASES.length} cases`);
    const names = CASES.map((c) => `${c.file}:${c.name}`);
    assert.strictEqual(
      new Set(names).size,
      names.length,
      "duplicate case name",
    );
  });

  it("keeps the error cases in errors.txt and nowhere else", () => {
    const errors = CASES.filter((c) => c.error);
    assert.strictEqual(errors.length, 14);
    for (const c of errors) assert.strictEqual(c.file, "errors.txt");
  });

  for (const c of CASES) {
    it(`${c.file} ${c.name}`, () => {
      const tree = parseMx(c.source);
      if (!tree) throw new Error("parse timed out");
      if (c.error) assert.ok(tree.rootNode.hasError, "parsed clean");
      else assert.ok(!tree.rootNode.hasError, tree.rootNode.toString());
    });
  }
});

describe("unterminated comments", () => {
  // EOF belongs to the comment, even across a closing tag or a concise
  // dedent, just as for the existing <!-- EOF case. Keep completed siblings
  // outside the ERROR; an unfinished enclosing element may join the ERROR.
  const EOF_CASES = [
    "parsed-text-block-comment-eof",
    "html-content-block-comment-eof",
    "after-semicolon-html-comment-eof",
    "after-semicolon-block-comment-eof",
    "concise-block-comment-eof",
  ];
  for (const name of EOF_CASES) {
    it(`covers the malformed tail without swallowing the preceding sibling: ${name}`, () => {
      const c = CASES.find((c) => c.name === name);
      assert.ok(c, `missing corpus case ${name}`);
      const tree = parseMx(c.source);
      assert.ok(tree, "parse timed out");
      const root = tree.rootNode;
      assert.equal(root.firstNamedChild?.type, "element", root.toString());
      assert.equal(root.firstNamedChild?.text, "<before/>");
      const errors = root.descendantsOfType("ERROR");
      assert.equal(errors.length, 1, root.toString());
      assert.equal(errors[0]?.startIndex, "<before/>\n".length);
      assert.equal(errors[0]?.endIndex, c.source.length);
      assert.equal(errors[0]?.text, c.source.slice("<before/>\n".length));
      tree.delete();
    });
  }

  const REPAIRED: [string, string, string][] = [
    ["parsed text", "<script>/* oops */</script>\n<after/>", "after"],
    ["HTML content", "<div> /* oops */</div>\n<after/>", "after"],
    ["HTML comment after tag;", "div; <!-- oops ->\nspan", "span"],
    ["block comment after tag;", "div; /* oops */\nspan", "span"],
    ["concise block comment", "/* oops */\n<after/>", "after"],
  ];
  for (const [name, source, following] of REPAIRED) {
    it(`continues after the terminator in ${name}`, () => {
      const tree = parseMx(`<before/>\n${source}`);
      assert.ok(tree, "parse timed out");
      const root = tree.rootNode;
      assert.ok(!root.hasError, root.toString());
      assert.equal(root.firstNamedChild?.text, "<before/>");
      const last = root.namedChildren.at(-1);
      assert.equal(last?.type, "element", root.toString());
      assert.equal(
        last?.namedChildren.find((c) => c.type === "tag_name")?.text,
        following,
      );
      tree.delete();
    });
  }

  // These two false returns belong to internal scanners. The grammar is
  // already inside a required construct, so a failed token produces ERROR;
  // do not turn an internal bool into an external ERROR_SENTINEL token.
  for (const [source, end] of [
    ["${/* oops", 2],
    ["<div /* oops", 4],
  ] as const) {
    it(`retains the enclosing error for ${JSON.stringify(source)}`, () => {
      const tree = parseMx(source);
      assert.ok(tree, "parse timed out");
      const errors = tree.rootNode.descendantsOfType("ERROR");
      assert.equal(errors.length, 1, tree.rootNode.toString());
      assert.equal(errors[0]?.startIndex, 0);
      assert.equal(errors[0]?.endIndex, end);
      tree.delete();
    });
  }
});

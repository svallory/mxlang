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
  // dedent, just as for the existing <!-- EOF case. When the sentinel is the
  // only error in a parse, completed siblings stay outside the ERROR; an
  // unfinished enclosing element may join the ERROR. A sentinel combined with
  // any other error in the same parse ends the parse (see "known shape"
  // below).
  const EOF_CASES = [
    "parsed-text-block-comment-eof",
    "html-content-block-comment-eof",
    "after-semicolon-html-comment-eof",
    "after-semicolon-block-comment-eof",
    "concise-block-comment-eof",
  ];
  for (const name of EOF_CASES) {
    it(`covers the malformed tail of a lone error and keeps the preceding sibling: ${name}`, () => {
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

  // Known shape, bead mx-r6fj: a sentinel combined with any other error in
  // one parse, in either order, ends the parse. Here an ordinary placeholder
  // (or scriptlet) error comes first and the new comment sentinel follows,
  // so the root becomes an ERROR that starts at 0 and holds the completed
  // `<before/>`; the ERROR stops before the comment. The front end reports
  // MALFORMED_COMMENT for both inputs. The same collapse already holds on
  // main for a concise `-` line and for `<!--`. Pinned as it is, not as it
  // should be: when mx-r6fj lands these rows change.
  for (const [source, end] of [
    ["<before/>\n<p>${y /* oops", 15],
    ["<before/>\n$ /* oops", 11],
  ] as const) {
    it(`known shape, bead mx-r6fj: ${JSON.stringify(source)}`, () => {
      const tree = parseMx(source);
      assert.ok(tree, "parse timed out");
      const root = tree.rootNode;
      assert.equal(root.type, "ERROR", root.toString());
      assert.equal(root.startIndex, 0);
      assert.equal(root.endIndex, end);
      assert.equal(root.descendantsOfType("ERROR").length, 1, root.toString());
      assert.equal(root.firstNamedChild?.text, "<before/>");
      tree.delete();
    });
  }

  // Terminator edges: `/*/` and `<!-->` are unterminated openers (the `/` or
  // `>` that follows the opener does not close it), so each input is an
  // error that spans to EOF. The front end reports MALFORMED_COMMENT for
  // all four.
  for (const source of [
    "<div> /*/ x</div>\n<after/>",
    "<script>/*/ x</script>",
    "div; /*/",
    "<div> <!--> x</div>",
  ]) {
    it(`reports the unterminated opener ${JSON.stringify(source)}`, () => {
      const tree = parseMx(source);
      assert.ok(tree, "parse timed out");
      const root = tree.rootNode;
      assert.ok(root.hasError, root.toString());
      const errors = root.descendantsOfType("ERROR");
      assert.equal(errors.length, 1, root.toString());
      assert.equal(errors[0]?.startIndex, 0);
      assert.equal(errors[0]?.endIndex, source.length);
      tree.delete();
    });
  }

  // Terminated or non-comment look-alikes parse clean.
  for (const [name, source] of [
    ["an empty block comment in HTML content", "<div> /**/ </div>\n<after/>"],
    [
      "a /* inside a string in script",
      "<script>const a = '/* in string';</script>\n<after/>",
    ],
    [
      "a /* inside a line comment in script",
      "<script>const a = 1; // ... /*\n</script>\n<after/>",
    ],
  ] as const) {
    it(`parses ${name} clean`, () => {
      const tree = parseMx(source);
      assert.ok(tree, "parse timed out");
      const root = tree.rootNode;
      assert.ok(!root.hasError, root.toString());
      const last = root.namedChildren.at(-1);
      assert.equal(last?.text, "<after/>", root.toString());
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

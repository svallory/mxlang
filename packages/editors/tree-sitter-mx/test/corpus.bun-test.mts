// MX's own: every case in test/corpus parses with the wasm grammar with no
// ERROR or MISSING node (except the `:error` cases of errors.txt, which must
// have one: htmljs-parser rejects them), and the reader hands back the source
// the case holds.
// packages/core/src/ir-entry/conformance.test.ts runs the same cases
// through lowerSource.
import assert from "node:assert";
import { parseMx } from "../__tests__/util/language.mts";
import { treeEvents } from "../__tests__/util/tree-events.mts";
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
    assert.strictEqual(errors.length, 17);
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

  // Known shape (tree-sitter limit), bead mx-r6fj: an error line the scanner
  // recovers from keeps the rest of the document (see "error recovery"
  // below). An unfinished enclosing construct combined with an unterminated
  // comment does not: the comment runs to EOF, so no later content exists,
  // and the parser has an open placeholder (or scriptlet) it can only close
  // by wrapping everything in one root ERROR that starts at 0 and holds the
  // completed `<before/>`; the ERROR stops before the comment. The front end
  // reports MALFORMED_COMMENT for both inputs. Pinned as it is: no token the
  // scanner could emit makes the open construct end earlier.
  for (const [source, end] of [
    ["<before/>\n<p>${y <!-- oops", 15],
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

describe("error recovery", () => {
  // The scanner used to return false while tree-sitter was recovering, which
  // ends the parse: the rest of the document vanished (beads mx-r6fj and
  // mx-scanner-error-recovery-truncates-body). It now swallows the rest of
  // the failing line as part of the ERROR and scans on from the next line.
  const names = (root: {
    namedChildren: {
      type: string;
      namedChildren: { type: string; text: string }[];
    }[];
  }) =>
    root.namedChildren
      .filter((n) => n.type === "element")
      .map((n) => n.namedChildren.find((c) => c.type === "tag_name")?.text);

  it("keeps the elements after an error line in a concise body", () => {
    const tree = parseMx("div\n  - foo\nspan\np");
    assert.ok(tree, "parse timed out");
    const root = tree.rootNode;
    assert.deepEqual(names(root), ["div", "span", "p"], root.toString());
    const errors = root.descendantsOfType("ERROR");
    assert.equal(errors.length, 1, root.toString());
    assert.equal(errors[0]?.text, "- foo\n");
    tree.delete();
  });

  it("keeps the elements between and after two error lines", () => {
    const source = "<a/>\n-\n<b/>\n-\n<c/>";
    const tree = parseMx(source);
    assert.ok(tree, "parse timed out");
    const root = tree.rootNode;
    assert.equal(root.type, "document", root.toString());
    assert.deepEqual(names(root), ["a", "b", "c"], root.toString());
    assert.equal(root.descendantsOfType("ERROR").length, 2, root.toString());
    tree.delete();
  });

  it("ends the ERROR at the last char of an error line that ends the file", () => {
    // The line break joins the ERROR only when more text follows it.
    const tree = parseMx("<a/>\n-\n");
    assert.ok(tree, "parse timed out");
    const root = tree.rootNode;
    assert.deepEqual(names(root), ["a"], root.toString());
    const errors = root.descendantsOfType("ERROR");
    assert.equal(errors.length, 1, root.toString());
    assert.equal(errors[0]?.text, "-");
    tree.delete();
  });

  // EOF failures emit an ERROR node, not just a MISSING element_end.
  const hasMissing = (n: { isMissing: boolean; children: any[] }): boolean =>
    n.isMissing || n.children.some(hasMissing);

  it("reports a lone unclosed <script> as one ERROR over the element", () => {
    const tree = parseMx("<script>abc");
    assert.ok(tree, "parse timed out");
    const root = tree.rootNode;
    assert.equal(root.type, "document", root.toString());
    const errors = root.descendantsOfType("ERROR");
    assert.equal(errors.length, 1, root.toString());
    assert.equal(errors[0]?.startIndex, 0);
    assert.equal(errors[0]?.endIndex, 11);
    assert.equal(hasMissing(root), false, root.toString());
    tree.delete();
  });

  it("keeps the sibling before an unclosed <script> outside the ERROR", () => {
    const tree = parseMx("<before/>\n<script>abc");
    assert.ok(tree, "parse timed out");
    const root = tree.rootNode;
    assert.equal(root.type, "document", root.toString());
    assert.equal(root.firstNamedChild?.type, "element");
    assert.equal(root.firstNamedChild?.text, "<before/>");
    const errors = root.descendantsOfType("ERROR");
    assert.equal(errors.length, 1, root.toString());
    assert.equal(errors[0]?.startIndex, "<before/>\n".length);
    assert.equal(errors[0]?.endIndex, 21);
    assert.equal(hasMissing(root), false, root.toString());
    tree.delete();
  });
});

describe("tag-grammar whitespace", () => {
  // The tag grammar's whitespace is Unicode's Pattern_White_Space, as in
  // @mxlang/parser: U+0085, U+200E, U+200F, U+2028 and U+2029 read exactly
  // as VT (U+000B), and the other Unicode spaces are refused in a tag name,
  // a shorthand or an attribute name. The inputs are literal copies of
  // PATTERN_WS_TAG_FORMS and REFUSED_SPACE_ROWS in
  // packages/parser/src/template/mx-unicode-words.cases.ts.
  const PATTERN_WHITE_SPACE = [
    "\u0085",
    "\u200e",
    "\u200f",
    "\u2028",
    "\u2029",
  ];
  const PATTERN_WS_TAG_FORMS = [
    "<divWa/>",
    "<div aWb/>",
    "<div a=1Wb/>",
    "<div/xWa/>",
    "<div.cWa/>",
    "<p><Wb</p>",
    "<div a=x +Wb/>",
    "divWa\n",
    "div aWb\n",
    "div a=1Wb\n",
    "div a=x +Wb\n",
    "div\nWspan\n",
    "$Wx\n",
  ];
  // Scanner-only twins (not in the parser's list): the gap before a tag
  // variable's `:` type and the gap after it are EXPRESSION's
  // consumeWhitespace(isSpace) in a whitespace-terminated expression, which
  // the scanner ports as separate skips (VAR_COLON, VAR_TYPE).
  const TAG_VAR_TYPE_FORMS = [
    "<div/xW: T a/>",
    "<div/x:WT a/>",
    "div/xW: T a\n",
    "div/x:WT a\n",
  ];
  // Scanner-only twins of the other ports to is_pattern_ws: ARGS_CLOSE
  // before a method body, TYPES_CLOSE before params or args, the concise
  // comma continuation on either side of the `,`, and the gap after `*/`.
  const PORT_FORMS = [
    "<foo(x)W{ }/>",
    "<div a<T>(x)W{ }/>",
    "<div<T>W|x|/>",
    "<div<T>W(x)/>",
    "div a=1,W\n  b=2\n",
    "div a=1W,\n  b=2\n",
    "/* c */W\ndiv\n",
  ];

  // The events htmljs-parser would fire, rebuilt from the tree. Every
  // separator is one UTF-16 unit, so offsets never shift.
  const render = (src: string) => {
    const tree = parseMx(src);
    assert.ok(tree, "parse timed out");
    const root = tree.rootNode;
    assert.ok(!root.hasError, `${JSON.stringify(src)}: ${root.toString()}`);
    const events = treeEvents(src, root)
      .map((e) => `${e.label} ${e.start}-${e.end} ${src.slice(e.start, e.end)}`)
      .join("\n");
    tree.delete();
    return events;
  };

  for (const ws of PATTERN_WHITE_SPACE) {
    for (const form of [
      ...PATTERN_WS_TAG_FORMS,
      ...TAG_VAR_TYPE_FORMS,
      ...PORT_FORMS,
    ]) {
      const src = form.replaceAll("W", ws);
      it(`${JSON.stringify(src)} reads as its VT twin`, () => {
        const twin = render(form.replaceAll("W", "\v"));
        assert.strictEqual(render(src).replaceAll(ws, "\v"), twin);
      });
    }
    // The tag variable's event spans the whole `x: T`, so the twin check
    // above cannot see where the type token starts after a gap behind the
    // `:`; the highlight capture on var_type starts after the gap, as for VT.
    for (const form of TAG_VAR_TYPE_FORMS.filter((f) => f.includes(":W"))) {
      const src = form.replaceAll("W", ws);
      it(`${JSON.stringify(src)} starts its var_type at T`, () => {
        const tree = parseMx(src);
        assert.ok(tree, "parse timed out");
        const types = tree.rootNode.descendantsOfType("var_type");
        assert.equal(types.length, 1, tree.rootNode.toString());
        assert.equal(types[0]?.startIndex, src.indexOf("T"));
        assert.equal(types[0]?.text, "T");
        tree.delete();
      });
    }
  }

  // VAR_PATTERN: `/` followed by tag-grammar whitespace is a missing tag
  // variable (MISSING_TAG_VARIABLE), an error exactly as for VT.
  const MISSING_VAR_TREE =
    "(document (ERROR (open_tag_start) (tag_name (tag_name_fragment))))";
  for (const ws of PATTERN_WHITE_SPACE) {
    const src = `<div/${ws}a/>`;
    it(`${JSON.stringify(src)} is a missing tag variable, as "<div/\\va/>" is`, () => {
      for (const input of [src, "<div/\va/>"]) {
        const tree = parseMx(input);
        assert.ok(tree, "parse timed out");
        assert.strictEqual(tree.rootNode.toString(), MISSING_VAR_TREE);
        tree.delete();
      }
    });
  }

  // [input, offset of the refused space]
  const REFUSED_SPACE_ROWS: [string, number][] = [
    ["<div a\u00a0b/>", 6],
    ["<div a\u1680b/>", 6],
    ["<div a\u2000b/>", 6],
    ["<div a\u2001b/>", 6],
    ["<div a\u2002b/>", 6],
    ["<div a\u2003b/>", 6],
    ["<div a\u2004b/>", 6],
    ["<div a\u2005b/>", 6],
    ["<div a\u2006b/>", 6],
    ["<div a\u2007b/>", 6],
    ["<div a\u2008b/>", 6],
    ["<div a\u2009b/>", 6],
    ["<div a\u200ab/>", 6],
    ["<div a\u202fb/>", 6],
    ["<div a\u205fb/>", 6],
    ["<div a\u3000b/>", 6],
    ["<div a\ufeffb/>", 6],
    ["<div\u00a0x/>", 4],
    ["<div.a\u00a0b/>", 6],
    ["div\u00a0x\n", 3],
    ["<div a=1 \u00a0b/>", 9],
  ];

  // web-tree-sitter's indices count UTF-16 units (probed: the root of
  // "<div a\u0085b/>x" ends at 11, its length, not at its 12 UTF-8 bytes).
  const covers = (
    n: {
      type: string;
      isMissing: boolean;
      startIndex: number;
      endIndex: number;
      children: any[];
    },
    at: number,
  ): boolean =>
    ((n.type === "ERROR" || n.isMissing) &&
      n.startIndex <= at &&
      at < n.endIndex) ||
    n.children.some((c) => covers(c, at));

  for (const [src, at] of REFUSED_SPACE_ROWS) {
    it(`refuses the space in ${JSON.stringify(src)} with an ERROR over it`, () => {
      const tree = parseMx(src);
      assert.ok(tree, "parse timed out");
      const root = tree.rootNode;
      assert.ok(root.hasError, root.toString());
      assert.ok(covers(root, at), root.toString());
      tree.delete();
      const twin = parseMx(src.slice(0, at) + " " + src.slice(at + 1));
      assert.ok(twin, "parse timed out");
      assert.ok(!twin.rootNode.hasError, twin.rootNode.toString());
      twin.delete();
    });
  }

  // Values, tag variables, body text and close tag names are not refused:
  // each tree is the one origin/main gave before the refusal existed.
  const UNCHANGED: [string, string][] = [
    [
      "<div a=x\u00a0/>",
      "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))",
    ],
    [
      "<div/x\u00a0 a/>",
      "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (tag_var (tag_var_expr (var_pattern))) (attr_name) (open_tag_end_self) (element_end)))",
    ],
    [
      "<p>a\u00a0b</p>",
      "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (open_tag_end) (text) (close_tag (close_tag_start) (close_tag_name) (close_tag_end)) (element_end)))",
    ],
    [
      "<div></div\u00a0>",
      "(document (ERROR (open_tag_start) (tag_name (tag_name_fragment)) (open_tag_end) (close_tag_start)) (text))",
    ],
  ];
  for (const [src, expected] of UNCHANGED) {
    it(`keeps today's tree for ${JSON.stringify(src)}`, () => {
      const tree = parseMx(src);
      assert.ok(tree, "parse timed out");
      assert.strictEqual(tree.rootNode.toString(), expected);
      tree.delete();
    });
  }
});

describe("non-Latin-1 look-behind", () => {
  // The look-behinds (the char before a token, an operator or a comment)
  // read a code point above U+00FF by its class, not by its low byte: a
  // Unicode space reads as whitespace, any other as a word char. Each tree is
  // its ASCII twin's, named in the comment.
  const ELEMENT_ATTR_TEXT =
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (open_tag_end) (text) (close_tag (close_tag_start) (close_tag_name) (close_tag_end)) (element_end)))";
  const ELEMENT_TEXT =
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (open_tag_end) (text) (close_tag (close_tag_start) (close_tag_name) (close_tag_end)) (element_end)))";
  const ELEMENT_ATTR_SELF =
    "(document (element (open_tag_start) (tag_name (tag_name_fragment)) (attr_name) (attr_value (attr_eq) (attr_value_expr)) (open_tag_end_self) (element_end)))";
  const CASES: [string, string][] = [
    // twin "<div a=xa>t</div>": U+4E3D's low byte is `=`, so `丽>` read as `=>`
    ["<div a=x\u4e3d>t</div>", ELEMENT_ATTR_TEXT],
    // twin "<p>a// x</p>": U+4E20's low byte is a space
    ["<p>\u4e20// x</p>", ELEMENT_TEXT],
    // twin "<div a=(x /2)/>": U+202F's low byte is `/`
    ["<div a=(x\u202f/2)/>", ELEMENT_ATTR_SELF],
    // twin "<div a=b/2/>": a non-ASCII identifier char, so `/` divides
    ["<div a=\u53d8/2/>", ELEMENT_ATTR_SELF],
    // twin "<p>aa// x</p>": the parser starts a comment only after a code <= 32
    ["<p>a\u2028// x</p>", ELEMENT_TEXT],
    ["<p>a\u2009// x</p>", ELEMENT_TEXT],
    ["<p>a\u3000// x</p>", ELEMENT_TEXT],
    // twin "<${xa}>t</${xa}>": the interpolated name's hash and the close
    // tag's hash both read the low byte
    [
      "<${x\u4e3d}>t</${x\u4e3d}>",
      "(document (element (open_tag_start) (tag_name (placeholder (placeholder_start) (placeholder_expr) (placeholder_end))) (open_tag_end) (text) (close_tag (close_tag_start) (close_tag_name) (close_tag_end)) (element_end)))",
    ],
  ];
  for (const [src, expected] of CASES) {
    it(`parses ${JSON.stringify(src)} as its ASCII twin`, () => {
      const tree = parseMx(src);
      assert.ok(tree, "parse timed out");
      assert.strictEqual(tree.rootNode.toString(), expected);
      tree.delete();
    });
  }
});

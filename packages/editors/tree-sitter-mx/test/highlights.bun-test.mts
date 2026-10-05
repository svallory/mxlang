// MX's own test (not vendored): the highlight query gives each decision 146
// shorthand the same capture in both positions, tag-adjacent (`shorthand:`
// field) and attribute position (no field), in html and concise mode. Runs
// the query the Zed extension ships (packages/editors/zed/languages/mx, built
// from queries/highlights.scm by its scripts/vendor.sh), so a regenerate that
// drops or narrows a capture fails here. Also the binding captures (tag params,
// tag var types, type args), which must start at their first real character,
// and the `=` of an attribute.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Query } from "web-tree-sitter";
import { MX, parseMx } from "../__tests__/util/language.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const QUERIES = {
  grammar: path.join(here, "../queries/highlights.scm"),
  zed: path.join(here, "../../zed/languages/mx/highlights.scm"),
};

function captures(file: string, src: string): string[] {
  const query = new Query(MX, fs.readFileSync(file, "utf-8"));
  const tree = parseMx(src);
  if (!tree) throw new Error(`parse timed out: ${JSON.stringify(src)}`);
  assert.ok(!tree.rootNode.hasError, tree.rootNode.toString());
  return query
    .captures(tree.rootNode)
    .filter(
      (c) => c.node.type.startsWith("shorthand_") || c.name === "attribute",
    )
    .map((c) => `${c.node.text}@${c.name}`);
}

const EXPECTED = [
  ".c@property",
  ":b@label",
  "x@attribute",
  "#d@constant",
  ".e@property",
  ":f@label",
];

describe("mx shorthand highlights", () => {
  for (const [name, file] of Object.entries(QUERIES)) {
    it(`${name}: html mode, both positions`, () => {
      assert.deepStrictEqual(
        captures(file, '<a.c:b x="1" #d .e :f>hi</a>\n'),
        EXPECTED,
      );
    });

    it(`${name}: concise mode, both positions`, () => {
      assert.deepStrictEqual(
        captures(file, 'a.c:b x="1" #d .e :f\n'),
        EXPECTED,
      );
    });

    it(`${name}: attribute position first, and in an attribute group`, () => {
      assert.deepStrictEqual(captures(file, "<input :email #main .big/>\n"), [
        ":email@label",
        "#main@constant",
        ".big@property",
      ]);
      assert.deepStrictEqual(captures(file, "div [ x=1 :n .c ]\n"), [
        "x@attribute",
        ":n@label",
        ".c@property",
      ]);
    });
  }
});

// Every capture of the given names, as `text@name`, plus its start column so a
// leading-whitespace regression names the exact byte.
function capturesNamed(file: string, src: string, names: string[]): string[] {
  const query = new Query(MX, fs.readFileSync(file, "utf-8"));
  const tree = parseMx(src);
  if (!tree) throw new Error(`parse timed out: ${JSON.stringify(src)}`);
  assert.ok(!tree.rootNode.hasError, tree.rootNode.toString());
  return query
    .captures(tree.rootNode)
    .filter((c) => names.includes(c.name))
    .map((c) => `${JSON.stringify(c.node.text)}@${c.name}`);
}

const BINDING = ["variable.parameter", "type", "variable", "operator"];

describe("mx binding and attribute-value captures", () => {
  for (const [name, file] of Object.entries(QUERIES)) {
    it(`${name}: tag params and their types start at the first character`, () => {
      assert.deepStrictEqual(
        capturesNamed(file, "<for|x: number, i| of=items>a</for>\n", BINDING),
        [
          '"x"@variable.parameter',
          '"number"@type',
          '"i"@variable.parameter',
          '"="@operator',
        ],
      );
    });

    it(`${name}: extra and missing whitespace around params`, () => {
      assert.deepStrictEqual(
        capturesNamed(file, "<for|a ,   b:   string   = 2|>x</for>\n", BINDING),
        [
          '"a "@variable.parameter',
          '"b"@variable.parameter',
          '"string   "@type',
        ],
      );
      assert.deepStrictEqual(
        capturesNamed(file, "<for|x:number,i|>x</for>\n", BINDING),
        ['"x"@variable.parameter', '"number"@type', '"i"@variable.parameter'],
      );
    });

    it(`${name}: a params list spread over lines (concise)`, () => {
      assert.deepStrictEqual(
        capturesNamed(file, "for|\n  x:\n  number,\n  i|\n  x\n", BINDING),
        ['"x"@variable.parameter', '"number"@type', '"i"@variable.parameter'],
      );
    });

    it(`${name}: tag variable type starts at the first character`, () => {
      assert.deepStrictEqual(
        capturesNamed(file, "<let/n: string = 1/>\n", BINDING),
        ['"n"@variable', '"string"@type', '"="@operator'],
      );
      assert.deepStrictEqual(
        capturesNamed(file, "<let/n:   (A | B) = 1/>\n", BINDING),
        ['"n"@variable', '"(A | B)"@type', '"="@operator'],
      );
    });

    it(`${name}: type arguments start at the first character`, () => {
      assert.deepStrictEqual(
        capturesNamed(file, "<foo< T , U >(x)/>\n", BINDING),
        ['"T , U "@type'],
      );
    });

    it(`${name}: empty params and empty type still parse`, () => {
      assert.deepStrictEqual(
        capturesNamed(file, "<for| |>x</for>\n", BINDING),
        [],
      );
      assert.deepStrictEqual(
        capturesNamed(file, "<for|x: |>x</for>\n", BINDING),
        ['"x"@variable.parameter', '""@type'],
      );
    });

    it(`${name}: attribute = and := are operators; the value is flat none`, () => {
      assert.deepStrictEqual(
        capturesNamed(file, '<a href="x" b=1 c:=2/>\n', ["operator", "none"]),
        [
          '"="@operator',
          '"\\"x\\""@none',
          '"="@operator',
          '"1"@none',
          '":="@operator',
          '"2"@none',
        ],
      );
    });
  }
});

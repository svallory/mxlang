// MX's own test (not vendored): the highlight query gives each decision 146
// shorthand the same capture in both positions, tag-adjacent (`shorthand:`
// field) and attribute position (no field), in html and concise mode. Runs
// the query the Zed extension ships (packages/editors/zed/languages/mx, built
// from queries/highlights.scm by its scripts/vendor.sh), so a regenerate that
// drops or narrows a capture fails here.
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

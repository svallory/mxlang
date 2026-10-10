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
    assert.strictEqual(errors.length, 7);
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

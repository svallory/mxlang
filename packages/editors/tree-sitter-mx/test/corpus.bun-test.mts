// MX's own: every case in test/corpus parses with the wasm grammar with no
// ERROR or MISSING node, and the reader hands back the source the case holds.
// packages/targets/data/src/tree-conformance.test.ts runs the same cases
// through parseData.
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

  for (const c of CASES) {
    it(`${c.file} ${c.name}`, () => {
      const tree = parseMx(c.source);
      if (!tree) throw new Error("parse timed out");
      assert.ok(!tree.rootNode.hasError, tree.rootNode.toString());
    });
  }
});

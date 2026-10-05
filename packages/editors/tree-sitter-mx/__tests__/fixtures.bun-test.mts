import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { compare } from "./util/compare.mts";
import { fixturesDir } from "./util/htmljs.mts";

const FIXTURES = await fixturesDir();

// MX decision 146 (`apps/docs/docs/design-notes/adr-name-sugar.md`,
// divergence 4): after whitespace, `.ident` ends the previous attribute value
// and starts a class shorthand, where htmljs-parser keeps `x .y` as one
// member expression. These exact snippets are removed from the fixture before
// the comparison, so the rest of each fixture is still compared event by
// event. Each snippet must be present: a fixture change under a new
// HTMLJS_REV fails here instead of silently comparing less.
const MX_DIVERGENCES: Record<string, string[]> = {
  "attr-operators-space-before": ["a=x .y a\n", "<a=x .y a/>\n"],
  "attr-operators-newline-before": ["<a=x\n.y a/>\n"],
};

describe("tree-sitter-mx fixtures (htmljs-parser)", () => {
  for (const entry of fs.readdirSync(FIXTURES)) {
    if (entry.endsWith(".skip")) {
      it.skip(entry.slice(0, -".skip".length));
      continue;
    }

    it(entry, () => {
      let src = fs.readFileSync(
        path.join(FIXTURES, entry, "input.marko"),
        "utf-8",
      );
      for (const snippet of MX_DIVERGENCES[entry] ?? []) {
        assert.ok(
          src.includes(snippet),
          `${entry} no longer contains ${JSON.stringify(snippet)}`,
        );
        src = src.replace(snippet, "");
      }
      const result = compare(src);
      if (!result.ok) {
        assert.fail(`${result.message}\n\ntree:\n${result.tree}`);
      }
    });
  }

  it("every MX divergence names an existing fixture", () => {
    for (const entry of Object.keys(MX_DIVERGENCES)) {
      assert.ok(fs.existsSync(path.join(FIXTURES, entry)), entry);
    }
  });
});

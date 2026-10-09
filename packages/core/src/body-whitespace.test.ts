import { describe, expect, it } from "vitest";
import cases from "../../../test-fixtures/body-whitespace/cases.json";
import { hasContent } from "./core.ts";
import { parseFragment } from "./fragment.ts";

// Use the parser's normalized MX AST (`MxText.value`, normalized by the body
// mode's rule exactly as Marko did), not raw text: normalization happens once.
describe("body presence follows Marko normalization (decision 141)", () => {
  it.each(cases)("$label", ({ body, html }) => {
    const tag = parseFragment(`<div>${body}</div>`).body[0];
    expect(tag.type).toBe("MxTag");
    expect(hasContent(tag.body)).toBe(html !== "");
  });
  it("no children means no body", () => {
    expect(hasContent([])).toBe(false);
  });
});

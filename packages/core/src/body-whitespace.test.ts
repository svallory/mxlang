import { describe, expect, it } from "vitest";
import cases from "../../../test-fixtures/body-whitespace/cases.json";
import { hasContent } from "./core.ts";
import { parseFragment } from "./fragment.ts";

// Use Marko's normalized AST, not raw text: normalization happens only once.
describe("body presence follows Marko normalization (decision 141)", () => {
  it.each(cases)("$label", ({ body, html }) => {
    const tag = parseFragment(`<div>${body}</div>`).body[0];
    expect(hasContent(tag.body.body)).toBe(html !== "");
  });
  it("no children means no body", () => {
    expect(hasContent([])).toBe(false);
  });
});

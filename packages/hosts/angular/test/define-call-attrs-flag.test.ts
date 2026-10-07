import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { angularDeclarations } from "../src/index.ts";

// Decision 160: Angular now passes one attributes object to a `<define>`
// call's first param, so the flag is on and core's multi-param warning —
// whose advice (destructure the first param) is exactly the shape this host
// emits — fires at the call's tag name.
it("sets defineCallPassesAttrs, turning core's multi-param define warning on", () => {
  expect(angularDeclarations.defineCallPassesAttrs).toBe(true);
});

describe("the multi-param define warning (core, positioned at the call)", () => {
  it("warns when a define with 2+ params is called with attributes", () => {
    const result = compile(
      "<define/Card|title, head|>${title}</define><Card title=\"a\"/>",
      "x.mx",
    );
    expect(result.warnings.map((w) => w.message)).toEqual([
      "`<Card>` has 2 params, but only the first parameter receives the attributes object; destructure it (`|{ a, b }|`) instead of reading one param per attribute",
    ]);
    expect(result.warnings[0]?.line).toBe(1);
  });

  it("does not warn for a single-param define called with attributes", () => {
    const result = compile("<define/Row|p|>${p.n}</define><Row n=1/>", "x.mx");
    expect(result.warnings).toEqual([]);
  });

  it("does not warn for a multi-param define called with tag arguments", () => {
    const result = compile(
      "<define/Row|a, b|>${a}${b}</define><Row(1, 2)/>",
      "x.mx",
    );
    expect(result.warnings).toEqual([]);
  });
});

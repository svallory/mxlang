import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

// A lowercase tag is a native element whatever binding is in scope (Marko
// 6.3.51 measured: native for an import).
describe("lowercase tag with a same-named binding in scope", () => {
  it("an imported `span` stays a native element", () => {
    const { code } = compileSolidMx(`<span title="search"/>`, {
      filename: "fixture.solid.mx",
      moduleBindings: new Set(["span"]),
      importSpecifiers: new Map([["span", "./x.ts"]]),
    });
    expect(code).toContain('<span title="search"></span>');
    expect(code).not.toContain("Dynamic");
  });
});

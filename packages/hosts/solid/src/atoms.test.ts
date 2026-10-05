import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

/** Decision 156, research row 14: a `.solid.mx` region inherits core's atoms. */
describe("atoms in a .solid.mx region", () => {
  it("`<div x=:a/>` compiles to the string", () => {
    const { code } = compileSolidMx("<div x=:a y=[:b, :rename-all]/>", {
      filename: "fixture.solid.mx",
    });
    expect(code).toContain('x="a"');
    expect(code).toContain('["b", "rename-all"]');
  });
});

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

  // Review round 2, finding 4: a `class=` value maps each atom to its literal.
  it("`class=f(:a, :b)` maps per atom", () => {
    const source = "<div class=f(:a, :b)/>";
    const { code, mappings } = compileSolidMx(source, {
      filename: "fixture.solid.mx",
    });
    const pairs = mappings.map((m) => [
      source.slice(m.sourceStart, m.sourceEnd),
      code.slice(m.generatedStart, m.generatedEnd),
    ]);
    expect(pairs).toContainEqual([":a", '"a"']);
    expect(pairs).toContainEqual([":b", '"b"']);
  });
});

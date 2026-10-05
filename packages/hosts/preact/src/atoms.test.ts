import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/** Decision 156 on the shared JSX emitter (preact, react and hono). */
describe("atoms on preact", () => {
  it("whole-value and nested atoms are string literals", () => {
    const { code } = compilePreactMx(
      "<div x=:a y=[:b, :rename-all]/>",
      "/f/a.mx",
    );
    expect(code).toContain('x="a"');
    expect(code).toContain('["b", "rename-all"]');
  });

  // Review round 2, finding 4: the spread-merge path and textarea content map
  // each atom to its literal, so a diagnostic after an atom does not drift.
  it.each([
    ["<div ...o x=f(:a, :b)/>\n", [":a", ":b"]],
    ["<textarea value=f(:t, :u)/>\n", [":t", ":u"]],
  ])("%j maps per atom", (source, atoms) => {
    const { code, mappings } = compilePreactMx(source, "/f/a.mx");
    const pairs = mappings.map((m) => [
      source.slice(m.sourceStart, m.sourceEnd),
      code.slice(m.generatedStart, m.generatedEnd),
    ]);
    for (const atom of atoms) {
      expect(pairs).toContainEqual([atom, JSON.stringify(atom.slice(1))]);
    }
  });
});

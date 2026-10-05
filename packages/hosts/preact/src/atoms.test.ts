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
});

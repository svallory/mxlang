import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

describe("nested reserved modifier fix-its", () => {
  it.each([
    ["on:foo:bar", "onFoo:bar=fn", "on-foo:bar=fn"],
    ["on:", "`on`", "did you mean"],
    ["style:foo:bar", "style={{ color: value }}", "style:color"],
  ])("uses the first prefix for %s", (name, advice, alternate) => {
    let error: unknown;
    try {
      compilePreactMx(
        name === "on:" ? "<div on:/>" : `<div ${name}=input.f/>`,
        "/fixtures/hint.mx",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ line: 1, column: 5 });
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected a compile error");
    expect(error.message).toContain(advice);
    expect(error.message).toContain(alternate);
    expect(error.message).not.toContain("class={{ active: cond }}");
  });
});

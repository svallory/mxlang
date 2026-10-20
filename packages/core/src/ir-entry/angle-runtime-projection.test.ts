import { describe, expect, it } from "vitest";
import { lowerSource } from "./index.ts";

// These complete results are the origin/main IR-entry baseline, not the host
// projection's behavior. Keeping authored types must not enable that mode.
describe("IR preserve-types is not a host type-check projection", () => {
  it.each([
    ["static as", "static const Foo = (() => null) as any;\n<Foo/>"],
    ["static non-null", "static const Foo = (() => null)!;\n<Foo/>"],
    ["const as", "<const/Foo=((() => null) as any)/><Foo/>"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored MX interpolation
    ["in key", '<for|k| in=input.obj by=("id" as any)>${k}</for>'],
  ])("preserves main's diagnostics and complete IR for %s", (_name, source) => {
    for (const options of [{}, { stripTypes: false }]) {
      expect(lowerSource(source, "/f/x.mx", options)).toMatchSnapshot();
    }
  });

  it.each([
    ["<x a=(<string>input.x)/>", "input.x"],
    ["<x a=(f(<string>input.x))/>", "f(<string>input.x)"],
  ])("keeps the legacy erased node and source slice for %s", (source, code) => {
    const result = lowerSource(source, "/f/x.mx", { stripTypes: false });
    expect(result.diagnostics).toEqual([]);
    const value = result.ir?.body[0];
    if (value?.kind !== "DelegatedTag")
      throw new Error("expected a DelegatedTag");
    const attr = value.tag.attrs[0];
    if (attr?.kind !== "dynamic")
      throw new Error("expected a dynamic attribute");
    expect(attr.value.code).toBe(code);
    expect(JSON.stringify(attr.value.node)).not.toContain("TSTypeAssertion");
    expect(JSON.stringify(attr.value.node)).not.toContain(
      "ParenthesizedExpression",
    );
    expect(attr.value.node.type).toBe(
      code === "input.x" ? "MemberExpression" : "CallExpression",
    );
  });
});

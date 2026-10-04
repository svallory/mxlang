import { expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

it("hoists one guard pair into frontmatter, retaining authored mapping offsets", () => {
  const source =
    "---\nconst a = Astro.props.a;\n---\n<div data-x=a data-y=Astro.props.b data-z=Astro.props.c ...Astro.props.attrs/>";
  const result = lowerAstroMx(source, "test.astro.mx");
  expect(result.code.match(/const __mxAttrValue =/g)).toHaveLength(1);
  expect(result.code.match(/const __mxAttrSpread =/g)).toHaveLength(1);
  expect(result.code.match(/attribute cannot be/g)).toHaveLength(2);
  for (const mapping of result.mappings) {
    const authored = source.slice(mapping.sourceStart, mapping.sourceEnd);
    const generated = result.code.slice(
      mapping.generatedStart,
      mapping.generatedEnd,
    );
    if (authored === "a" || authored === "Astro.props.b")
      expect(generated).toBe(authored);
  }
  expect(lowerAstroMx('<div data-x="x"/>', "test.astro.mx").code).not.toContain(
    "__mxAttrValue",
  );
});

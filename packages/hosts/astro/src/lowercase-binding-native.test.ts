import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

// A lowercase tag is a native element whatever binding is in scope (Marko
// 6.3.51 measured: native for an import).
describe("lowercase tag with a same-named binding in scope", () => {
  it("a frontmatter-imported `span` stays a native element", () => {
    const out = lowerAstroMx(
      `---\nimport { span } from "./x.ts";\n---\n<span title="search"/>\n`,
      "Test.astro.mx",
    );
    expect(JSON.stringify(out)).toContain('<span title=\\"search\\"></span>');
  });
});

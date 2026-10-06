// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source and messages use `${...}` placeholders.

import type { MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

// Decision 164 + addendum 1. A frontmatter import is never a tag here, so it
// is native and silent; a lowercase `<define>` is the tag binding.
describe("lowercase tag with a same-named binding in scope", () => {
  it("a frontmatter-imported `span` stays a native element, with no warning", () => {
    const warnings: MxWarning[] = [];
    const out = lowerAstroMx(
      `---\nimport { span } from "./x.ts";\n---\n<span title="search"/>\n`,
      "Test.astro.mx",
      { warnings },
    );
    expect(JSON.stringify(out)).toContain('<span title=\\"search\\"></span>');
    expect(warnings).toEqual([]);
  });

  it("row 1: a lowercase define does not capture `<span>`; the warning carries its L:C", () => {
    const warnings: MxWarning[] = [];
    lowerAstroMx(
      `---\n---\n<define/span|x|>d</define>\n<span title="search"/>\n`,
      "Test.astro.mx",
      { warnings },
    );
    expect(warnings.map((w) => w.message)).toEqual([
      "`<span>` is the native element; the `span` defined at 3:9 is not called. Rename it `Span` or write `<${span}>`",
    ]);
  });
});

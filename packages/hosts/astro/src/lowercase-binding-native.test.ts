// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source and messages use `${...}` placeholders.

import type { MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

// Decision 164 + addendum 1. A frontmatter import is never a tag here, so it
// is native and silent; `<define>` is rejected on this host, so there is no define row.
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

  it("a fence value import that is no element is Marko's local-variable error, on this host too", () => {
    let error: unknown;
    try {
      lowerAstroMx(
        `---\nimport layout from "./layout.ts"\n---\n<layout/>\n`,
        "Test.astro.mx",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      message:
        "Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use `<${layout}/>` or rename to `Layout`.",
      line: 4,
      column: 1,
    });
  });
});

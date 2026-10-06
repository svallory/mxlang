import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

// A lowercase tag is a native element whatever binding is in scope (Marko
// 6.3.51 measured: native for an import and for a lowercase `<define>`).
describe("lowercase tag with a same-named binding in scope", () => {
  it("an imported `span` stays a native element", () => {
    const { code } = compileHonoMx(
      `import { span } from "./x.ts"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
    );
    expect(code).toContain('<span title="search" />');
    expect(code).not.toContain("__mxDynamic(span");
  });

  it("a lowercase `<define/span>` does not capture `<span>`", () => {
    const { code } = compileHonoMx(
      `<define/span|x|>d</define>\n<span title="search"/>\n`,
      "/fixtures/a.mx",
    );
    expect(code).toContain('<span title="search" />');
    expect(code).not.toContain("span(undefined)");
  });
});

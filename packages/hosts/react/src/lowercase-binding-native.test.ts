import type { MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

// A lowercase tag is a native element whatever binding is in scope (Marko
// 6.3.51 measured: native for an import and for a lowercase `<define>`).
describe("lowercase tag with a same-named binding in scope", () => {
  it("an imported `span` stays a native element", () => {
    const { code } = compileReactMx(
      `import { span } from "./x.ts"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
    );
    expect(code).toContain('<span title="search" />');
    expect(code).not.toContain("__mxDynamic(span");
  });

  it("a lowercase `<define/span>` does not capture `<span>`", () => {
    const { code } = compileReactMx(
      `<define/span|x|>d</define>\n<span title="search"/>\n`,
      "/fixtures/a.mx",
    );
    expect(code).toContain('<span title="search" />');
    expect(code).not.toContain("span(undefined)");
  });

  it("warns at the tag, naming the import and where it was bound", () => {
    const warnings: MxWarning[] = [];
    compileReactMx(
      `import { span } from "./x.ts"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(warnings.map((w) => [w.line, w.column, w.message])).toEqual([
      [
        2,
        0,
        `\`<span>\` is the native element; the \`span\` imported at 1:1 is not called. Rename it \`Span\` or write \`<\${span}>\``,
      ],
    ]);
  });
});

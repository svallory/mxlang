import type { MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

// A lowercase tag is a native element whatever binding is in scope (Marko
// 6.3.51 measured: native for an import and for a lowercase `<define>`).
describe("lowercase tag with a same-named binding in scope", () => {
  it("an imported `span` stays a native element", () => {
    const { code } = compile(
      `import { span } from "./x.ts"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
    );
    expect(code).toContain('<span title=\\"search\\"></span>');
    expect(code).not.toContain("__mxRenderDynamic");
  });

  it("a lowercase `<define/span>` does not capture `<span>`", () => {
    const { code } = compile(
      `<define/span|x|>d</define>\n<span title="search"/>\n`,
      "/fixtures/a.mx",
    );
    expect(code).toContain('<span title=\\"search\\"></span>');
    expect(code).not.toContain("span(undefined)");
  });

  it("warns at the tag, naming the import and where it was bound", () => {
    const warnings: MxWarning[] = [];
    compile(
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

  it("warns for a lowercase `<define>`, naming where it was defined", () => {
    const warnings: MxWarning[] = [];
    compile(
      `<define/span|x|>d</define>\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(warnings[0]?.message).toBe(
      `\`<span>\` is the native element; the \`span\` defined at 1:9 is not called. Rename it \`Span\` or write \`<\${span}>\``,
    );
  });

  it("a dynamic tag still calls the binding, with no warning", () => {
    const warnings: MxWarning[] = [];
    const { code } = compile(
      `import { span } from "./x.ts"\n<\${span} title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain("__mxRenderDynamic");
    expect(warnings).toEqual([]);
  });

  it("a PascalCase import still resolves as a component, with no warning", () => {
    const warnings: MxWarning[] = [];
    const { code } = compile(
      `import Span from "./span.mx"\n<Span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).not.toContain("<span title=");
    expect(warnings).toEqual([]);
  });
});

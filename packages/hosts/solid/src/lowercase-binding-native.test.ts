// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source and messages use `${...}` placeholders.

import type { CustomTag, MxWarning } from "@mxlang/core";
import { parse } from "@mxlang/parser";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

// Decision 164 + addendum 1 on a Solid region (no `<define>` here: it cannot be
// declared inside a JSX expression).
const region = (source: string, specifier: string, warnings?: MxWarning[]) =>
  compileSolidMx(source, {
    filename: "fixture.solid.mx",
    moduleBindings: new Set(["span", "row"]),
    importSpecifiers: new Map([
      ["span", specifier],
      ["row", specifier],
    ]),
    importDefaultFromMarkoOrMx: specifier.endsWith(".mx")
      ? new Set(["span", "row"])
      : new Set<string>(),
    importSites: new Map([
      ["span", { line: 3, column: 0 }],
      ["row", { line: 4, column: 0 }],
    ]),
    warnings,
  });

describe("lowercase tag with a same-named binding in scope", () => {
  it("row 2: a tag import named like an element stays native, warning at the import's L:C", () => {
    const warnings: MxWarning[] = [];
    const { code } = region(`<span title="search"/>`, "./span.mx", warnings);
    expect(code).toContain('<span title="search"></span>');
    expect(code).not.toContain("Dynamic");
    expect(warnings.map((w) => w.message)).toEqual([
      "`<span>` is the native element; the `span` imported at 3:1 is not called. Rename it `Span` or write `<${span}>`",
    ]);
  });

  it("a value import never triggers the diagnostic", () => {
    const warnings: MxWarning[] = [];
    const { code } = region(`<span title="search"/>`, "./x.ts", warnings);
    expect(code).toContain('<span title="search"></span>');
    expect(warnings).toEqual([]);
  });

  it("a module-scope const is native and silent", () => {
    const warnings: MxWarning[] = [];
    const { code } = compileSolidMx(`<label>x</label>`, {
      filename: "fixture.solid.mx",
      moduleBindings: new Set(["label"]),
      warnings,
    });
    expect(code).toContain("<label>x</label>");
    expect(warnings).toEqual([]);
  });

  it("row 3: an unknown tag naming a tag import is the same error as on every target", () => {
    expect(() => region(`<row label="x"/>`, "./row.mx")).toThrow(
      "`<row>` is not a tag here: `row` is imported from ./row.mx, and a lowercase tag never calls a binding. Write `<Row>` (rename the import) or `<${row}/>`",
    );
  });

  it("row 4: a registered custom tag is still called, whatever is imported", () => {
    const customTags: Record<string, CustomTag> = {
      row: { transform: (call) => call.content?.children ?? [] },
    };
    const { code } = compileSolidMx(`<row>x</row>`, {
      filename: "fixture.solid.mx",
      moduleBindings: new Set(["row"]),
      importSpecifiers: new Map([["row", "./row.mx"]]),
      customTags,
    });
    expect(code).toContain("x");
    expect(code).not.toContain("<row");
  });
  it("the import's L:C and default-ness reach the region through the real parser", () => {
    const warnings: MxWarning[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: MxRegionCompile shape, avoiding a parser<->solid type cycle in a test
    const regionCompile = (input: any) =>
      compileSolidMx(input.source, { ...input, warnings });
    const source = [
      'import { createSignal } from "solid-js";',
      'import span from "./span.mx";',
      'import { label } from "./forms.mx";',
      "export function App() {",
      '  return (<div><span title="search"/><label>x</label></div>);',
      "}",
    ].join("\n");
    parse(source, "app.solid.mx", {
      // biome-ignore lint/suspicious/noExplicitAny: see regionCompile
      mxRegionCompile: regionCompile as any,
    });
    // `span` is a default `.mx` import: native, with its import site. `label`
    // is a named import from a tag module, so a value: native and silent.
    expect(warnings.map((w) => w.message)).toEqual([
      "`<span>` is the native element; the `span` imported at 2:1 is not called. Rename it `Span` or write `<${span}>`",
    ]);
  });
});

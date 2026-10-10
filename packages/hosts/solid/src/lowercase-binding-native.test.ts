// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source and messages use `${...}` placeholders.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomTag, MxWarning } from "@mxlang/core";
import { parse } from "@mxlang/tsx-bridge";
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
      "Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use `<${row}/>` or rename to `Row`.",
    );
  });

  it("a lowercase value import that is no element is the same Marko error (core rule, every host)", () => {
    expect(() => region(`<row/>`, "./row.ts")).toThrow(
      "Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use `<${row}/>` or rename to `Row`.",
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
  it("row 4: the registered tag's metadata wins too (return shape, `/var`, `<@item>`)", () => {
    // The authored `./row.mx` declares `<return>` and an `Input` whose `item`
    // is a plain prop; the registered `row` (a template-backed custom tag)
    // declares neither. Every call compiles exactly as with no import.
    const scratch = mkdtempSync(join(tmpdir(), "mx-solid-row4-meta-"));
    try {
      writeFileSync(
        join(scratch, "row.mx"),
        [
          "export interface Input { label: number; item?: { x: number } }",
          "<i>${input.label}</i>",
          "<return value=42/>",
        ].join("\n"),
      );
      const tagSource = "<p>${input.label}</p>";
      writeFileSync(join(scratch, "tag-row.mx"), tagSource);
      const customTags = {
        row: {
          template: {
            filename: join(scratch, "tag-row.mx"),
            source: tagSource,
          },
        } as unknown as CustomTag,
      };
      const outcome = (source: string, withImport: boolean) => {
        try {
          return compileSolidMx(source, {
            filename: join(scratch, "app.solid.mx"),
            customTags,
            ...(withImport && {
              moduleBindings: new Set(["row"]),
              importSpecifiers: new Map([["row", "./row.mx"]]),
              importDefaultFromMarkoOrMx: new Set(["row"]),
            }),
          }).code;
        } catch (error) {
          return `error: ${(error as Error).message}`;
        }
      };
      for (const call of [
        '<row label="x"/>',
        '<row/r label="x"/>',
        '<row label="x"><@item x="s"/></row>',
      ]) {
        expect(outcome(call, true)).toBe(outcome(call, false));
      }
      expect(outcome('<row label="x"/>', true)).not.toContain("$mxReturn");
      expect(outcome('<row/r label="x"/>', true)).toMatch(/^error: /);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

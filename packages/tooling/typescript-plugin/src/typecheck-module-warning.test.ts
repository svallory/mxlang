/**
 * A region file kind's `completeTypecheckModule` warning reaches a real
 * caller's `getCompileDiagnostics`, not only the hook's own return value.
 *
 * Solid's hook (`@mxlang/solid`'s `appendSolidBuiltinImport`) returns a
 * warning only when the printer emitted invalid TSX — a printer bug no real
 * `.solid.mx` file triggers (`source-bindings-silent-parse-failure`, round 2
 * of the PR #157 review); `@mxlang/solid`'s own tests pin that it returns
 * one. Here the kind is Solid's with the hook replaced by one that returns
 * the same shape, so `createRegionLanguagePlugin`'s real `createVirtualCode`
 * and `compileDiagnostics` plumbing run unmocked.
 */
import { describe, expect, it } from "vitest";
import { fileKindForPipeline } from "./file-kinds.ts";
import {
  createRegionLanguagePlugin,
  SOLID_MX_LANGUAGE_ID,
} from "./language.ts";

const ts = (await import("typescript")).default;

describe("a region kind's completeTypecheckModule warning reaches a real caller", () => {
  it("surfaces a positioned warning through getCompileDiagnostics, not just console", () => {
    const fileName = "/fixtures/uses-show.solid.mx";
    const source = "const el = <Show when=true>x</Show>;";
    const plugin = createRegionLanguagePlugin(ts, {
      ...fileKindForPipeline("region"),
      completeTypecheckModule: (code) => ({
        code: `${code}\nimport { Show } from "solid-js";\n`,
        warning: {
          message:
            "the printed .solid.mx module could not be parsed while checking Solid built-in imports, so they were added conservatively (Unexpected token (stubbed))",
          line: 1,
          column: 0,
        },
      }),
    });
    const virtual = plugin.createVirtualCode?.(
      fileName,
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected region virtual code");
    expect(plugin.getSyntaxError?.(fileName)).toBeUndefined();

    const diagnostics = plugin.getCompileDiagnostics(fileName);
    const warnings = diagnostics.filter((d) => d.category === "warning");
    expect(warnings).toHaveLength(1);
    const warning = warnings[0];
    if (!warning) throw new Error("expected a warning diagnostic");
    expect(warning.fileName).toBe(fileName);
    expect(warning.message).toContain("could not be parsed");
    expect(warning.message).toContain("added conservatively");
    // Positioned at the file's own start (line 1, column 1): `offset` 0
    // into the file's own source.
    expect(warning.offset).toBe(0);
    expect(warning.source).toBe(source);

    // The hook's code is what the type-check sees.
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(generated).toContain('import { Show } from "solid-js";');
  });

  it("runs Solid's real hook on a clean module: the import is added, no warning", () => {
    const fileName = "/fixtures/uses-show-clean.solid.mx";
    const plugin = createRegionLanguagePlugin(
      ts,
      fileKindForPipeline("region"),
    );
    const virtual = plugin.createVirtualCode?.(
      fileName,
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString("const el = <if=true>x</if>;"),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected region virtual code");
    expect(
      plugin
        .getCompileDiagnostics(fileName)
        .filter((d) => d.category === "warning"),
    ).toEqual([]);
    expect(virtual.snapshot.getText(0, virtual.snapshot.getLength())).toContain(
      'import { Show } from "solid-js";',
    );
  });
});

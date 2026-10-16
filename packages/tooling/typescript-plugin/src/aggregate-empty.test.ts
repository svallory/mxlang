/**
 * A dedicated file so the descriptor-load spy cannot leak into other suites.
 *
 * A `CompileErrors` aggregate that holds no errors still has to surface as one
 * diagnostic, never as nothing: the compile is replaced so it can throw one.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinLookup } from "@mxlang/targets";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { createMxLanguagePlugin, MX_LANGUAGE_ID } from "./mx-language.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

it("reports an aggregate with no errors as one diagnostic", () => {
  const descriptor = builtinLookup().target("preact-jsx");
  if (!descriptor?.load) throw new Error("missing preact compiler");
  const wired = descriptor as typeof descriptor & {
    load: NonNullable<typeof descriptor.load>;
  };
  const empty = Object.assign(new Error("nothing to unroll"), {
    name: "CompileErrors",
    errors: [],
  });
  vi.spyOn(wired, "load").mockReturnValue({
    compileModule() {
      throw empty;
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "mx-plugin-empty-aggregate-"));
  try {
    writeFileSync(join(dir, "package.json"), '{"mx":{"host":"preact"}}\n');
    const file = join(dir, "page.mx");
    const plugin = createMxLanguagePlugin(ts);
    plugin.createVirtualCode?.(
      file,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString("<div/>\n"),
      { getAssociatedScript: () => undefined },
    );
    const diagnostics = plugin.getCompileDiagnostics(file);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.category).toBe("error");
    expect(diagnostics[0]?.message).toContain("nothing to unroll");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

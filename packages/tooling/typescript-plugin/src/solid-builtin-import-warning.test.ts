/**
 * A dedicated file (not `index.test.ts`) so `vi.mock` on `@mxlang/parser`
 * cannot leak into any other suite in this package.
 *
 * `appendSolidBuiltinImport` operates on this package's own printed output,
 * never author-facing source, so its `sourceBindings` parse-failure branch
 * is only reachable if the printer itself ever emitted invalid TSX -- a bug
 * in this package, not something a real `.solid.mx` file can trigger
 * (`source-bindings-silent-parse-failure`, round 2 of the PR #157 review).
 * To still prove the warning reaches a real caller's `getCompileDiagnostics`
 * end to end, not just `appendSolidBuiltinImport`'s own return value, this
 * mocks only `sourceBindings` to report a parse error unconditionally,
 * while `createSolidMxLanguagePlugin`'s real `createVirtualCode` and its
 * real `compileDiagnostics` plumbing run unmocked.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@mxlang/parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mxlang/parser")>();
  return {
    ...actual,
    sourceBindings: (source: string) => {
      // Real bindings still flow through for every other consumer this
      // package's own code depends on (none, today, besides
      // `appendSolidBuiltinImport`) -- only the error branch is forced.
      void source;
      return {
        bindings: new Set<string>(),
        error: { message: "Unexpected token (mocked)", line: 1, column: 0 },
      };
    },
  };
});

const { createSolidMxLanguagePlugin, SOLID_MX_LANGUAGE_ID } = await import(
  "./language.ts"
);
const ts = (await import("typescript")).default;

describe("appendSolidBuiltinImport's parse-failure warning reaches a real caller (mocked sourceBindings)", () => {
  it("surfaces a positioned warning through getCompileDiagnostics, not just console", () => {
    const fileName = "/fixtures/uses-show.solid.mx";
    const source = "const el = <Show when=true>x</Show>;";
    const plugin = createSolidMxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      fileName,
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected SolidMX virtual code");
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

    // The built-in still got appended (over-import, the safe failure mode):
    // the generated code must still resolve `Show` for tsserver.
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(generated).toContain('import { Show } from "solid-js";');
  });
});

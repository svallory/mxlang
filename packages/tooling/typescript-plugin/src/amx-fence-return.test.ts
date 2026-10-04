import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AMX_LANGUAGE_ID, createAmxLanguagePlugin } from "./amx-language.ts";

const CANT_RETURN_OUTSIDE_FUNCTION = 1108;

/**
 * A `---` fence holding a top-level `return` is valid Astro: the host compiles
 * the fence into the component function's body. `lowerAstroMx` accepts it, but
 * the *type-check* projection runs the file through Astro's `convertToTSX`,
 * which puts the frontmatter at the top level of a TSX module, ahead of the
 * generated component function. TypeScript then sees a module-level `return`
 * and reports TS1108 for a fence the build accepts — a red squiggle in the
 * editor for a page that compiles.
 *
 * These drive the production path: the real plugin builds the real virtual
 * code, a real TypeScript language service reports real diagnostics over the
 * generated TSX, and the plugin's filter runs last. That order matters — a
 * filter fed a hand-made diagnostic would pass even with the fence's position
 * mapped wrongly.
 */
function rawTsxDiagnostics(source: string): {
  tsx: string;
  raw: ts.Diagnostic[];
} {
  const plugin = createAmxLanguagePlugin(ts);
  const virtual = plugin.createVirtualCode?.(
    "/project/page.astro.mx",
    AMX_LANGUAGE_ID,
    ts.ScriptSnapshot.fromString(source),
    { getAssociatedScript: () => undefined },
  );
  if (!virtual) throw new Error("expected AMX virtual code");
  const tsx = virtual.snapshot.getText(0, virtual.snapshot.getLength());

  const service = ts.createLanguageService({
    getCompilationSettings: () => ({
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      skipLibCheck: true,
      types: [],
    }),
    getScriptFileNames: () => ["/virtual/page.tsx"],
    getScriptVersion: () => "0",
    getScriptSnapshot: (name) => {
      if (name === "/virtual/page.tsx")
        return ts.ScriptSnapshot.fromString(tsx);
      const text = ts.sys.readFile(name);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => "/virtual",
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (name) =>
      name === "/virtual/page.tsx" || ts.sys.fileExists(name),
    readFile: (name) =>
      name === "/virtual/page.tsx" ? tsx : ts.sys.readFile(name),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  });

  return { tsx, raw: service.getSemanticDiagnostics("/virtual/page.tsx") };
}

/**
 * A diagnostic as a surface hands it to the filter.
 *
 * Both callers — the tsserver language service and `mx-tsc`'s program — reach
 * the filter *after* Volar has mapped the diagnostic back out of the virtual
 * TSX and into the author's file, so `start` is a source offset. That is the
 * space the filter tests against, and the space the fence occupies.
 */
function fenceReturnDiagnostic(start: number): ts.Diagnostic {
  return {
    code: CANT_RETURN_OUTSIDE_FUNCTION,
    start,
    length: 6,
    messageText:
      "A 'return' statement can only be used within a function body.",
    category: ts.DiagnosticCategory.Error,
  } as ts.Diagnostic;
}

function filterAfterVirtualCode(
  source: string,
  diagnostics: ts.Diagnostic[],
): ts.Diagnostic[] {
  const plugin = createAmxLanguagePlugin(ts);
  const fileName = "/project/page.astro.mx";
  plugin.createVirtualCode?.(
    fileName,
    AMX_LANGUAGE_ID,
    ts.ScriptSnapshot.fromString(source),
    { getAssociatedScript: () => undefined },
  );
  return (
    plugin.filterSemanticDiagnostics?.(fileName, diagnostics) ?? diagnostics
  );
}

describe("fence top-level return vs TS1108 (astro-template projection)", () => {
  it("puts the fence's return at TSX module top level, where TS1108 fires", () => {
    // The premise. `convertToTSX` emits the frontmatter ahead of the generated
    // component function, so TypeScript sees a module-level `return`. If Astro
    // ever moves the fence inside the function, this fails and the filter
    // becomes dead weight worth deleting.
    const { tsx, raw } = rawTsxDiagnostics("---\nreturn;\n---\n<h1>hi</h1>");

    expect(tsx).toContain("return;");
    expect(raw.some((d) => d.code === CANT_RETURN_OUTSIDE_FUNCTION)).toBe(true);
  });

  it("reports no TS1108 for a top-level return in the fence", () => {
    const source = "---\nreturn;\n---\n<h1>hi</h1>";

    const filtered = filterAfterVirtualCode(source, [
      fenceReturnDiagnostic(source.indexOf("return;")),
    ]);

    expect(filtered).toEqual([]);
  });

  it("still reports a real type error in the same fence", () => {
    // The filter drops one code in one region; ordinary type checking of the
    // fence is untouched.
    const source = [
      "---",
      "return;",
      'const n: number = "wrong";',
      "---",
      "<h1>hi</h1>",
    ].join("\n");
    const { raw } = rawTsxDiagnostics(source);
    const mismatch = raw.find((d) => d.code === 2322);

    expect(mismatch).toBeDefined();
    // Round-trips the real diagnostic back through the filter, so this proves
    // the filter leaves it alone rather than merely that 2322 is not 1108.
    if (!mismatch) throw new Error("expected a TS2322 in the fence");
    expect(filterAfterVirtualCode(source, [mismatch])).toHaveLength(1);
  });

  it("keeps a TS1108 positioned outside the fence", () => {
    // The suppression is region-scoped, not a blanket 1108 filter: Astro's own
    // language tools drop every 1108 in a `.astro` file, which would also hide
    // one an author wrote past the fence.
    const source = "---\nreturn;\n---\n<h1>hi</h1>";

    const filtered = filterAfterVirtualCode(source, [
      fenceReturnDiagnostic(source.indexOf("<h1>")),
    ]);

    expect(filtered).toHaveLength(1);
  });
});

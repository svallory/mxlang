import {
  type CodeMapping,
  createLanguage,
  type Language,
  type LanguagePlugin,
  type VirtualCode,
} from "@volar/language-core";
import { transformDiagnostic } from "@volar/typescript/lib/node/transform";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  anchorEmptyMappings,
  approximateSuffix,
  approximateUnmapped,
  approximateUnmappedDiagnostics,
  mxBugSuffix,
  PROGRAM_DIAGNOSTIC_METHODS,
} from "./unmapped-diagnostics.ts";

/**
 * A diagnostic whose generated position has no source mapping is never
 * dropped (decision 161). These tests drive the shared seam with a real Volar
 * `Language` and a hand-written virtual module, so each mapping is exact and
 * what Volar itself does with the result (`transformDiagnostic`, the function
 * that used to return `undefined`) is the oracle.
 */

const FILE = "/p/page.mx";

// 1-based generated text, one statement per line:
//   1  `import a from "x";`
//   2  `const first = 1;`      <- mapped (source `first`)
//   3  `const gap = oops;`     <- no mapping
//   4  `const last = 2;`       <- mapped (source `last`)
const GENERATED = [
  'import a from "x";',
  "const first = 1;",
  "const gap = oops;",
  "const last = 2;",
].join("\n");
const SOURCE = "<let/first=1/>\n<p>{ghost}</p>\n<let/last=2/>\n";

const generatedAt = (needle: string) => GENERATED.indexOf(needle);
const sourceAt = (needle: string) => SOURCE.indexOf(needle);

function mapping(
  needle: string,
  sourceNeedle: string,
  data: CodeMapping["data"],
): CodeMapping {
  return {
    sourceOffsets: [sourceAt(sourceNeedle)],
    generatedOffsets: [generatedAt(needle)],
    lengths: [sourceNeedle.length],
    generatedLengths: [needle.length],
    data,
  };
}

const reported: CodeMapping["data"] = { verification: true };

function languageWith(
  mappings: CodeMapping[],
  preventLeadingOffset = false,
): Language<string> {
  const plugin: LanguagePlugin<string> = {
    getLanguageId: () => "mx",
    createVirtualCode: (): VirtualCode => ({
      id: "root",
      languageId: "typescript",
      snapshot: {
        getText: (start, end) => GENERATED.slice(start, end),
        getLength: () => GENERATED.length,
        getChangeRange: () => undefined,
      },
      mappings,
      embeddedCodes: [],
    }),
    typescript: {
      extraFileExtensions: [],
      getServiceScript: (root) => ({
        code: root,
        extension: ".tsx",
        scriptKind: ts.ScriptKind.TSX,
        ...(preventLeadingOffset ? { preventLeadingOffset } : {}),
      }),
    },
  };
  const language = createLanguage<string>(
    anchorEmptyMappings([plugin]),
    new Map() as never,
    () => undefined,
  );
  language.scripts.set(FILE, {
    getText: (start, end) => SOURCE.slice(start, end),
    getLength: () => SOURCE.length,
    getChangeRange: () => undefined,
  });
  return language;
}

/** A diagnostic on the generated text, in virtual-file coordinates. */
function diagnosticAt(
  needle: string,
  leading = SOURCE.length,
  overrides: Partial<ts.Diagnostic> = {},
): ts.Diagnostic {
  return {
    file: ts.createSourceFile(FILE, "", ts.ScriptTarget.Latest),
    start: leading + generatedAt(needle),
    length: needle.length,
    category: ts.DiagnosticCategory.Error,
    code: 2304,
    source: "ts",
    messageText: "Cannot find name 'oops'.",
    ...overrides,
  };
}

const twoMappings = [
  mapping("const first = 1;", "<let/first=1/>", reported),
  mapping("const last = 2;", "<let/last=2/>", reported),
];

describe("approximateUnmapped", () => {
  it("returns a diagnostic Volar can map as the very same object", () => {
    const language = languageWith(twoMappings);
    const exact = diagnosticAt("first");

    expect(approximateUnmapped(language, exact)).toBe(exact);
  });

  it("returns a diagnostic without a position untouched", () => {
    const language = languageWith(twoMappings);
    const global = { ...diagnosticAt("oops"), start: undefined };

    expect(approximateUnmapped(language, global)).toBe(global);
  });

  it("returns a diagnostic on a file with no virtual code untouched", () => {
    const language = languageWith(twoMappings);
    const plain = diagnosticAt("oops", 0, {
      file: ts.createSourceFile("/p/other.ts", "", ts.ScriptTarget.Latest),
    });

    expect(approximateUnmapped(language, plain)).toBe(plain);
  });

  it("moves an unmapped diagnostic onto the nearest mapped span before it, and calls code MX wrote an MX bug", () => {
    const language = languageWith(twoMappings);
    const moved = approximateUnmapped(language, diagnosticAt("oops"));

    // Generated line 3 holds no authored code: MX's own scaffolding.
    // `oops` is on generated line 3, column 13 (1-based).
    expect(moved.messageText).toBe(
      `Cannot find name 'oops'.${mxBugSuffix(3, 13)}`,
    );
    expect(moved.messageText).toBe(
      "Cannot find name 'oops'. (in MX-generated code, not yours: an MX bug; generated 3:13)",
    );
    // The span of `const first = 1;`, in virtual-file coordinates.
    expect(moved.start).toBe(SOURCE.length + generatedAt("const first = 1;"));
    expect(moved.length).toBe("const first = 1;".length);
    expect(moved.code).toBe(2304);
    expect(moved.category).toBe(ts.DiagnosticCategory.Error);
  });

  it("says the position is approximate when the generated line holds an authored expression", () => {
    const language = languageWith([
      ...twoMappings,
      // `const gap =` on the diagnostic's own line is authored; `oops` is not.
      mapping("const gap =", "<p>{", reported),
    ]);
    const moved = approximateUnmapped(language, diagnosticAt("oops"));

    expect(moved.messageText).toBe(
      "Cannot find name 'oops'. (position approximate: generated 3:13)",
    );
    expect(moved.messageText).toBe(
      `Cannot find name 'oops'.${approximateSuffix(3, 13)}`,
    );
    expect(moved.start).toBe(SOURCE.length + generatedAt("const gap ="));
  });

  it("falls back to the first mapped span after it when nothing maps before", () => {
    const language = languageWith([twoMappings[1] as CodeMapping]);
    const moved = approximateUnmapped(language, diagnosticAt("oops"));

    expect(moved.start).toBe(SOURCE.length + generatedAt("const last = 2;"));
  });

  it("treats a range that any mapping covers as mapped", () => {
    const language = languageWith([
      mapping("const gap = oops;", "<p>{ghost}</p>", reported),
      {
        sourceOffsets: [0],
        generatedOffsets: [0],
        lengths: [SOURCE.length],
        generatedLengths: [GENERATED.length],
        data: reported,
      },
      mapping("oops", "ghost", { verification: true }),
    ]);
    // The range is covered (by the mapping of `oops` itself), so it is mapped
    // and stays exact: nothing moves.
    const exact = diagnosticAt("oops");
    expect(approximateUnmapped(language, exact)).toBe(exact);
  });

  it("reports a diagnostic in a module with no mapped span at the file start", () => {
    const language = languageWith([]);
    const moved = approximateUnmapped(language, diagnosticAt("oops"));

    expect(moved.start).toBe(SOURCE.length);
    expect(moved.length).toBe(0);
    expect(moved.messageText).toContain(
      "(in MX-generated code, not yours: an MX bug; generated 3:13)",
    );
  });

  it("suffixes the outermost message of a message chain and keeps the rest", () => {
    const language = languageWith(twoMappings);
    const chain: ts.DiagnosticMessageChain = {
      messageText: "Type 'a' is not assignable to type 'b'.",
      category: ts.DiagnosticCategory.Error,
      code: 2322,
      next: [
        {
          messageText: "Because.",
          category: ts.DiagnosticCategory.Error,
          code: 1,
        },
      ],
    };
    const moved = approximateUnmapped(
      language,
      diagnosticAt("oops", SOURCE.length, { messageText: chain }),
    );

    expect(moved.messageText).toEqual({
      ...chain,
      messageText: `Type 'a' is not assignable to type 'b'.${mxBugSuffix(3, 13)}`,
    });
  });

  it("honours preventLeadingOffset: offsets are generated offsets", () => {
    const language = languageWith(twoMappings, true);
    const moved = approximateUnmapped(language, diagnosticAt("oops", 0));

    expect(moved.start).toBe(generatedAt("const first = 1;"));
  });

  it("leaves a diagnostic a mapping deliberately hides for Volar to drop", () => {
    // The `.astro.mx` fence's TS1108 is rejected by the mapping's own
    // `verification.shouldReport`: a host hiding a spurious error, not a gap.
    const hiding: CodeMapping["data"] = {
      verification: { shouldReport: (_source, code) => code !== "1108" },
    };
    const language = languageWith([
      mapping("const gap = oops;", "<p>{ghost}</p>", hiding),
    ]);
    const spurious = diagnosticAt("oops", SOURCE.length, { code: 1108 });

    expect(approximateUnmapped(language, spurious)).toBe(spurious);
    expect(transformDiagnostic(language, spurious, undefined, false)).toBe(
      undefined,
    );
  });
});

describe("the drop path (decision 161)", () => {
  // Volar's `transformDiagnostic` is the function that used to swallow a
  // diagnostic it could not map. These fail if a diagnostic that went through
  // the seam is still swallowed there, whatever Volar version is installed.
  it("never lets Volar swallow a diagnostic that has a mapped span to move to", () => {
    const language = languageWith(twoMappings);
    const unmapped = diagnosticAt("oops");

    expect(transformDiagnostic(language, unmapped, undefined, false)).toBe(
      undefined,
    );
    const moved = approximateUnmapped(language, unmapped);
    const mapped = transformDiagnostic(language, moved, undefined, false);

    expect(mapped).toBeDefined();
    // `<let/first=1/>` is the first statement of the source: line 1, column 1.
    expect(mapped?.start).toBe(sourceAt("<let/first=1/>"));
    expect(mapped?.length).toBe("<let/first=1/>".length);
  });

  it("keeps a diagnostic in a module with no mapped span, at 1:1 of the source", () => {
    const language = languageWith([]);
    const moved = approximateUnmapped(language, diagnosticAt("oops"));
    const mapped = transformDiagnostic(language, moved, undefined, false);

    expect(mapped?.start).toBe(0);
  });
});

describe("approximateUnmappedDiagnostics", () => {
  function fakeProgram(diagnostics: ts.Diagnostic[]) {
    const calls: unknown[][] = [];
    const program: Record<string, unknown> = {};
    for (const name of PROGRAM_DIAGNOSTIC_METHODS) {
      program[name] = (...args: unknown[]) => {
        calls.push([name, ...args]);
        return diagnostics;
      };
    }
    return { program, calls };
  }

  it("wraps every named method, passing the arguments through", () => {
    const language = languageWith(twoMappings);
    const exact = diagnosticAt("first");
    const { program, calls } = fakeProgram([exact, diagnosticAt("oops")]);
    approximateUnmappedDiagnostics(
      program,
      PROGRAM_DIAGNOSTIC_METHODS,
      () => language,
    );

    for (const name of PROGRAM_DIAGNOSTIC_METHODS) {
      const result = (program[name] as (...a: unknown[]) => ts.Diagnostic[])(
        "sf",
        "token",
      );
      expect(result[0]).toBe(exact);
      expect(String(result[1]?.messageText)).toContain("generated 3:13");
    }
    expect(calls).toHaveLength(PROGRAM_DIAGNOSTIC_METHODS.length);
    expect(calls[0]).toEqual([PROGRAM_DIAGNOSTIC_METHODS[0], "sf", "token"]);
  });

  it("passes diagnostics through while there is no Volar language yet", () => {
    const unmapped = diagnosticAt("oops");
    const { program } = fakeProgram([unmapped]);
    approximateUnmappedDiagnostics(
      program,
      ["getSemanticDiagnostics"],
      () => undefined,
    );

    const result = (program.getSemanticDiagnostics as () => ts.Diagnostic[])();
    expect(result[0]).toBe(unmapped);
  });
});

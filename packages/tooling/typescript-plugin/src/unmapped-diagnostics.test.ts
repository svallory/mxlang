import {
  type CodeMapping,
  createLanguage,
  type Language,
  type LanguagePlugin,
} from "@volar/language-core";
import { transformDiagnostic } from "@volar/typescript/lib/node/transform";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  type AuthoredSpan,
  approximateSuffix,
  approximateUnmapped,
  approximateUnmappedDiagnostics,
  approximateUnmappedEmit,
  mxBugSuffix,
  PROGRAM_DIAGNOSTIC_METHODS,
  type SpannedVirtualCode,
} from "./unmapped-diagnostics.ts";

/**
 * A diagnostic whose generated position has no source mapping is never
 * dropped (decision 161). These tests drive the shared seam with a real Volar
 * `Language` and a hand-written virtual module, so each mapping is exact and
 * what Volar itself does with the result (`transformDiagnostic`, the function
 * that used to return `undefined`) is the oracle.
 */

const FILE = "/p/page.mx";
const reported: CodeMapping["data"] = { verification: true };

/** A source and the module generated from it, with its own mappings. */
class World {
  constructor(
    readonly source: string,
    readonly generated: string,
  ) {}

  /** Where `needle` is in the source. */
  src(needle: string, from = 0): number {
    const at = this.source.indexOf(needle, from);
    if (at < 0) throw new Error(`no ${needle} in source`);
    return at;
  }

  /** Where `needle` is in the generated module. */
  gen(needle: string): number {
    const at = this.generated.indexOf(needle);
    if (at < 0) throw new Error(`no ${needle} in generated`);
    return at;
  }

  mapping(
    needle: string,
    sourceNeedle: string,
    data: CodeMapping["data"] = reported,
  ): CodeMapping {
    return {
      sourceOffsets: [this.src(sourceNeedle)],
      generatedOffsets: [this.gen(needle)],
      lengths: [sourceNeedle.length],
      generatedLengths: [needle.length],
      data,
    };
  }

  /** The span of the first `needle` in the source, for `authoredSpans`. */
  span(needle: string, from = 0): AuthoredSpan {
    const start = this.src(needle, from);
    return { start, end: start + needle.length };
  }

  language(
    mappings: CodeMapping[],
    authored?: AuthoredSpan[],
    preventLeadingOffset = false,
  ): Language<string> {
    const { generated, source } = this;
    const plugin: LanguagePlugin<string> = {
      getLanguageId: () => "mx",
      createVirtualCode: (): SpannedVirtualCode => ({
        id: "root",
        languageId: "typescript",
        snapshot: {
          getText: (start, end) => generated.slice(start, end),
          getLength: () => generated.length,
          getChangeRange: () => undefined,
        },
        // The seam adds its own mappings to this array: one per language.
        mappings: [...mappings],
        embeddedCodes: [],
        ...(authored ? { authoredSpans: () => authored } : {}),
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
      [plugin],
      new Map() as never,
      () => undefined,
    );
    language.scripts.set(FILE, {
      getText: (start, end) => source.slice(start, end),
      getLength: () => source.length,
      getChangeRange: () => undefined,
    });
    return language;
  }

  /** A diagnostic on the generated text, in virtual-file coordinates. */
  diagnostic(
    needle: string,
    overrides: Partial<ts.Diagnostic> = {},
    leading = this.source.length,
  ): ts.Diagnostic {
    return {
      file: ts.createSourceFile(FILE, "", ts.ScriptTarget.Latest),
      start: leading + this.gen(needle),
      length: needle.length,
      category: ts.DiagnosticCategory.Error,
      code: 2304,
      source: "ts",
      messageText: "Cannot find name 'oops'.",
      ...overrides,
    };
  }

  /** Where Volar puts `diagnostic` in the source, after the seam ran. */
  place(
    language: Language<string>,
    diagnostic: ts.Diagnostic,
  ): { start: number; length: number; messageText: string } | undefined {
    const mapped = transformDiagnostic(
      language,
      approximateUnmapped(language, diagnostic),
      undefined,
      false,
    );
    return (
      mapped && {
        start: mapped.start as number,
        length: mapped.length as number,
        messageText: String(
          typeof mapped.messageText === "string"
            ? mapped.messageText
            : mapped.messageText.messageText,
        ),
      }
    );
  }
}

// A page the way the hosts map it today: tag names and attribute values are
// mapped, a whole tag never is.
const PAGE = new World(
  "<div title=t><span>${a}</span>${oops}</div>",
  [
    'const d = "div";',
    'const t = "t";',
    "const a = a;",
    "const w = __wrap(oops);",
  ].join("\n"),
);
const pageMappings = [
  PAGE.mapping('"div"', "div"),
  PAGE.mapping('"t"', "t"),
  PAGE.mapping("a;", "a"),
];
const pageSpans = [
  PAGE.span("<div title=t><span>${a}</span>${oops}</div>"),
  PAGE.span("title=t"),
  PAGE.span("<span>${a}</span>"),
];

describe("approximateUnmapped", () => {
  it("returns a diagnostic Volar can map as the very same object", () => {
    const language = PAGE.language(pageMappings, pageSpans);
    const exact = PAGE.diagnostic('"div"');

    expect(approximateUnmapped(language, exact)).toBe(exact);
  });

  it("returns a diagnostic without a position untouched", () => {
    const language = PAGE.language(pageMappings, pageSpans);
    const global = { ...PAGE.diagnostic("oops"), start: undefined };

    expect(approximateUnmapped(language, global)).toBe(global);
  });

  it("returns a diagnostic on a file with no virtual code untouched", () => {
    const language = PAGE.language(pageMappings, pageSpans);
    const plain = PAGE.diagnostic(
      "oops",
      { file: ts.createSourceFile("/p/other.ts", "", ts.ScriptTarget.Latest) },
      0,
    );

    expect(approximateUnmapped(language, plain)).toBe(plain);
  });

  describe("position: the nearest enclosing authored span", () => {
    it("lands on the enclosing tag, not on a nearer preceding sibling", () => {
      const language = PAGE.language(pageMappings, pageSpans);
      const placed = PAGE.place(language, PAGE.diagnostic("oops"));

      // `oops` is the author's, spelled in the <div> after `<span>${a}</span>`:
      // the span of the sibling (`a`, or <span>) is never acceptable.
      expect(placed?.start).toBe(pageSpans[0]?.start);
      expect(placed?.length).toBe(
        (pageSpans[0]?.end as number) - (pageSpans[0]?.start as number),
      );
    });

    it("lands on the attribute when the diagnostic came from inside one", () => {
      const world = new World(
        "<div title=missing><b>${x}</b></div>",
        'const t = "t";\nconst v = missing;\nconst x = x;',
      );
      const language = world.language(
        [world.mapping("x;", "x")],
        [
          world.span("<div title=missing><b>${x}</b></div>"),
          world.span("title=missing"),
          world.span("<b>${x}</b>"),
        ],
      );
      const placed = world.place(language, world.diagnostic("missing"));

      expect(placed?.start).toBe(world.src("title=missing"));
      expect(placed?.length).toBe("title=missing".length);
    });

    it("lands on the tag around scaffolding that has no authored spelling", () => {
      const language = PAGE.language(pageMappings, pageSpans);
      const placed = PAGE.place(language, PAGE.diagnostic("__wrap"));

      // Scaffolding is not in the source, so the whole gap after `a` (to the
      // end of the file) is the region: the <div>, the construct holding it.
      expect(placed?.start).toBe(pageSpans[0]?.start);
    });

    it("is the file start (1:1) when no construct encloses it", () => {
      const language = PAGE.language(pageMappings, []);
      const placed = PAGE.place(language, PAGE.diagnostic("oops"));

      expect(placed).toMatchObject({ start: 0, length: 0 });
    });

    it("is the file start in a module with no mapping at all", () => {
      const language = PAGE.language([]);
      const placed = PAGE.place(language, PAGE.diagnostic("oops"));

      expect(placed).toMatchObject({ start: 0, length: 0 });
    });

    it("is the file start when every mapping rejects the diagnostic's code", () => {
      const rejecting: CodeMapping["data"] = {
        verification: { shouldReport: () => false },
      };
      const language = PAGE.language(
        [PAGE.mapping('"div"', "div", rejecting)],
        [],
      );
      const placed = PAGE.place(language, PAGE.diagnostic("oops"));

      expect(placed).toMatchObject({ start: 0, length: 0 });
    });

    it("honours preventLeadingOffset: offsets are generated offsets", () => {
      const language = PAGE.language(pageMappings, pageSpans, true);
      const placed = PAGE.place(language, PAGE.diagnostic("oops", {}, 0));

      expect(placed?.start).toBe(pageSpans[0]?.start);
    });

    it("gives the same answer when the same diagnostic is asked for again", () => {
      const language = PAGE.language(pageMappings, pageSpans);
      const first = PAGE.place(language, PAGE.diagnostic("oops"));
      const second = PAGE.place(language, PAGE.diagnostic("oops"));

      expect(second).toEqual(first);
      expect(second?.messageText).toBe(first?.messageText);
    });

    it("keeps an exact mapping exact after an unmapped one was placed", () => {
      const language = PAGE.language(pageMappings, pageSpans);
      PAGE.place(language, PAGE.diagnostic("oops"));
      const exact = PAGE.diagnostic('"div"');

      expect(approximateUnmapped(language, exact)).toBe(exact);
    });
  });

  describe("suffix: per generated range", () => {
    // One generated line, as Solid emits a whole template: an authored value,
    // MX scaffolding far from any authored code, and a name next to one.
    const ONE_LINE = new World(
      "<p>${user.name}</p><p>${count}</p>",
      "const t = () => <p>{user.name}</p>;" +
        "__scaffold_that_is_long_enough();" +
        "const u = () => <p>{count}</p>;",
    );
    const lineMappings = [
      ONE_LINE.mapping("user.name", "user.name"),
      ONE_LINE.mapping("count}", "count}"),
    ];

    it("calls a range next to authored code approximate, and one with none an MX bug, on the same line", () => {
      const language = ONE_LINE.language(lineMappings, [
        ONE_LINE.span("<p>${user.name}</p>"),
      ]);
      const near = ONE_LINE.diagnostic("{user.name}");
      const far = ONE_LINE.diagnostic("__scaffold_that_is");

      const nearMessage = String(
        approximateUnmapped(language, near).messageText,
      );
      const farMessage = String(approximateUnmapped(language, far).messageText);
      const [nearLine, nearColumn] = [1, ONE_LINE.gen("{user.name}") + 1];
      const [farLine, farColumn] = [1, ONE_LINE.gen("__scaffold_that_is") + 1];

      expect(nearMessage).toBe(
        `Cannot find name 'oops'.${approximateSuffix(nearLine, nearColumn)}`,
      );
      expect(farMessage).toBe(
        `Cannot find name 'oops'.${mxBugSuffix(farLine, farColumn)}`,
      );
      expect(farMessage).toContain("an MX bug");
      expect(nearMessage).not.toContain("an MX bug");
    });

    it("does not call a token the source merely spells an authored name", () => {
      // `count` is in the source, but the diagnostic's range holds no authored
      // code: no text search decides the kind.
      const language = ONE_LINE.language(lineMappings, []);
      const scaffold = ONE_LINE.diagnostic("__scaffold_that_is");

      expect(
        String(approximateUnmapped(language, scaffold).messageText),
      ).toContain("an MX bug");
    });
  });

  it("suffixes the outermost message of a message chain and keeps the rest", () => {
    const language = PAGE.language(pageMappings, pageSpans);
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
      PAGE.diagnostic("oops", { messageText: chain }),
    );

    expect(moved.messageText).toEqual({
      ...chain,
      messageText: `Type 'a' is not assignable to type 'b'.${mxBugSuffix(4, 18)}`,
    });
  });

  it("leaves a diagnostic a mapping deliberately hides for Volar to drop", () => {
    // The `.astro.mx` fence's TS1108 is rejected by the mapping's own
    // `verification.shouldReport`: a host hiding a spurious error, not a gap.
    const hiding: CodeMapping["data"] = {
      verification: { shouldReport: (_source, code) => code !== "1108" },
    };
    const language = PAGE.language([
      PAGE.mapping("const w = __wrap(oops);", "${oops}", hiding),
    ]);
    const spurious = PAGE.diagnostic("oops", { code: 1108 });

    expect(approximateUnmapped(language, spurious)).toBe(spurious);
    expect(transformDiagnostic(language, spurious, undefined, false)).toBe(
      undefined,
    );
  });

  describe("relatedInformation", () => {
    const related = (
      world: World,
      needle: string,
    ): ts.DiagnosticRelatedInformation => ({
      category: ts.DiagnosticCategory.Message,
      code: 2728,
      file: ts.createSourceFile(FILE, "", ts.ScriptTarget.Latest),
      start: world.source.length + world.gen(needle),
      length: needle.length,
      messageText: "'x' is declared here.",
    });

    it("approximates a related location in generated code instead of letting Volar drop it", () => {
      const language = PAGE.language(pageMappings, pageSpans);
      const diagnostic = PAGE.diagnostic('"div"', {
        relatedInformation: [related(PAGE, "__wrap")],
      });
      const approximated = approximateUnmapped(language, diagnostic);
      const mapped = transformDiagnostic(
        language,
        approximated,
        undefined,
        false,
      );

      expect(mapped?.relatedInformation).toHaveLength(1);
      expect(mapped?.relatedInformation?.[0]?.messageText).toContain(
        "'x' is declared here.",
      );
      expect(mapped?.relatedInformation?.[0]?.start).toBe(pageSpans[0]?.start);
    });

    it("returns the same object when the diagnostic and its related entries are mapped", () => {
      const language = PAGE.language(pageMappings, pageSpans);
      const exact = PAGE.diagnostic('"div"', {
        relatedInformation: [related(PAGE, '"t"')],
      });

      expect(approximateUnmapped(language, exact)).toBe(exact);
    });
  });
});

describe("the drop path (decision 161)", () => {
  // Volar's `transformDiagnostic` is the function that used to swallow a
  // diagnostic it could not map. These fail if a diagnostic that went through
  // the seam is still swallowed there, whatever Volar version is installed.
  it("never lets Volar swallow a diagnostic", () => {
    const language = PAGE.language(pageMappings, pageSpans);
    const unmapped = PAGE.diagnostic("oops");

    expect(transformDiagnostic(language, unmapped, undefined, false)).toBe(
      undefined,
    );
    expect(PAGE.place(language, unmapped)).toBeDefined();
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
    const language = PAGE.language(pageMappings, pageSpans);
    const exact = PAGE.diagnostic('"div"');
    const { program, calls } = fakeProgram([exact, PAGE.diagnostic("oops")]);
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
      expect(String(result[1]?.messageText)).toContain("generated 4:");
    }
    expect(calls).toHaveLength(PROGRAM_DIAGNOSTIC_METHODS.length);
    expect(calls[0]).toEqual([PROGRAM_DIAGNOSTIC_METHODS[0], "sf", "token"]);
  });

  it("passes diagnostics through while there is no Volar language yet", () => {
    const unmapped = PAGE.diagnostic("oops");
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

describe("approximateUnmappedEmit", () => {
  function emitting(diagnostics: ts.Diagnostic[]) {
    const seen: unknown[][] = [];
    const program = {
      emit: (...args: unknown[]) => {
        seen.push(args);
        return { emitSkipped: true, diagnostics, extra: 1 };
      },
    } as unknown as { emit: ts.Program["emit"] };
    return { program, seen };
  }

  it("approximates the diagnostics of an emit result and keeps the rest of it", () => {
    const language = PAGE.language(pageMappings, pageSpans);
    const exact = PAGE.diagnostic('"div"');
    const { program, seen } = emitting([exact, PAGE.diagnostic("oops")]);
    approximateUnmappedEmit(program, () => language);

    const result = program.emit("sf" as never) as unknown as {
      diagnostics: ts.Diagnostic[];
      extra: number;
    };

    expect(seen).toEqual([["sf"]]);
    expect(result.extra).toBe(1);
    expect(result.diagnostics[0]).toBe(exact);
    expect(String(result.diagnostics[1]?.messageText)).toContain(
      "generated 4:",
    );
  });

  it("passes the result through while there is no Volar language yet", () => {
    const unmapped = PAGE.diagnostic("oops");
    const { program } = emitting([unmapped]);
    approximateUnmappedEmit(program, () => undefined);

    const result = program.emit() as unknown as {
      diagnostics: ts.Diagnostic[];
    };
    expect(result.diagnostics[0]).toBe(unmapped);
  });
});

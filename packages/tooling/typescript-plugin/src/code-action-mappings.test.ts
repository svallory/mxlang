import {
  type CodeInformation,
  type CodeMapping,
  isCodeActionsEnabled,
  type Language,
  SourceMap,
} from "@volar/language-core";
import { transformFileTextChanges } from "@volar/typescript/lib/node/transform";
import type * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  dropVerificationOnlyCodeActions,
  isVerificationOnly,
  landsOnVerificationOnly,
} from "./code-action-mappings.ts";

/** The full `CodeInformation` an emitter gives authored code. */
const codeInformation: CodeInformation = {
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
  structure: true,
  format: false,
};

describe("isVerificationOnly", () => {
  it("is true for `{ verification: true }`", () => {
    expect(isVerificationOnly({ verification: true })).toBe(true);
  });

  it("is true for the object form `{ verification: { shouldReport } }`", () => {
    expect(
      isVerificationOnly({ verification: { shouldReport: () => true } }),
    ).toBe(true);
  });

  it("is true when every other key is falsy", () => {
    expect(
      isVerificationOnly({
        verification: true,
        navigation: false,
        completion: undefined,
      }),
    ).toBe(true);
  });

  it("is false for authored code's full `CodeInformation`", () => {
    expect(isVerificationOnly(codeInformation)).toBe(false);
  });

  it("is false for `{ verification: true, navigation: true }`", () => {
    expect(isVerificationOnly({ verification: true, navigation: true })).toBe(
      false,
    );
  });

  it("is false without verification", () => {
    expect(isVerificationOnly({})).toBe(false);
    expect(isVerificationOnly({ verification: false })).toBe(false);
    expect(isVerificationOnly({ navigation: true })).toBe(false);
  });
});

const SOURCE = "/p/page.mx";
const VERIFY: CodeInformation = { verification: true };

/** A mapping of `length` generated characters at `generated` onto `source`. */
const mapping = (
  generated: number,
  source: number,
  length: number,
  data: CodeInformation,
): CodeMapping => ({
  generatedOffsets: [generated],
  sourceOffsets: [source],
  lengths: [length],
  data,
});

/**
 * The parts of a Volar `Language` the lookup reads: one source script whose
 * root virtual code is its service script, with one source map per entry of
 * `maps` (`maps.forEach` yields them in order, as Volar's does).
 */
function stubLanguage(
  maps: CodeMapping[][],
  leading?: { sourceLength: number },
): Language<string> {
  const code = { id: "root", languageId: "typescript", mappings: maps[0] };
  const serviceScript = {
    code,
    extension: ".ts",
    scriptKind: 3,
    preventLeadingOffset: leading === undefined,
  };
  const sourceScript = {
    id: SOURCE,
    snapshot: { getLength: () => leading?.sourceLength ?? 0 },
    targetIds: new Set(),
    associatedOnly: false,
    generated: {
      root: code,
      languagePlugin: { typescript: { getServiceScript: () => serviceScript } },
    },
  };
  const sourceMaps = maps.map((list) => new SourceMap(list));
  return {
    scripts: {
      get: (fileName: string) =>
        fileName === SOURCE ? sourceScript : undefined,
      fromVirtualCode: () => sourceScript,
    },
    maps: {
      *forEach() {
        for (const map of sourceMaps) yield [sourceScript, map];
      },
    },
  } as unknown as Language<string>;
}

const change = (start: number, length: number): ts.FileTextChanges[] => [
  {
    fileName: SOURCE,
    textChanges: [{ span: { start, length }, newText: "x" }],
  },
];

/** Where Volar itself puts the change (its own `transformFileTextChanges`). */
const volarSpans = (
  language: Language<string>,
  changes: ts.FileTextChanges[],
) =>
  transformFileTextChanges(
    language,
    changes,
    false,
    isCodeActionsEnabled,
  ).flatMap((file) => file.textChanges.map((text) => text.span));

describe("landsOnVerificationOnly on synthetic mappings", () => {
  it("is true for a change inside a verification-only mapping", () => {
    const language = stubLanguage([[mapping(10, 3, 10, VERIFY)]]);
    expect(landsOnVerificationOnly(language, change(12, 2))).toBe(true);
    expect(volarSpans(language, change(12, 2))).toEqual([
      { start: 5, length: 2 },
    ]);
  });

  it("is false for a change inside a full `CodeInformation` mapping", () => {
    const language = stubLanguage([[mapping(10, 3, 10, codeInformation)]]);
    expect(landsOnVerificationOnly(language, change(12, 2))).toBe(false);
    expect(volarSpans(language, change(12, 2))).toEqual([
      { start: 5, length: 2 },
    ]);
  });

  it("is false for a change no mapping takes, which Volar drops", () => {
    const language = stubLanguage([[mapping(10, 3, 10, VERIFY)]]);
    expect(landsOnVerificationOnly(language, change(30, 2))).toBe(false);
    expect(volarSpans(language, change(30, 2))).toEqual([]);
  });

  it("subtracts the leading offset (the source's length) first", () => {
    const language = stubLanguage([[mapping(10, 3, 10, VERIFY)]], {
      sourceLength: 100,
    });
    expect(landsOnVerificationOnly(language, change(112, 2))).toBe(true);
    expect(landsOnVerificationOnly(language, change(12, 2))).toBe(false);
    expect(volarSpans(language, change(112, 2))).toEqual([
      { start: 5, length: 2 },
    ]);
  });

  it("decides by the first mapping that takes the change, as Volar does", () => {
    const fullFirst = stubLanguage([
      [mapping(10, 3, 10, codeInformation), mapping(10, 40, 10, VERIFY)],
    ]);
    expect(landsOnVerificationOnly(fullFirst, change(12, 2))).toBe(false);
    expect(volarSpans(fullFirst, change(12, 2))).toEqual([
      { start: 5, length: 2 },
    ]);
    const verifyFirst = stubLanguage([
      [mapping(10, 40, 10, VERIFY), mapping(10, 3, 10, codeInformation)],
    ]);
    expect(landsOnVerificationOnly(verifyFirst, change(12, 2))).toBe(true);
    expect(volarSpans(verifyFirst, change(12, 2))).toEqual([
      { start: 42, length: 2 },
    ]);
  });

  it("skips a mapping that does not enable code actions", () => {
    const language = stubLanguage([
      [mapping(10, 3, 10, { navigation: true }), mapping(10, 40, 10, VERIFY)],
    ]);
    expect(landsOnVerificationOnly(language, change(12, 2))).toBe(true);
    expect(volarSpans(language, change(12, 2))).toEqual([
      { start: 42, length: 2 },
    ]);
  });

  it("goes on to the next source map only when one takes nothing", () => {
    const secondTakes = stubLanguage([
      [mapping(50, 0, 5, codeInformation)],
      [mapping(10, 40, 10, VERIFY)],
    ]);
    expect(landsOnVerificationOnly(secondTakes, change(12, 2))).toBe(true);
    expect(volarSpans(secondTakes, change(12, 2))).toEqual([
      { start: 42, length: 2 },
    ]);
    const firstTakes = stubLanguage([
      [mapping(10, 3, 10, codeInformation)],
      [mapping(10, 40, 10, VERIFY)],
    ]);
    expect(landsOnVerificationOnly(firstTakes, change(12, 2))).toBe(false);
    expect(volarSpans(firstTakes, change(12, 2))).toEqual([
      { start: 5, length: 2 },
    ]);
  });
});

describe("landsOnVerificationOnly", () => {
  it("leaves a change in a file with no service script alone", () => {
    const language = {
      scripts: { get: () => undefined },
    } as unknown as Language<string>;
    expect(
      landsOnVerificationOnly(language, [
        {
          fileName: "/p/plain.ts",
          textChanges: [{ span: { start: 0, length: 0 }, newText: "x" }],
        },
      ]),
    ).toBe(false);
  });
});

describe("dropVerificationOnlyCodeActions on a stub service", () => {
  // Generated 10..20 maps onto a verification-only mapping, 30..40 onto
  // authored code.
  const language = stubLanguage([
    [mapping(10, 3, 10, VERIFY), mapping(30, 20, 10, codeInformation)],
  ]);
  const onVerification = change(12, 2);
  const onAuthored = change(32, 2);
  /** A service whose refactor and organize imports answer `answer`. */
  const wrapped = (
    answer: {
      refactor?: ts.RefactorEditInfo;
      organize?: ts.FileTextChanges[];
    },
    withLanguage = true,
  ) => {
    const service = {
      getCodeFixesAtPosition: () => [],
      getCombinedCodeFix: () => ({ changes: [] }),
      getEditsForRefactor: () => answer.refactor,
      organizeImports: () => answer.organize ?? [],
    } as unknown as ts.LanguageService;
    dropVerificationOnlyCodeActions(service, () =>
      withLanguage ? language : undefined,
    );
    return service;
  };
  const refactor = (service: ts.LanguageService) =>
    service.getEditsForRefactor("/p/page.mx", {}, 0, "r", "a", {});
  const organize = (service: ts.LanguageService) =>
    service.organizeImports({ type: "file", fileName: "/p/page.mx" }, {}, {});

  it("a refactor with an edit on a verification-only mapping is undefined", () => {
    const info: ts.RefactorEditInfo = {
      edits: [...onAuthored, ...onVerification],
      renameFilename: "/p/page.mx",
      renameLocation: 32,
    };
    expect(refactor(wrapped({ refactor: info }))).toBeUndefined();
  });

  it("a refactor on authored code is the same object", () => {
    const info: ts.RefactorEditInfo = { edits: onAuthored };
    expect(refactor(wrapped({ refactor: info }))).toBe(info);
  });

  it("an undefined refactor passes through", () => {
    expect(refactor(wrapped({}))).toBeUndefined();
  });

  it("organize imports with a change on a verification-only mapping is []", () => {
    expect(
      organize(wrapped({ organize: [...onAuthored, ...onVerification] })),
    ).toEqual([]);
  });

  it("organize imports on authored code is the same array", () => {
    expect(organize(wrapped({ organize: onAuthored }))).toBe(onAuthored);
  });

  it("passes both through when there is no language yet", () => {
    const info: ts.RefactorEditInfo = { edits: onVerification };
    const service = wrapped(
      { refactor: info, organize: onVerification },
      false,
    );
    expect(refactor(service)).toBe(info);
    expect(organize(service)).toBe(onVerification);
  });
});

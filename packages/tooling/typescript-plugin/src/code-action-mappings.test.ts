import type { CodeInformation, Language } from "@volar/language-core";
import { describe, expect, it } from "vitest";
import {
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

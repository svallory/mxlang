import ts from "typescript";
import { describe, expect, it } from "vitest";
import { plainDiagnostics } from "./plugin-service.ts";

describe("plainDiagnostics", () => {
  const file = ts.createSourceFile(
    "/p/a.ts",
    "const a = 1;",
    ts.ScriptTarget.ES2022,
  );
  const chained: ts.Diagnostic = {
    file,
    start: 6,
    length: 1,
    code: 2322,
    category: ts.DiagnosticCategory.Error,
    source: "mx",
    messageText: {
      messageText: "outer",
      category: ts.DiagnosticCategory.Error,
      code: 2322,
      next: [
        {
          messageText: "inner",
          category: ts.DiagnosticCategory.Error,
          code: 2322,
        },
      ],
    },
    relatedInformation: [
      {
        file,
        start: 0,
        length: 5,
        code: 1,
        category: ts.DiagnosticCategory.Message,
        messageText: "related",
      },
    ],
  };

  it("keeps code, start, length and the flattened message, never the file", () => {
    expect(plainDiagnostics([chained])).toStrictEqual([
      { code: 2322, start: 6, length: 1, message: "outer\n  inner" },
    ]);
  });

  it("adds source and category only when asked", () => {
    expect(plainDiagnostics([chained], ["source", "category"])).toStrictEqual([
      {
        code: 2322,
        start: 6,
        length: 1,
        message: "outer\n  inner",
        source: "mx",
        category: ts.DiagnosticCategory.Error,
      },
    ]);
  });
});

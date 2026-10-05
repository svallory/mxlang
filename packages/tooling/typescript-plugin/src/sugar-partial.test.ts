import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMxLanguagePlugin } from "./index.ts";

/**
 * Decision 146 (PR 3), completions: Volar's completion requests go through
 * this plugin's virtual code, and an editor asks on a buffer that is mid-edit.
 * The sugar sigils right after whitespace inside a tag (`<input :`, `<input #`,
 * `<input .`) must never make building that code throw. (The language server's
 * half is `language-server/src/sugar-partial.test.ts`.)
 */

const PARTIAL = [
  "<input :",
  "<input #",
  "<input .",
  '<input type="email" :',
  '<input type="email" #',
  '<input type="email" .',
  "<input:",
  "<:",
  "input :",
  "input #",
  'input type="email" .',
  "<input :e",
  "<input #m .b :",
];

describe("the TypeScript plugin on a buffer mid-edit", () => {
  const plugin = createMxLanguagePlugin(ts) as unknown as {
    createVirtualCode(
      fileName: string,
      languageId: string,
      snapshot: ts.IScriptSnapshot,
      ctx: unknown,
    ): { snapshot: ts.IScriptSnapshot } | undefined;
    getCompileDiagnostics(
      fileName: string,
    ): { message: string; offset?: number }[];
  };

  it.each(PARTIAL)(
    "%j builds its virtual code and reports exactly one compile diagnostic",
    (text) => {
      const file = "/work/page.mx";
      const warn = console.warn;
      console.warn = () => {};
      try {
        expect(() =>
          plugin.createVirtualCode(
            file,
            "mx",
            ts.ScriptSnapshot.fromString(`${text}\n`),
            { getAssociatedScript: () => undefined },
          ),
        ).not.toThrow();
        const diagnostics = plugin.getCompileDiagnostics(file);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.offset).toBeGreaterThanOrEqual(0);
        expect(diagnostics[0]?.offset).toBeLessThanOrEqual(text.length);
      } finally {
        console.warn = warn;
      }
    },
  );
});

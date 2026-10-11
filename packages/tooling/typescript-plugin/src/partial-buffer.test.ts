import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMxLanguagePlugin } from "./index.ts";

/**
 * Completions on a buffer mid-edit: Volar's completion requests go through
 * this plugin's virtual code, and an editor asks on a buffer that is mid-edit.
 * A sigil right after whitespace inside a tag (`<input :`, `<input #`,
 * `<input .`) must never make building that code throw. Each buffer reports
 * what stock Marko reads, so the concise `input :` (the default attribute's
 * `value:`) reports none. (The language server's half is
 * `language-server/src/partial-buffer.test.ts`.)
 */

/** Each buffer and its exact number of compile diagnostics. */
const PARTIAL: [string, number][] = [
  ["<input :", 1],
  ["<input #", 1],
  ["<input .", 1],
  ['<input type="email" :', 1],
  ['<input type="email" #', 1],
  ['<input type="email" .', 1],
  ["<input:", 1],
  ["<:", 1],
  ["input :", 0],
  ["input #", 1],
  ['input type="email" .', 1],
  ["<input :e", 1],
  ["<input #m .b :", 1],
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
    "%j builds its virtual code and reports exactly %i compile diagnostic(s)",
    (text, count) => {
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
        expect(diagnostics).toHaveLength(count);
        for (const diagnostic of diagnostics) {
          expect(diagnostic.offset).toBeGreaterThanOrEqual(0);
          expect(diagnostic.offset).toBeLessThanOrEqual(text.length);
        }
      } finally {
        console.warn = warn;
      }
    },
  );
});

import { defaultTarget, hostOf } from "@mxlang/targets";
import { describe, expect, it } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

/**
 * Completions on a buffer mid-edit. This language server completes nothing
 * (diagnostics only, decisions 71/72: Marko's own server completes attribute
 * names for `.mx`), but an editor asks for completions on a buffer that is
 * mid-edit, and every tool compiles that buffer first. So a sigil right after
 * whitespace inside a tag (`<input :`, `<input #`, `<input .`) must never
 * crash a tool: the server returns diagnostics (a parse error at the cursor
 * at worst). The TypeScript plugin half is in its own package.
 */

const target = defaultTarget();
const policy = { target, host: hostOf(target) };

/**
 * The exact number of diagnostics each buffer gives, as stock Marko reads it:
 * an unclosed tag, Marko's "Invalid attribute name" on a spaced `#`/`.`, or a
 * value that a ` :` continues. The concise `input :` is complete Marko (the
 * default attribute's `value:`), so it gives none.
 */
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

describe("the language server on a buffer mid-edit", () => {
  it.each(PARTIAL)("%j gives exactly %i diagnostic(s)", (text, count) => {
    const unexpected: unknown[] = [];
    const diagnostics = diagnoseDocument(
      `${text}\n`,
      "file:///work/page.mx",
      policy,
      (error) => unexpected.push(error),
      "mx",
    );
    expect(unexpected).toEqual([]);
    expect(diagnostics).toHaveLength(count);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.range.start.line).toBe(0);
      expect(diagnostic.range.start.character).toBeLessThanOrEqual(text.length);
    }
  });
});

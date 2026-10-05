import { defaultTarget, hostOf } from "@mxlang/target-registry";
import { describe, expect, it } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

/**
 * Decision 146 (PR 3), completions. This language server completes nothing
 * (diagnostics only, decisions 71/72: Marko's own server completes attribute
 * names for `.mx`), but an editor asks for completions on a buffer that is
 * mid-edit, and every tool compiles that buffer first. So the sugar sigils
 * right after whitespace inside a tag (`<input :`, `<input #`, `<input .`) must
 * never crash a tool: the server returns diagnostics (a parse error at the
 * cursor at worst). The TypeScript plugin half is in its own package.
 */

const target = defaultTarget();
const policy = { target, host: hostOf(target) };

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

describe("the language server on a buffer mid-edit", () => {
  it.each(PARTIAL)(
    "%j does not throw and reports at most one error",
    (text) => {
      const unexpected: unknown[] = [];
      const diagnostics = diagnoseDocument(
        `${text}\n`,
        "file:///work/page.mx",
        policy,
        (error) => unexpected.push(error),
        "mx",
      );
      expect(unexpected).toEqual([]);
      expect(diagnostics.length).toBeLessThanOrEqual(1);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.range.start.line).toBe(0);
        expect(diagnostic.range.start.character).toBeLessThanOrEqual(
          text.length,
        );
      }
    },
  );
});

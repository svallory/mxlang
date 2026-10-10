import { defaultTarget, hostOf } from "@mxlang/targets";
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

/**
 * The exact number of diagnostics each buffer gives: a parse error or a sugar
 * error at the cursor. `input :` is 1 since the bare `:` in attribute position
 * became a positioned error ("`:` is name sugar and needs a name", PR 3 round
 * 2, leader ruling); before that it was Marko's `value:` and gave 0, so an
 * author who typed `:` and stopped got no diagnostic at all.
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
  ["input :", 1],
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

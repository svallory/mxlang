/**
 * A core error's `fixes` survive `lowerAstroMx`'s re-raise as an
 * `AstroTemplateError`, and their offsets stay in the whole `.astro.mx` file
 * (the `---` fence included), the space the error's own position is in.
 *
 * Astro declares `<effect>` unsupported, so no real Astro compile carries a
 * fix. The test removes that row for its duration, so core's own `<effect>`
 * error (which carries the rename) reaches the catch.
 */
import type { IrDiagnosticFix } from "@mxlang/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AstroTemplateError,
  astroTemplateDeclarations,
  lowerAstroMx,
} from "./astro-template.ts";

type Tags = { effect?: unknown };
const tags = astroTemplateDeclarations.tags as Tags;
const effectRow = tags.effect;

beforeEach(() => {
  delete tags.effect;
});
afterEach(() => {
  tags.effect = effectRow;
});

function thrown(source: string): AstroTemplateError {
  try {
    lowerAstroMx(source, "Test.astro.mx");
  } catch (error) {
    if (error instanceof AstroTemplateError) return error;
    throw error;
  }
  throw new Error("expected the file to fail lowering");
}

function applyFix(source: string, fix: IrDiagnosticFix): string {
  let out = source;
  for (const edit of [...fix.edits].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, edit.offset) + edit.newText + out.slice(edit.end);
  }
  return out;
}

describe("AstroTemplateError carries a core error's fixes", () => {
  it.each([
    ["a fence of ASCII", "const x = 1;"],
    ["a fence with a non-BMP character", "const x = '\u{1F600}';"],
    ["a multi-line fence", "const a = 1;\nconst b = 2;\nconst c = 3;"],
  ])("%s", (_name, fence) => {
    const file = `---\n${fence}\n---\n<div>\n  <effect>go()</effect>\n</div>\n`;
    const error = thrown(file);
    expect(error.diagnosticCode).toBe("MX_RESERVED_EFFECT_TAG");
    const [fix] = error.fixes as IrDiagnosticFix[];
    expect(fix?.title).toBe("Rename to `<script>`");
    expect(fix?.edits.map((e) => file.slice(e.offset, e.end))).toEqual([
      "effect",
      "effect",
    ]);
    expect(applyFix(file, fix as IrDiagnosticFix)).toContain(
      "<script>go()</script>",
    );
  });

  it("a self-closing `<effect/>` has the one open-name edit", () => {
    const file = "---\n---\n<effect/>\n";
    const [fix] = thrown(file).fixes as IrDiagnosticFix[];
    expect(fix?.edits.map((e) => file.slice(e.offset, e.end))).toEqual([
      "effect",
    ]);
  });

  it("an error with no fix leaves `fixes` unset", () => {
    const error = thrown("---\n---\n<else/>\n");
    expect(error.fixes).toBeUndefined();
  });

  it("with the host's row in place there is no fix", () => {
    tags.effect = effectRow;
    const error = thrown("---\n---\n<effect>go()</effect>\n");
    expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect(error.fixes).toBeUndefined();
  });
});

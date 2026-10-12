/**
 * A fix-it survives a region's offset mapping. A `.preact.mx` region sits
 * inside a module, so its lowering runs on a padded source whose offsets are
 * the file's; the bridge re-raises the error as the parser's. The fix's edits
 * must still index the *whole file*, in the coordinates the diagnostic's own
 * position is in, however much text (CRLF, non-BMP) precedes the region.
 *
 * Preact declares `<effect>` unsupported, so no real host offers this fix:
 * the region is compiled here with the host's declarations minus that row, so
 * core's own `<effect>` error (which carries the rename) is what reaches the
 * bridge. The host's own error carries none.
 */
import type { IrDiagnosticFix } from "@mxlang/core";
import { createTargetLookup } from "@mxlang/core";
import { print } from "@mxlang/tsx-bridge";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { preactDialect } from "./dialect.ts";
import { preactRegionDeclarations } from "./emitter.ts";
import { compilePreactRegion } from "./index.ts";
import { compileJsxRegion } from "./region.ts";

const targets = createTargetLookup([descriptor]);
const FILE = "/fixtures/region-fixes/Panel.preact.mx";

const { effect: _effect, ...tags } = preactRegionDeclarations.tags;
const withoutEffectRow = { ...preactRegionDeclarations, tags };

type Hook = NonNullable<
  NonNullable<Parameters<typeof print>[2]>["mxRegionCompile"]
>;

interface Raised extends Error {
  diagnosticCode?: string;
  fixes?: IrDiagnosticFix[];
  loc?: { line: number; column: number; index?: number };
  end?: { line: number; column: number };
}

function raised(source: string, hostOwnRow: boolean): Raised {
  try {
    print(source, FILE, {
      mx: true,
      mxRegionCompile: ((input) =>
        hostOwnRow
          ? compilePreactRegion(input.source, { ...input, targets })
          : compileJsxRegion(input.source, {
              ...input,
              targets,
              dialect: preactDialect,
              declarations: withoutEffectRow,
              segment: "preact",
            })) as Hook,
    });
  } catch (error) {
    return error as Raised;
  }
  throw new Error("expected a compile error");
}

function applyFix(source: string, fix: IrDiagnosticFix): string {
  let out = source;
  for (const edit of [...fix.edits].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, edit.offset) + edit.newText + out.slice(edit.end);
  }
  return out;
}

const module = (before: string, body: string) =>
  `import { useState } from "preact/hooks";\n${before}export function Panel() {\n  return (\n    <div>\n      ${body}\n    </div>\n  );\n}\n`;

describe("a region's `<effect>` fix indexes the whole file", () => {
  it.each([
    ["a plain module", ""],
    ["a CRLF prefix", "// a\r\n// b\r\n"],
    ["a non-BMP character before it", "// \u{1F600} hello\n"],
    ["a long multi-line prefix", "// x\n".repeat(40)],
  ])("%s", (_name, before) => {
    const file = module(before, "<effect>go()</effect>");
    const error = raised(file, false);
    expect(error.diagnosticCode).toBe("MX_RESERVED_EFFECT_TAG");
    const [fix] = error.fixes as IrDiagnosticFix[];
    expect(fix?.title).toBe("Rename to `<script>`");
    // Both names are found at the file's own offsets...
    expect(fix?.edits.map((e) => file.slice(e.offset, e.end))).toEqual([
      "effect",
      "effect",
    ]);
    // ...the first at the offset the error's own start names (its line and
    // column, and its index), so the diagnostic and its fix agree.
    const lines = file.split("\n");
    const start =
      lines.slice(0, (error.loc?.line ?? 1) - 1).join("\n").length +
      ((error.loc?.line ?? 1) > 1 ? 1 : 0) +
      (error.loc?.column ?? 0);
    expect(fix?.edits[0]?.offset).toBe(start);
    expect(fix?.edits[0]?.offset).toBe(error.loc?.index);
    expect(applyFix(file, fix as IrDiagnosticFix)).toContain(
      "<script>go()</script>",
    );
  });

  it("the fixed region compiles", () => {
    const file = module("// \u{1F600}\r\n", "<effect>go()</effect>");
    const [fix] = raised(file, false).fixes as IrDiagnosticFix[];
    const fixed = applyFix(file, fix as IrDiagnosticFix);
    // Preact refuses `<script>` in a region with its own sentence: past the
    // reserved-name error, the rename reached the host's rules.
    expect(() =>
      print(fixed, FILE, {
        mx: true,
        mxRegionCompile: ((input) =>
          compilePreactRegion(input.source, { ...input, targets })) as Hook,
      }),
    ).toThrow("`<script>` is not supported in embedded MX on Preact");
  });

  it("the error is the parser's, with the fixes non-enumerable", () => {
    const error = raised(module("", "<effect/>"), false);
    expect(Object.keys(error)).not.toContain("fixes");
    expect(error.fixes?.[0]?.edits).toHaveLength(1);
  });

  it("the host's own `<effect>` error offers no fix", () => {
    const error = raised(module("", "<effect>go()</effect>"), true);
    expect(error.message).toContain(
      "`<effect>` is not supported in embedded MX on Preact.",
    );
    expect(error.fixes).toBeUndefined();
  });
});

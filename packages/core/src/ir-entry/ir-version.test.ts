import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as core from "../index.ts";

/**
 * `IR_VERSION`'s contract (decision 204, lead ruling: +1 on every change a
 * reader of the IR can observe), checked (review 484 r4 B2). The pin is the
 * version together with a hash of the IR's type declarations: `ir.ts`,
 * `ir-entry/spans.ts` (`Spanned`/`SpannedIr`) and `SourceSpan`, printed
 * without comments so a comment or formatting edit does not trip it. A shape
 * change fails here until `IR_VERSION` goes up and the hash is re-pinned.
 *
 * A change of meaning with no change of shape (a field that now holds
 * something else) is not caught: that bump is still the author's call.
 */

const PINNED = {
  irVersion: 1,
  shape: "969e1cfccecef8677ed5a16353c874e9b189e2b76c40efaf718cfdb65e434c06",
};

/** Type-level declarations only: a function body in `spans.ts` is not shape. */
function declarations(file: string, only?: ReadonlySet<string>): string {
  const path = join(import.meta.dirname, "..", file);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter({ removeComments: true });
  return source.statements
    .filter(
      (statement) =>
        (ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        (!only || only.has(statement.name.text)),
    )
    .map((statement) =>
      printer.printNode(ts.EmitHint.Unspecified, statement, source),
    )
    .join("\n");
}

function shapeHash(): string {
  const text = [
    declarations("ir.ts"),
    declarations("ir-entry/spans.ts"),
    declarations("mapping.ts", new Set(["SourceSpan"])),
  ].join("\n");
  return createHash("sha256").update(text).digest("hex");
}

describe("IR_VERSION", () => {
  it("is exported from core's entry", () => {
    expect(core.IR_VERSION).toBe(PINNED.irVersion);
  });

  it("goes up with the IR's shape", () => {
    const actual = { irVersion: core.IR_VERSION, shape: shapeHash() };
    expect(
      actual,
      "IR shape changed: bump IR_VERSION and update the pinned hash in ir-version.test.ts",
    ).toEqual(PINNED);
  });

  it("ignores comments and formatting", () => {
    const path = "ir.ts";
    const plain = declarations(path);
    expect(plain).not.toMatch(/\/\*\*|\/\/ /);
    expect(plain).toContain("interface Ir");
  });
});

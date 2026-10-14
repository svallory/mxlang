/**
 * Quick fixes in tsserver: the `fixes` an MX diagnostic carries
 * (`IrDiagnostic.fixes`, `@unstable`), offered as `getCodeFixesAtPosition`
 * code fixes.
 *
 * A `ts.Diagnostic` has no slot for a fix, so the plugin keeps them on its own
 * diagnostic record ({@link MxCompileDiagnostic}) and answers the code-fix
 * request itself. The offsets of a fix are UTF-16 code units into the same
 * text as the diagnostic's own offset, which is the `.mx` file as the editor
 * holds it, so no position is mapped: they are tsserver's own text-span units.
 */

import type { IrDiagnosticFix } from "@mxlang/core";
import type * as ts from "typescript";
import type { MxCompileDiagnostic } from "./language.ts";

/**
 * The code a compile diagnostic is shown with: its own (`MX_*`, or a
 * dialect's) when it has one, else `80001` for an error and `80002` for a
 * warning.
 */
export function diagnosticCodeOf(
  diagnostic: Pick<MxCompileDiagnostic, "diagnosticCode" | "category">,
): string | number {
  return (
    diagnostic.diagnosticCode ??
    (diagnostic.category === "error" ? 80001 : 80002)
  );
}

/**
 * The fixes of `fixes` that can be applied to `length` UTF-16 units of text:
 * a title, at least one edit, and edits that are whole numbers, inside the
 * text and not overlapping each other. A fix that does not fit (a diagnostic
 * measured against an older text) is dropped, never applied somewhere else.
 */
export function applicableFixes(
  fixes: readonly IrDiagnosticFix[] | undefined,
  length: number,
): IrDiagnosticFix[] {
  return (fixes ?? []).filter((fix) => {
    if (typeof fix.title !== "string" || !Array.isArray(fix.edits)) {
      return false;
    }
    if (fix.edits.length === 0) return false;
    let previousEnd = -1;
    const edits = [...fix.edits].sort((a, b) => a.offset - b.offset);
    for (const edit of edits) {
      if (
        !Number.isInteger(edit.offset) ||
        !Number.isInteger(edit.end) ||
        typeof edit.newText !== "string" ||
        edit.offset < 0 ||
        edit.end < edit.offset ||
        edit.end > length ||
        edit.offset < previousEnd
      ) {
        return false;
      }
      previousEnd = edit.end;
    }
    return true;
  });
}

/**
 * Whether the requested `errorCodes` ask for `code`. A client that turns
 * every diagnostic code into a number sends `null` (JSON for `NaN`) for an
 * MX code, which is a name, so an entry that is not a finite number asks for
 * every MX diagnostic in the range.
 */
function asksFor(
  errorCodes: readonly (number | string)[],
  code: string | number,
): boolean {
  return errorCodes.some(
    (asked) =>
      (typeof asked !== "string" && !Number.isFinite(asked)) ||
      String(asked) === String(code),
  );
}

/**
 * The code fixes of the diagnostics whose range meets `start..end` and whose
 * code is asked for in `errorCodes`: one {@link ts.CodeFixAction} per
 * applicable fix, in the diagnostics' order. `fixName` is the diagnostic's
 * code, `description` the fix's title, and the one file change is the fix's
 * edits (against the original text, as TypeScript's own).
 *
 * A diagnostic's range meets the request when they share a position, so a
 * cursor at either end of the range still gets the fix.
 */
export function mxCodeFixes(
  diagnostics: readonly MxCompileDiagnostic[],
  start: number,
  end: number,
  errorCodes: readonly (number | string)[],
): ts.CodeFixAction[] {
  const actions: ts.CodeFixAction[] = [];
  for (const diagnostic of diagnostics) {
    const code = diagnosticCodeOf(diagnostic);
    if (!asksFor(errorCodes, code)) continue;
    const diagnosticEnd =
      diagnostic.offset +
      Math.max(
        0,
        Math.min(
          diagnostic.length ?? 1,
          diagnostic.source.length - diagnostic.offset,
        ),
      );
    if (start > diagnosticEnd || end < diagnostic.offset) continue;
    for (const fix of applicableFixes(
      diagnostic.fixes,
      diagnostic.source.length,
    )) {
      actions.push({
        fixName: String(code),
        description: fix.title,
        changes: [
          {
            fileName: diagnostic.fileName,
            textChanges: fix.edits.map((edit) => ({
              span: { start: edit.offset, length: edit.end - edit.offset },
              newText: edit.newText,
            })),
          },
        ],
      });
    }
  }
  return actions;
}

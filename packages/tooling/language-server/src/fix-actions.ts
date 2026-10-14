/**
 * Quick fixes: the `fixes` a diagnostic carries (`IrDiagnostic.fixes`,
 * `@unstable`), offered as code actions.
 *
 * `diagnoseDocument` puts a diagnostic's fixes in its `data.fixes` (UTF-16
 * offsets into the document it is published for); a client sends the
 * diagnostics back with a code-action request, and each fix becomes one
 * `quickfix` action whose workspace edit is the fix's edits, converted to
 * ranges against the document's own text.
 */

import type { IrDiagnosticFix } from "@mxlang/core";
import {
  type CodeAction,
  CodeActionKind,
  type Diagnostic,
  type TextEdit,
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

/** The fixes in a diagnostic's `data`, when it holds well-formed ones. */
function fixesOf(diagnostic: Diagnostic): readonly IrDiagnosticFix[] {
  const fixes = (diagnostic.data as { fixes?: unknown } | undefined)?.fixes;
  return Array.isArray(fixes) ? (fixes as IrDiagnosticFix[]) : [];
}

/** Whether `fix` can be applied to `length` units of text: whole numbers, in range, in order. */
function applicable(fix: IrDiagnosticFix, length: number): boolean {
  // A diagnostic's `data` comes from a client (or a dialect hook behind the
  // server) and is only as well-formed as it was sent: each level is checked
  // before it is read, so a malformed fix is dropped and never thrown on.
  const isObject = (value: unknown): boolean =>
    typeof value === "object" && value !== null;
  if (!isObject(fix) || typeof fix.title !== "string") return false;
  if (!Array.isArray(fix.edits) || fix.edits.length === 0) return false;
  if (!fix.edits.every(isObject)) return false;
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
}

/**
 * One `quickfix` code action per applicable fix of each diagnostic, in the
 * diagnostics' order. A fix whose edits do not fit the document (a diagnostic
 * measured against an older text) is dropped, never applied somewhere else.
 */
export function fixActions(
  document: TextDocument,
  diagnostics: readonly Diagnostic[],
): CodeAction[] {
  const length = document.getText().length;
  const actions: CodeAction[] = [];
  for (const diagnostic of diagnostics) {
    const fixes = fixesOf(diagnostic).filter((fix) => applicable(fix, length));
    for (const fix of fixes) {
      const edits: TextEdit[] = fix.edits.map((edit) => ({
        range: {
          start: document.positionAt(edit.offset),
          end: document.positionAt(edit.end),
        },
        newText: edit.newText,
      }));
      actions.push({
        title: fix.title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        // A diagnostic with one fix has an obvious one to apply.
        ...(fixes.length === 1 ? { isPreferred: true } : {}),
        edit: { changes: { [document.uri]: edits } },
      });
    }
  }
  return actions;
}

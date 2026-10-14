import type { MxCompileDiagnostic } from "@mxlang/typescript-plugin";

type Fixes = NonNullable<MxCompileDiagnostic["fixes"]>;

/** A 0-based line and column, as `SourceFile.getLineAndCharacterOfPosition` gives. */
export interface LineAndColumn {
  line: number;
  character: number;
}

/**
 * The lines `mx-tsc` prints under a diagnostic for the fixes it carries: one
 * line per fix, indented two spaces, with the fix's title and then its edits
 * separated by `; `.
 *
 *     page.mx(2,4): error MX_RESERVED_EFFECT_TAG: …
 *       fix: Rename to `<script>`: replace 2:4-2:10 with "script"; replace 2:17-2:23 with "script"
 *
 * Positions are `line:column`, 1-based like the `file(line,column)` of the
 * diagnostic above them; the end of a range is exclusive. The new text is
 * JSON-quoted, so a newline, a quote or a character outside the Basic
 * Multilingual Plane is printed exactly and the fix stays on one line. An edit
 * with an empty range is `insert at L:C "text"`, one with no new text is
 * `delete L:C-L:C`. Edits are in the order the fix lists them.
 *
 * The fixes must already be applicable (`applicableFixes`).
 */
export function formatFixLines(
  fixes: Fixes,
  position: (offset: number) => LineAndColumn,
): string {
  const at = (offset: number) => {
    const { line, character } = position(offset);
    return `${line + 1}:${character + 1}`;
  };
  return fixes
    .map((fix) => {
      const edits = fix.edits.map((edit) => {
        const text = JSON.stringify(edit.newText);
        if (edit.offset === edit.end)
          return `insert at ${at(edit.offset)} ${text}`;
        const range = `${at(edit.offset)}-${at(edit.end)}`;
        return edit.newText === ""
          ? `delete ${range}`
          : `replace ${range} with ${text}`;
      });
      return `  fix: ${fix.title}: ${edits.join("; ")}\n`;
    })
    .join("");
}

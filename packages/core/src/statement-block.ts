/**
 * The block form of a module statement: `static { … }` (and `server { … }`).
 *
 * Marko reads the text after the keyword as a module body, and when that body
 * is exactly one block statement the statements inside it are the module's:
 * the braces are gone, so `static { let q = 1 }` declares `q` at module scope
 * and the template reads it. A body of anything else (`static { a } { b }`,
 * `static { a } let b = 1`) keeps its block statements as written. The
 * module-scope name check and the lowering both go through this one reading,
 * so they agree on which statements are the module's own.
 */

import { parseAuthoredSource } from "./reserved-bindings.ts";

/** Where the braces of a statement's one block are, in the text it was read from. */
export interface StatementBlock {
  /** Offset of the opening `{`. */
  readonly open: number;
  /** Offset of the closing `}`. */
  readonly close: number;
  /** The block holds no statement (comments do not count). */
  readonly empty: boolean;
}

/**
 * `code` is a module body that is exactly one block statement: its braces, or
 * `undefined` for any other body and for text that does not parse (the
 * statement checks report that).
 */
export function statementBlock(code: string): StatementBlock | undefined {
  if (!code.trimStart().startsWith("{")) return undefined;
  try {
    const file = parseAuthoredSource(code, 1, 0, {
      allowReturnOutsideFunction: true,
      errorRecovery: true,
    });
    const [only, ...rest] = file.program.body;
    if (!only || rest.length > 0 || only.type !== "BlockStatement") {
      return undefined;
    }
    return {
      open: only.start as number,
      close: (only.end as number) - 1,
      empty: only.body.length === 0 && !only.directives?.length,
    };
  } catch {
    return undefined;
  }
}

/**
 * The module code a statement's text stands for: `code` itself, or, when it
 * is one block, the text between the braces, trimmed and otherwise verbatim
 * (comments between its statements stay, a comment after it goes with the
 * braces). `""` for a block with no statement, which declares and runs
 * nothing, as Marko drops it, comments and all.
 */
export function unwrapStatementBlock(code: string): string {
  const block = statementBlock(code);
  if (!block) return code;
  return block.empty ? "" : code.slice(block.open + 1, block.close).trim();
}

/**
 * `code` with the braces of its one block blanked, so the statements inside
 * read as module statements (where `import` and `export` may stand) while
 * every character keeps its position. `code` itself for any other body.
 */
export function blankStatementBlock(code: string): string {
  const block = statementBlock(code);
  if (!block) return code;
  return `${code.slice(0, block.open)} ${code.slice(block.open + 1, block.close)} ${code.slice(block.close + 1)}`;
}

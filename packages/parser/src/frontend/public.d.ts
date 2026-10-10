/**
 * Public types of `@mxlang/parser/frontend` as seen by other packages (the
 * `types` condition of the `./frontend` export).
 *
 * Consumers typecheck against this rather than against `index.ts`, because
 * the front end value-imports the vendored `@babel/parser` source in
 * `packages/babel`, which needs relaxed flags (`strictFunctionTypes`,
 * `noUncheckedIndexedAccess`) that should not leak into every program that
 * calls `parse`: `@mxlang/core` parses through it since port PR 5, and
 * several programs include core's source. `public-types.test.ts` pins this
 * file to the source.
 */
import type {
  MxBlockTag,
  MxBodyMode,
  MxDocument,
  MxFilter,
  MxFragmentBase,
  MxFrontEndOptions,
  MxStatementKeyword,
  MxTagShape,
  MxTrigger,
} from "@mxlang/babel/mx-ast";

export type {
  MxBlockTag,
  MxBodyMode,
  MxFilter,
  MxFragmentBase,
  MxFrontEndOptions,
  MxStatementKeyword,
  MxTagShape,
  MxTrigger,
};

/** Options of `parse` (ast §7.1, §5.3; decision 182). */
export interface ParseOptions extends MxFrontEndOptions {
  readonly base?: MxFragmentBase;
  /** The syntax table (`@mxlang/parser`'s `SyntaxTable`); omitted means `DEFAULT_SYNTAX`. */
  readonly syntax?: object;
  /** Tag types keyed by the full written static name: html 0, text 1, void 2, statement 3. */
  readonly tagTypes?: Readonly<Record<string, 0 | 1 | 2 | 3>>;
  /**
   * Asked once per matched attribute or line trigger, and once per
   * attribute `=value` a value row matches whole, in one parse attempt (a
   * restart for a missed tag name asks again), with the row's id, the
   * position, the file offsets of the matched text, the static name of the
   * tag in attribute and value position (else `null`) and the attribute's
   * name in value position (`null` for a default value, and in the other
   * positions). `undefined` declines: the text parses as if no row matched.
   * An object other than an `MxTrigger`-typed one is the node the tree
   * holds there: in value position, the attribute's `value`. Omitted, every
   * matched row claims.
   */
  readonly claim?: TriggerClaim;
}

/** The `claim` option of `parse`. */
export type TriggerClaim = (
  rowId: string,
  position: "attribute" | "line" | "value",
  start: number,
  end: number,
  tag: string | null,
  attribute: string | null,
) => object | undefined;

/** Builds the MX AST of `source` (ast §7). Parse errors are in the document's `errors`. */
export declare function parse(
  source: string,
  options: ParseOptions,
): MxDocument;

/** A file offset to a 1-based line and 0-based column, the fragment base applied (ast §5.2). */
export declare function lineColumnAt(
  document: { readonly source: string; readonly base: MxFragmentBase },
  offset: number,
): { line: number; column: number };

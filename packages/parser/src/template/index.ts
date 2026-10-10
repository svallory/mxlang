import {
  type ParseOptions,
  Parser,
  type TriggerClaim,
  type ParserOptions,
  type Range,
} from "./internal.ts";
import { compileSyntax, type SyntaxTable } from "./syntax.ts";
export {
  ErrorCode,
  getLines,
  getLocation,
  getPosition,
  type ParserOptions as Handlers,
  type Location,
  type ParseOptions,
  type Position,
  type Range,
  type Ranges,
  TagType,
  type TriggerClaim,
} from "./internal.ts";
export {
  DEFAULT_SYNTAX,
  type StandIn,
  type SyntaxDiagnostic,
  type SyntaxTable,
  type Trigger,
  type TriggerNode,
  validateSyntaxTable,
} from "./syntax.ts";
export { escapeText } from "./util/escape.ts";
export {
  isValidAttrValue,
  isValidScriptlet,
  isValidStatement,
  Validity,
} from "./util/validators.ts";

/** Options of `createParser`. */
export interface CreateParserOptions {
  /**
   * MX (decision 182): the syntax table this parser reads; omitted means
   * `DEFAULT_SYNTAX`, today's grammar. Throws a `TypeError` when the table
   * does not validate (`validateSyntaxTable`).
   */
  syntax?: SyntaxTable;
  /**
   * MX: asked when an attribute or line trigger's row matches, with the
   * row's id, the position and the matched text's range. `undefined`
   * declines: the text lexes as if no row matched. Anything else claims it
   * and reaches `onTrigger` as `claim`. Asked once per trigger start, however
   * often the text is re-lexed. Omitted means every match claims.
   */
  claim?: TriggerClaim;
}

/**
 * Creates a new Marko parser.
 */
export function createParser(
  handlers: ParserOptions,
  options?: CreateParserOptions,
) {
  // Expose a subset of the parser api.
  const parser = new Parser(
    handlers,
    options?.syntax ? compileSyntax(options.syntax) : undefined,
    options?.claim,
  );

  return {
    /**
     * Parses code and calls the provided handlers. When `options` gives a
     * base position, `positionAt`/`locationAt`/`offsetAt` report positions
     * rebased onto the enclosing document instead of `code` itself.
     */
    parse(code: string, options?: ParseOptions) {
      return parser.parse(code, options);
    },
    /**
     * Given an offset range in the current source code, reads and returns the substring in the input code.
     */
    read(range: Range) {
      return parser.read(range);
    },
    /**
     * Given a offset in the current source code, returns a Position object with line & character information.
     * When `parse` was given a base position, this is relative to the enclosing document rather than `code`.
     */
    positionAt(offset: number) {
      return parser.positionAt(offset);
    },
    /**
     * Given a offset range in the current source code, returns a Location object with a start & end position information.
     * When `parse` was given a base position, both ends are relative to the enclosing document; the range
     * passed in stays relative to `code`.
     */
    locationAt(range: Range) {
      return parser.locationAt(range);
    },
    /**
     * Given an offset in the current source code, returns that offset rebased
     * onto the enclosing document using `parse`'s base position. Use it to
     * turn a fragment-relative offset (a handler's range, a `node.start` into
     * `offsetAt`) into a document-absolute one; without a base position it is
     * the identity.
     */
    offsetAt(offset: number) {
      return parser.offsetAt(offset);
    },
  };
}

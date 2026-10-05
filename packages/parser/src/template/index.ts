import {
  type ParseOptions,
  Parser,
  type ParserOptions,
  type Range,
} from "./internal.ts";
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
} from "./internal.ts";
export { escapeText } from "./util/escape.ts";
export {
  isValidAttrValue,
  isValidScriptlet,
  isValidStatement,
  Validity,
} from "./util/validators.ts";

/**
 * Creates a new Marko parser.
 */
export function createParser(handlers: ParserOptions) {
  // Expose a subset of the parser api.
  const parser = new Parser(handlers);

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
     */
    positionAt(offset: number) {
      return parser.positionAt(offset);
    },
    /**
     * Given a offset range in the current source code, returns a Location object with a start & end position information.
     */
    locationAt(range: Range) {
      return parser.locationAt(range);
    },
    /**
     * Given an offset in the current source code, returns that offset rebased
     * onto the enclosing document using `parse`'s base position.
     */
    offsetAt(offset: number) {
      return parser.offsetAt(offset);
    },
  };
}

/**
 * The MX front end (PR 3 of the parser port): the package's second entry
 * point, beside the template parser. `parse` builds the MX AST of
 * `apps/docs/docs/architecture/ast.md`; the option types are re-exported
 * from `@mxlang/babel/mx-ast`, where the AST's types live.
 */

/**
 * The vendored `@babel/parser` entry points, unchanged: without the `mx`
 * option they behave exactly like npm `@babel/parser` 7.29.8, with the
 * fork's bounded block-comment line count. Core parses through these, so
 * its typecheck never reads the fork's source (see `public.d.ts`).
 */
export {
  parse as parseBabel,
  parseExpression as parseBabelExpression,
} from "@mxlang/babel";
export type {
  MxBodyMode,
  MxFragmentBase,
  MxFrontEndOptions,
  MxStatementKeyword,
  MxTagShape,
} from "@mxlang/babel/mx-ast";
export { lineColumnAt } from "./line-column.ts";
export {
  type MxBlockTag,
  type MxFilter,
  type MxTrigger,
  type ParseOptions,
  parse,
  type TriggerClaim,
} from "./parse.ts";

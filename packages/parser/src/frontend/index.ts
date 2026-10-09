/**
 * The MX front end (PR 3 of the parser port; decision 166 addendum 1): the
 * package's second entry point, beside the template parser. `parse` builds
 * the MX AST of `apps/docs/docs/architecture/ast.md`; the option types are
 * re-exported from `@mxlang/babel/mx-ast`, where the AST's types live.
 */
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
} from "./parse.ts";

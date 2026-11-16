/**
 * Public types of `@mxlang/parser/frontend/babel` as seen by other packages
 * (the `types` condition of the `./frontend/babel` export).
 *
 * Consumers typecheck against this rather than against `babel.ts`, because
 * `babel.ts` re-exports the vendored `@babel/parser` source in
 * `packages/babel`, which needs relaxed flags (`strictFunctionTypes`,
 * `noUncheckedIndexedAccess`) that should not leak into every program that
 * parses through it: `@mxlang/core`'s `coreParser()` does, and several
 * programs include core's source. The nodes are untyped (`object`) so no
 * `@babel/*` or `@mxlang/babel` type reaches a consumer's declarations.
 * `public-types.test.ts` pins this file to the source.
 */
export declare function parseBabel(input: string, options?: object): object;
export declare function parseBabelExpression(
  input: string,
  options?: object,
): object;
